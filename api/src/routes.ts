export type Route =
    | { readonly kind: 'createProject' }
    | { readonly kind: 'listProjects' }
    | { readonly kind: 'queueDeployment'; readonly projectId: string }
    | { readonly kind: 'listProjectDeployments'; readonly projectId: string }
    | { readonly kind: 'listRecentDeployments' }
    | { readonly kind: 'showDeployment'; readonly deploymentId: string }
    | { readonly kind: 'listDeploymentLogs'; readonly deploymentId: string }
    | { readonly kind: 'streamDeploymentLogs'; readonly deploymentId: string }
    | { readonly kind: 'listAliases' }
    | { readonly kind: 'pointAlias'; readonly hostname: string }
    | { readonly kind: 'removeAlias'; readonly hostname: string }
    | { readonly kind: 'receiveGithubPush'; readonly projectId: string }
    | { readonly kind: 'dashboard' }
    | { readonly kind: 'noRoute' }

const noRoute: Route = { kind: 'noRoute' }

export function routeOf(method: string, url: string): Route {
    const segments = new URL(url, 'http://localhost').pathname
        .split('/')
        .filter((segment) => segment.length > 0)
    const [first, second, third, fourth] = segments

    if (first === undefined) {
        return method === 'GET' ? { kind: 'dashboard' } : noRoute
    }

    if (first === 'projects') {
        if (second === undefined) {
            if (method === 'POST') return { kind: 'createProject' }
            if (method === 'GET') return { kind: 'listProjects' }
            return noRoute
        }
        if (third === 'deployments' && fourth === undefined) {
            if (method === 'POST') return { kind: 'queueDeployment', projectId: second }
            if (method === 'GET') return { kind: 'listProjectDeployments', projectId: second }
        }
        return noRoute
    }

    if (first === 'deployments') {
        if (second === undefined) {
            return method === 'GET' ? { kind: 'listRecentDeployments' } : noRoute
        }
        if (method !== 'GET') return noRoute
        if (third === undefined) return { kind: 'showDeployment', deploymentId: second }
        if (third === 'logs' && fourth === undefined) {
            return { kind: 'listDeploymentLogs', deploymentId: second }
        }
        if (third === 'logs' && fourth === 'stream' && segments.length === 4) {
            return { kind: 'streamDeploymentLogs', deploymentId: second }
        }
        return noRoute
    }

    if (first === 'aliases') {
        if (second === undefined) {
            return method === 'GET' ? { kind: 'listAliases' } : noRoute
        }
        if (third === undefined) {
            if (method === 'PUT') return { kind: 'pointAlias', hostname: second }
            if (method === 'DELETE') return { kind: 'removeAlias', hostname: second }
        }
        return noRoute
    }

    if (first === 'webhooks' && second === 'github' && third !== undefined && fourth === undefined) {
        if (method === 'POST') return { kind: 'receiveGithubPush', projectId: third }
    }

    return noRoute
}
