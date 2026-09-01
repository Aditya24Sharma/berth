import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '#shared/db.ts'
import { insertQueuedDeployment, loadDeployment } from '#shared/deployments.ts'
import { parseJsonBody, readBody, sendError, sendJson } from './http.ts'
import { newDeploymentId, newProjectId, parseDeploymentId, parseProjectId } from '#shared/ids.ts'
import { insertProject, loadProject, loadProjects, parseCreateProjectBody } from '#shared/projects.ts'
import { routeOf } from './routes.ts'

function berthDataDir(): string {
    return process.env.BERTH_DATA_DIR ?? join(homedir(), '.berth')
}

const databasePath = join(berthDataDir(), 'berth.db')
const db = openDatabase(databasePath)
const port = Number(process.env.PORT ?? 4000)

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
    const projectId = parseProjectId(rawProjectId)
    if (projectId === null) {
        sendError(res, 404, 'no such project')
        return
    }

    const project = loadProject(db, projectId)
    if (project === null) {
        sendError(res, 404, 'no such project')
        return
    }
    if (!project.ok) {
        sendError(res, 500, project.error)
        return
    }

    const id = newDeploymentId()
    insertQueuedDeployment(db, id, project.value.id)
    sendJson(res, 202, { id, status: 'queued' })
}

function showDeployment(res: ServerResponse, rawId: string): void {
    const id = parseDeploymentId(rawId)
    if (id === null) {
        sendError(res, 404, 'no such deployment')
        return
    }

    const deployment = loadDeployment(db, id)
    if (deployment === null) {
        sendError(res, 404, 'no such deployment')
        return
    }
    if (!deployment.ok) {
        sendError(res, 500, deployment.error)
        return
    }

    sendJson(res, 200, deployment.value)
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
        case 'showDeployment':
            showDeployment(res, route.deploymentId)
            return
        default:
            sendError(res, 404, 'no such route')
    }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
        await dispatch(req, res)
    } catch (cause) {
        console.error(cause)
        sendError(res, 500, 'internal error')
    }
}

createServer((req, res) => {
    void handle(req, res)
}).listen(port, () => {
    console.log(`berth api listening on http://localhost:${port}`)
    console.log(`database at ${databasePath}`)
})
