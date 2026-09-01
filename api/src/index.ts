import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '#shared/db.ts'
import type { Deployment } from '#shared/deployments.ts'
import {
    insertQueuedDeployment,
    loadDeployment,
    loadProjectDeployments,
    loadRecentDeployments,
} from '#shared/deployments.ts'
import { deleteAlias, loadAliases, parseAliasHostname, parsePointAliasBody, pointAliasAt } from '#shared/aliases.ts'
import { loadLogLinesAfter } from '#shared/logs.ts'
import { parseJsonBody, readBody, sendError, sendJson } from './http.ts'
import { newDeploymentId, newProjectId, parseDeploymentId, parseProjectId } from '#shared/ids.ts'
import type { Project } from '#shared/projects.ts'
import { insertProject, loadProject, loadProjects, parseCreateProjectBody } from '#shared/projects.ts'
import { lastEventId, openEventStream } from './sse.ts'
import { streamDeploymentLogs } from './logstream.ts'
import { routeOf } from './routes.ts'

function berthDataDir(): string {
    return process.env.BERTH_DATA_DIR ?? join(homedir(), '.berth')
}

const databasePath = join(berthDataDir(), 'berth.db')
const db = openDatabase(databasePath)
const port = Number(process.env.PORT ?? 4000)

const dashboardPath = join(import.meta.dirname, '..', 'public', 'dashboard.html')

const PROJECT_DEPLOYMENTS_LIMIT = 100
const RECENT_DEPLOYMENTS_LIMIT = 50
const LOG_LINES_LIMIT = 10_000
const LOG_STREAM_POLL_INTERVAL_MS = 500
const LOG_STREAM_BATCH_LIMIT = 200

function loadProjectOrSendError(res: ServerResponse, rawProjectId: string): Project | null {
    const id = parseProjectId(rawProjectId)
    if (id === null) {
        sendError(res, 404, 'no such project')
        return null
    }

    const project = loadProject(db, id)
    if (project === null) {
        sendError(res, 404, 'no such project')
        return null
    }
    if (!project.ok) {
        sendError(res, 500, project.error)
        return null
    }

    return project.value
}

function loadDeploymentOrSendError(res: ServerResponse, rawId: string): Deployment | null {
    const id = parseDeploymentId(rawId)
    if (id === null) {
        sendError(res, 404, 'no such deployment')
        return null
    }

    const deployment = loadDeployment(db, id)
    if (deployment === null) {
        sendError(res, 404, 'no such deployment')
        return null
    }
    if (!deployment.ok) {
        sendError(res, 500, deployment.error)
        return null
    }

    return deployment.value
}

async function createProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req)
    if (!raw.ok) {
        sendError(res, 400, raw.error)
        return
    }

    const json = parseJsonBody(raw.value)
    if (!json.ok) {
        sendError(res, 400, json.error)
        return
    }

    const body = parseCreateProjectBody(json.value)
    if (!body.ok) {
        sendError(res, 400, body.error)
        return
    }

    const id = newProjectId()
    insertProject(db, id, body.value)
    sendJson(res, 201, { id })
}

function listProjects(res: ServerResponse): void {
    const projects = loadProjects(db)
    if (!projects.ok) {
        sendError(res, 500, projects.error)
        return
    }
    sendJson(res, 200, projects.value)
}

function queueDeployment(res: ServerResponse, rawProjectId: string): void {
    const project = loadProjectOrSendError(res, rawProjectId)
    if (project === null) return

    const id = newDeploymentId()
    insertQueuedDeployment(db, id, project.id)
    sendJson(res, 202, { id, status: 'queued' })
}

function listProjectDeployments(res: ServerResponse, rawProjectId: string): void {
    const project = loadProjectOrSendError(res, rawProjectId)
    if (project === null) return

    const deployments = loadProjectDeployments(db, project.id, PROJECT_DEPLOYMENTS_LIMIT)
    if (!deployments.ok) {
        sendError(res, 500, deployments.error)
        return
    }

    sendJson(res, 200, deployments.value)
}

function listRecentDeployments(res: ServerResponse): void {
    const deployments = loadRecentDeployments(db, RECENT_DEPLOYMENTS_LIMIT)
    if (!deployments.ok) {
        sendError(res, 500, deployments.error)
        return
    }

    sendJson(res, 200, deployments.value)
}

function showDeployment(res: ServerResponse, rawId: string): void {
    const deployment = loadDeploymentOrSendError(res, rawId)
    if (deployment === null) return

    sendJson(res, 200, deployment)
}

function listDeploymentLogs(res: ServerResponse, rawId: string): void {
    const deployment = loadDeploymentOrSendError(res, rawId)
    if (deployment === null) return

    const lines = loadLogLinesAfter(db, deployment.id, 0, LOG_LINES_LIMIT)
    if (!lines.ok) {
        sendError(res, 500, lines.error)
        return
    }

    sendJson(res, 200, lines.value)
}

function openDeploymentLogStream(req: IncomingMessage, res: ServerResponse, rawId: string): void {
    const deployment = loadDeploymentOrSendError(res, rawId)
    if (deployment === null) return

    openEventStream(res)
    const stream = streamDeploymentLogs(db, res, deployment.id, {
        pollIntervalMs: LOG_STREAM_POLL_INTERVAL_MS,
        batchLimit: LOG_STREAM_BATCH_LIMIT,
        fromSeq: lastEventId(req),
    })
    res.on('close', () => stream.close())
}

function listAliases(res: ServerResponse): void {
    const aliases = loadAliases(db)
    if (!aliases.ok) {
        sendError(res, 500, aliases.error)
        return
    }

    sendJson(res, 200, aliases.value)
}

// A deployment that is not ready is refused with 409 rather than 422: the request is
// well formed and names a deployment that exists, and the same request succeeds once the
// build finishes. 422 would claim the body itself can never be processed.
async function pointAlias(req: IncomingMessage, res: ServerResponse, rawHostname: string): Promise<void> {
    const hostname = parseAliasHostname(rawHostname)
    if (!hostname.ok) {
        sendError(res, 400, hostname.error)
        return
    }

    const raw = await readBody(req)
    if (!raw.ok) {
        sendError(res, 400, raw.error)
        return
    }

    const json = parseJsonBody(raw.value)
    if (!json.ok) {
        sendError(res, 400, json.error)
        return
    }

    const body = parsePointAliasBody(json.value)
    if (!body.ok) {
        sendError(res, 400, body.error)
        return
    }

    const deployment = loadDeploymentOrSendError(res, body.value.deploymentId)
    if (deployment === null) return

    if (deployment.status !== 'ready') {
        sendError(res, 409, `deployment is ${deployment.status}, not ready`)
        return
    }

    if (pointAliasAt(db, hostname.value, deployment) === 'deploymentNotFound') {
        sendError(res, 409, 'deployment is no longer available')
        return
    }

    sendJson(res, 200, { hostname: hostname.value, deploymentId: deployment.id })
}

function removeAlias(res: ServerResponse, rawHostname: string): void {
    const hostname = parseAliasHostname(rawHostname)
    if (!hostname.ok) {
        sendError(res, 400, hostname.error)
        return
    }

    if (deleteAlias(db, hostname.value) === 'notFound') {
        sendError(res, 404, 'no such alias')
        return
    }

    res.writeHead(204)
    res.end()
}

async function sendDashboard(res: ServerResponse): Promise<void> {
    let html: Buffer
    try {
        html = await readFile(dashboardPath)
    } catch (cause) {
        console.error(cause)
        sendError(res, 500, 'dashboard is missing')
        return
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = routeOf(req.method ?? 'GET', req.url ?? '/')

    switch (route.kind) {
        case 'createProject':
            await createProject(req, res)
            return
        case 'listProjects':
            listProjects(res)
            return
        case 'queueDeployment':
            queueDeployment(res, route.projectId)
            return
        case 'listProjectDeployments':
            listProjectDeployments(res, route.projectId)
            return
        case 'listRecentDeployments':
            listRecentDeployments(res)
            return
        case 'showDeployment':
            showDeployment(res, route.deploymentId)
            return
        case 'listDeploymentLogs':
            listDeploymentLogs(res, route.deploymentId)
            return
        case 'streamDeploymentLogs':
            openDeploymentLogStream(req, res, route.deploymentId)
            return
        case 'listAliases':
            listAliases(res)
            return
        case 'pointAlias':
            await pointAlias(req, res, route.hostname)
            return
        case 'removeAlias':
            removeAlias(res, route.hostname)
            return
        case 'dashboard':
            await sendDashboard(res)
            return
        default:
            sendError(res, 404, 'no such route')
    }
}

async function serveRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
        await dispatch(req, res)
    } catch (cause) {
        console.error(cause)
        sendError(res, 500, 'internal error')
    }
}

createServer((req, res) => {
    void serveRequest(req, res)
}).listen(port, () => {
    console.log(`berth api listening on http://localhost:${port}`)
    console.log(`database at ${databasePath}`)
})
