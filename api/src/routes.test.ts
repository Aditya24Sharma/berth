import { deepStrictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { routeOf, type Route } from './routes.ts'

type RouteCase = {
    readonly method: string
    readonly url: string
    readonly route: Route
}

const PROJECT = 'prj_0123456789ab'
const DEPLOYMENT = 'dpl_0123456789ab'
const noRoute: Route = { kind: 'noRoute' }

const matches: readonly RouteCase[] = [
    { method: 'POST', url: '/projects', route: { kind: 'createProject' } },
    { method: 'GET', url: '/projects', route: { kind: 'listProjects' } },
    {
        method: 'POST',
        url: `/projects/${PROJECT}/deployments`,
        route: { kind: 'queueDeployment', projectId: PROJECT },
    },
    {
        method: 'GET',
        url: `/projects/${PROJECT}/deployments`,
        route: { kind: 'listProjectDeployments', projectId: PROJECT },
    },
    { method: 'GET', url: '/deployments', route: { kind: 'listRecentDeployments' } },
    {
        method: 'GET',
        url: `/deployments/${DEPLOYMENT}`,
        route: { kind: 'showDeployment', deploymentId: DEPLOYMENT },
    },
    {
        method: 'GET',
        url: `/deployments/${DEPLOYMENT}/logs`,
        route: { kind: 'listDeploymentLogs', deploymentId: DEPLOYMENT },
    },
    {
        method: 'GET',
        url: `/deployments/${DEPLOYMENT}/logs/stream`,
        route: { kind: 'streamDeploymentLogs', deploymentId: DEPLOYMENT },
    },
    { method: 'GET', url: '/aliases', route: { kind: 'listAliases' } },
    {
        method: 'PUT',
        url: '/aliases/myapp.localhost',
        route: { kind: 'pointAlias', hostname: 'myapp.localhost' },
    },
    {
        method: 'DELETE',
        url: '/aliases/myapp.localhost',
        route: { kind: 'removeAlias', hostname: 'myapp.localhost' },
    },
    {
        method: 'POST',
        url: `/webhooks/github/${PROJECT}`,
        route: { kind: 'receiveGithubPush', projectId: PROJECT },
    },
    { method: 'GET', url: '/', route: { kind: 'dashboard' } },
    { method: 'GET', url: '/dashboard.html', route: { kind: 'dashboard' } },
]

const normalisations: readonly RouteCase[] = [
    { method: 'GET', url: '/projects/', route: { kind: 'listProjects' } },
    { method: 'GET', url: '/projects?limit=2', route: { kind: 'listProjects' } },
    { method: 'GET', url: '/dashboard.html?v=2', route: { kind: 'dashboard' } },
    { method: 'GET', url: '/aliases/', route: { kind: 'listAliases' } },
    {
        method: 'GET',
        url: `/deployments/${DEPLOYMENT}/logs/`,
        route: { kind: 'listDeploymentLogs', deploymentId: DEPLOYMENT },
    },
    {
        method: 'GET',
        url: `/deployments/${DEPLOYMENT}/logs/stream/`,
        route: { kind: 'streamDeploymentLogs', deploymentId: DEPLOYMENT },
    },
]

const nearMisses: readonly RouteCase[] = [
    { method: 'GET', url: `/deployments/${DEPLOYMENT}/logs/stream/extra`, route: noRoute },
    { method: 'GET', url: `/deployments/${DEPLOYMENT}/logs/tail`, route: noRoute },
    { method: 'GET', url: `/deployments/${DEPLOYMENT}/logs/stream/stream`, route: noRoute },
    { method: 'GET', url: `/deployments/${DEPLOYMENT}/artifacts`, route: noRoute },
    { method: 'GET', url: `/projects/${PROJECT}/deployments/extra`, route: noRoute },
    { method: 'GET', url: `/projects/${PROJECT}`, route: noRoute },
    { method: 'PUT', url: '/aliases', route: noRoute },
    { method: 'PUT', url: '/aliases/', route: noRoute },
    { method: 'DELETE', url: '/aliases', route: noRoute },
    { method: 'DELETE', url: '/aliases/', route: noRoute },
    { method: 'PUT', url: '/aliases/myapp.localhost/target', route: noRoute },
    { method: 'GET', url: '/webhooks/github', route: noRoute },
    { method: 'POST', url: `/webhooks/github/${PROJECT}/extra`, route: noRoute },
    { method: 'GET', url: '/dashboard.html/extra', route: noRoute },
    { method: 'GET', url: '/dashboard', route: noRoute },
    { method: 'GET', url: '/favicon.ico', route: noRoute },
]

const wrongMethods: readonly RouteCase[] = [
    { method: 'DELETE', url: '/projects', route: noRoute },
    { method: 'PUT', url: `/projects/${PROJECT}/deployments`, route: noRoute },
    { method: 'POST', url: '/deployments', route: noRoute },
    { method: 'DELETE', url: `/deployments/${DEPLOYMENT}`, route: noRoute },
    { method: 'POST', url: `/deployments/${DEPLOYMENT}/logs`, route: noRoute },
    { method: 'DELETE', url: `/deployments/${DEPLOYMENT}/logs/stream`, route: noRoute },
    { method: 'POST', url: '/aliases', route: noRoute },
    { method: 'GET', url: '/aliases/myapp.localhost', route: noRoute },
    { method: 'PATCH', url: '/aliases/myapp.localhost', route: noRoute },
    { method: 'GET', url: `/webhooks/github/${PROJECT}`, route: noRoute },
    { method: 'POST', url: '/', route: noRoute },
    { method: 'PUT', url: '/dashboard.html', route: noRoute },
    { method: 'get', url: '/projects', route: noRoute },
]

for (const group of [matches, normalisations, nearMisses, wrongMethods]) {
    for (const { method, url, route } of group) {
        test(`${method} ${url}`, () => {
            deepStrictEqual(routeOf(method, url), route)
        })
    }
}

test('a hostname keeps the case it was written in', () => {
    deepStrictEqual(routeOf('PUT', '/aliases/MyApp.localhost'), {
        kind: 'pointAlias',
        hostname: 'MyApp.localhost',
    })
})

test('a percent-encoded hostname stays encoded for the handler to reject', () => {
    deepStrictEqual(routeOf('DELETE', '/aliases/my%2Dapp.localhost'), {
        kind: 'removeAlias',
        hostname: 'my%2Dapp.localhost',
    })
})
