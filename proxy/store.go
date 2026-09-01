package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"

	_ "modernc.org/sqlite"
)

var ErrHostnameUnknown = errors.New("hostname does not name a ready deployment")

type DeploymentStore struct {
	db *sql.DB
}

// The proxy is the data plane, so mode=ro is what stops a bug here from corrupting
// control-plane state. OmitHost keeps a relative path a path rather than an authority.
func readOnlyDSN(databasePath string) string {
	dsn := url.URL{
		Scheme:   "file",
		OmitHost: true,
		Path:     databasePath,
		RawQuery: "mode=ro&_pragma=busy_timeout(5000)",
	}
	return dsn.String()
}

func OpenDeploymentStore(databasePath string) (*DeploymentStore, error) {
	// mode=ro will not create a missing database, so without this check the proxy
	// would start and answer every request with a 404 it cannot explain.
	if _, err := os.Stat(databasePath); err != nil {
		return nil, fmt.Errorf("no berth database at %s, start the api which creates it: %w", databasePath, err)
	}

	db, err := sql.Open("sqlite", readOnlyDSN(databasePath))
	if err != nil {
		return nil, fmt.Errorf("open the berth database at %s read-only: %w", databasePath, err)
	}

	// sql.Open never touches the file, so an unreadable database surfaces only here.
	if err := db.PingContext(context.Background()); err != nil {
		opened := fmt.Errorf("open the berth database at %s read-only: %w", databasePath, err)
		return nil, errors.Join(opened, db.Close())
	}

	return &DeploymentStore{db: db}, nil
}

func (s *DeploymentStore) Close() error {
	if err := s.db.Close(); err != nil {
		return fmt.Errorf("close the berth database: %w", err)
	}
	return nil
}

const readyDeploymentByID = `
SELECT id
  FROM deployments
 WHERE id = ? AND status = 'ready'`

const readyDeploymentByAlias = `
SELECT d.id
  FROM aliases a
  JOIN deployments d ON d.id = a.deployment_id
 WHERE a.hostname = ? AND d.status = 'ready'`

func (s *DeploymentStore) ResolveHostname(ctx context.Context, hostname Hostname) (DeploymentID, error) {
	// The api refuses to create an alias whose first label parses as a deployment id,
	// so the two namespaces cannot collide and neither form falls through to the other.
	query, key := readyDeploymentByAlias, string(hostname)
	if direct, isDirect := ParseDeploymentID(FirstLabel(hostname)); isDirect {
		query, key = readyDeploymentByID, string(direct)
	}

	var stored string
	err := s.db.QueryRowContext(ctx, query, key).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("%w: %s", ErrHostnameUnknown, hostname)
	}
	if err != nil {
		return "", fmt.Errorf("resolve %s against the berth database: %w", hostname, err)
	}

	// deployments.id is plain TEXT, and the value becomes a path segment. A row that
	// is not a deployment id is control-plane corruption, not an unknown hostname.
	id, isWellFormed := ParseDeploymentID(stored)
	if !isWellFormed {
		return "", fmt.Errorf("resolve %s against the berth database: %q is not a deployment id", hostname, stored)
	}
	return id, nil
}
