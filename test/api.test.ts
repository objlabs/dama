import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { ProjectInput, ProjectView, McpServer, ServiceInput, Service, Snapshot, DeploymentPlan, BuildJob } from '../src/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createStore } from '../src/store.js';
import { createApp } from '../src/server.js';

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dama-test-'));
  const database = join(dir, 'test.sqlite');
  const store = createStore(database);
  const server = createApp(store);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); });
  async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as T };
  }
  return { store, api, base, database };
}
const project: ProjectInput = { name: 'website', kind: 'app', repository: 'https://github.com/example/app', branch: 'main', domain: 'app.example.com' };
const mcp = { name: 'logs', source: 'external', transport: 'streamable-http', endpoint: 'https://mcp.example.com/mcp', credentialRef: 'env:LOG_TOKEN' };

test('register projects and MCPs, bind, audit, reject duplicates, cascade connections', async t => {
  const { api } = await setup(t);
  const p = await api<ProjectView>('/api/projects', 'POST', project); assert.equal(p.status, 201);
  assert.equal(p.body.defaultUrl, '');
  assert.equal((await api<ProjectView>('/api/projects', 'POST', { ...project, name: 'WEBSITE', domain: '' })).status, 409);
  assert.equal((await api<ProjectView>('/api/projects', 'POST', { ...project, name: 'other' })).status, 409);
  const m = await api<McpServer>('/api/mcps', 'POST', mcp); assert.equal(m.status, 201); assert.equal(m.body.status, 'unverified');
  const b = { mcpId: m.body.id, policy: 'read-only' };
  assert.equal((await api(`/api/projects/${p.body.id}/bindings`, 'POST', b)).status, 201);
  assert.equal((await api(`/api/projects/${p.body.id}/bindings`, 'POST', b)).status, 409);
  let snapshot = (await api<Snapshot>('/api/state')).body;
  assert.equal(snapshot.projects[0].basePath, `/${p.body.id}`);
  assert.equal(snapshot.bindings.length, 1); assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.capabilities.deployment, false);
  assert.equal((await api(`/api/mcps/${m.body.id}`, 'DELETE')).status, 200);
  snapshot = (await api<Snapshot>('/api/state')).body;
  assert.equal(snapshot.bindings.length, 0); assert.equal(snapshot.projects.length, 1);
});

test('managed MCP requires an existing MCP project and protects its parent from deletion', async t => {
  const { api } = await setup(t);
  const p = (await api<ProjectView>('/api/projects', 'POST', project)).body;
  const managed = { ...mcp, source: 'managed', projectId: p.id };
  assert.equal((await api<McpServer>('/api/mcps', 'POST', managed)).status, 400);
  assert.equal((await api<McpServer>('/api/mcps', 'POST', { ...managed, projectId: 'missing' })).status, 404);
  const host = (await api<ProjectView>('/api/projects', 'POST', { ...project, name: 'mcp-host', kind: 'mcp', domain: '' })).body;
  const m = await api<McpServer>('/api/mcps', 'POST', { ...managed, projectId: host.id }); assert.equal(m.status, 201);
  assert.equal((await api(`/api/projects/${host.id}`, 'DELETE')).status, 409);
  await api(`/api/mcps/${m.body.id}`, 'DELETE');
  assert.equal((await api(`/api/projects/${host.id}`, 'DELETE')).status, 200);
});

test('reject bad input, credential-bearing URLs, raw secrets and invalid policies', async t => {
  const { api, base } = await setup(t);
  for (const endpoint of ['file:///etc/passwd', 'https://user:password@example.com/mcp', 'https://example.com/mcp?token=secret']) {
    assert.equal((await api<McpServer>('/api/mcps', 'POST', { ...mcp, endpoint })).status, 400);
  }
  assert.equal((await api<McpServer>('/api/mcps', 'POST', { ...mcp, credentialRef: 'sk-secret' })).status, 400);
  assert.equal((await api<McpServer>('/api/mcps', 'POST', { ...mcp, transport: 'stdio' })).status, 400);
  assert.equal((await api<ProjectView>('/api/projects', 'POST', { ...project, domain: 'https://example.com' })).status, 400);
  assert.equal((await api<ProjectView>('/api/projects', 'POST', { ...project, name: '' })).status, 400);
  assert.equal((await api<ProjectView>('/api/projects', 'POST', null)).status, 415);
  const malformed = await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await api<ProjectView>('/api/projects', 'POST', { ...project, name: 'a'.repeat(17_000) }); assert.equal(oversized.status, 413);
  assert.equal((await api('/api/projects/missing/bindings', 'POST', { mcpId: 'missing', policy: 'admin' })).status, 400);
  assert.equal((await api('/api/projects/missing/bindings', 'POST', { mcpId: 'missing', policy: 'read-only' })).status, 404);
});

test('block cross-origin writes and rebinding; expose only allowlisted static files', async t => {
  const { base, api } = await setup(t);
  const cross = await fetch(base + '/api/projects', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(project) });
  assert.equal(cross.status, 403);
  // fetch may replace Host; use a raw HTTP request to exercise the actual header.
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/api/state', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await api('/src/server.js')).status, 404);
  const home = await fetch(base); assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const html = await home.text();
  assert.match(html, /Dama/);
  assert.match(html, /type="module" src="\/app.js"/);
  const bundle = await fetch(base + '/app.js');
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
  const browserCode = await bundle.text();
  assert.match(browserCode, /function openEditor/);
  assert.doesNotMatch(browserCode, /import type|interface Snapshot/);
  assert.equal((await fetch(base + '/style.css')).status, 200);
  assert.equal((await api<Snapshot>('/api/state')).body.projects.length, 0);
});

test('registrations and audit survive database reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dama-persist-'));
  const path = join(dir, 'test.sqlite');
  let store;
  try {
    store = createStore(path); const p = store.createProject(project); store.close();
    store = createStore(path);
    assert.equal(store.snapshot().projects[0].id, p.id);
    assert.equal(store.snapshot().events[0].action, 'project.created');
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

const service: ServiceInput = {
  name: 'api', kind: 'app', language: 'python', sourcePath: 'apps/api',
  dockerfile: 'apps/api/Dockerfile', buildContext: '.', containerPort: 8000,
  routeSegment: 'api', healthPath: '/health', watchPaths: ['apps/api/**', 'packages/shared/**']
};

test('queue fixed commits, reject duplicates, persist FIFO order, and cancel waiting jobs', async t => {
  const { api, database } = await setup(t);
  const p = (await api<ProjectView>('/api/projects', 'POST', project)).body;
  const s = (await api<Service>(`/api/projects/${p.id}/services`, 'POST', service)).body;
  const path = `/api/services/${s.id}/build-jobs`;
  assert.equal((await api(path, 'POST', { commitSha: 'main' })).status, 400);
  const firstSha = 'a'.repeat(40);
  const attempts = await Promise.all([
    api<BuildJob>(path, 'POST', { commitSha: firstSha }),
    api<BuildJob>(path, 'POST', { commitSha: firstSha.toUpperCase() })
  ]);
  assert.deepEqual(attempts.map(attempt => attempt.status).sort(), [201, 409]);
  const first = attempts.find(attempt => attempt.status === 201)!.body;
  const second = await api<BuildJob>(path, 'POST', { commitSha: 'b'.repeat(40) });
  assert.equal(second.status, 201);
  assert.equal(first.commitSha, firstSha);
  assert.equal(first.source.repository, project.repository);
  assert.ok(first.build.argv.includes(service.dockerfile));
  const reopened = createStore(database);
  try { assert.deepEqual(reopened.snapshot().buildJobs.map(job => job.id), [first.id, second.body.id]); }
  finally { reopened.close(); }
  assert.equal((await api(`/api/build-jobs/${first.id}`, 'DELETE')).status, 200);
  assert.equal((await api(`/api/build-jobs/${first.id}`, 'DELETE')).status, 404);
  assert.equal((await api(path, 'POST', { commitSha: firstSha })).status, 201);
  assert.equal((await api(`/api/services/${s.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await api<Snapshot>('/api/state')).body.buildJobs, []);
});

test('monorepo services share a repository and container ports but own their route and build config', async t => {
  const { api } = await setup(t);
  const p = (await api<ProjectView>('/api/projects', 'POST', project)).body;
  const python = await api<Service>(`/api/projects/${p.id}/services`, 'POST', service);
  assert.equal(python.status, 201);
  assert.equal(python.body.defaultUrl, '');
  const rust = await api<Service>(`/api/projects/${p.id}/services`, 'POST', { ...service, name: 'rust', language: 'rust', routeSegment: 'tools' });
  assert.equal(rust.status, 201); assert.equal(rust.body.containerPort, 8000);
  const ts = await api<Service>(`/api/projects/${p.id}/services`, 'POST', { ...service, name: 'web', language: 'typescript', routeSegment: '' });
  assert.equal(ts.status, 201); assert.equal(ts.body.defaultUrl, p.defaultUrl);
  assert.equal((await api<Service>(`/api/projects/${p.id}/services`, 'POST', { ...service, name: 'other' })).status, 409);
  const plan = await api<DeploymentPlan>(`/api/services/${python.body.id}/deployment-plan`);
  assert.equal(plan.status, 200); assert.equal(plan.body.mode, 'preview'); assert.equal(plan.body.executableByApi, false);
  assert.equal(plan.body.source.repository, project.repository);
  assert.equal(plan.body.healthCheck.path, `/${p.id}/api/health`);
  assert.ok(plan.body.build.argv.includes('apps/api/Dockerfile'));
  assert.equal(plan.body.build.argv.at(-1), '.');
  assert.ok(plan.body.run.argv.includes('127.0.0.1:<available-port>:8000'));
  assert.equal(plan.body.nginxRoute.upstreamPort, null);
  const updated = await api<Service>(`/api/services/${python.body.id}`, 'PUT', { ...service, containerPort: 9000, watchPaths: ['apps/api/**'] });
  assert.equal(updated.status, 200); assert.equal(updated.body.containerPort, 9000);
  assert.deepEqual(updated.body.watchPaths, ['apps/api/**']);
  assert.equal((await api<Snapshot>('/api/state')).body.services.length, 3);
  await api(`/api/projects/${p.id}`, 'DELETE');
  assert.equal((await api<Snapshot>('/api/state')).body.services.length, 0);
});

test('service paths, languages, health checks and route names are validated before saving', async t => {
  const { api } = await setup(t);
  const p = (await api<ProjectView>('/api/projects', 'POST', project)).body;
  for (const patch of [
    { language: 'javascript' }, { sourcePath: '../secret' }, { dockerfile: '/etc/passwd' },
    { buildContext: 'apps/../../secret' }, { dockerfile: 'apps\\api\\Dockerfile' },
    { containerPort: 0 }, { containerPort: '3000' }, { containerPort: 1.5 },
    { routeSegment: '../admin' }, { name: '--privileged' }, { healthPath: '//evil.test' },
    { healthPath: '/health?token=secret' }, { watchPaths: ['../secrets/**'] }
  ]) assert.equal((await api<Service>(`/api/projects/${p.id}/services`, 'POST', { ...service, ...patch })).status, 400, JSON.stringify(patch));
  assert.equal((await api('/api/projects/missing/services', 'POST', service)).status, 404);
  assert.equal((await api('/api/services/missing/deployment-plan')).status, 404);
  assert.equal((await api<Snapshot>('/api/state')).body.services.length, 0);
});

test('managed MCP can be provided by a service in an ordinary monorepo project', async t => {
  const { api } = await setup(t);
  const p = (await api<ProjectView>('/api/projects', 'POST', project)).body;
  const s = (await api<Service>(`/api/projects/${p.id}/services`, 'POST', { ...service, kind: 'mcp' })).body;
  const managed = { ...mcp, source: 'managed', projectId: p.id, serviceId: s.id };
  const m = await api<McpServer>('/api/mcps', 'POST', managed); assert.equal(m.status, 201);
  assert.equal((await api(`/api/services/${s.id}`, 'DELETE')).status, 409);
  assert.equal((await api(`/api/services/${s.id}`, 'PUT', service)).status, 409);
  const other = (await api<ProjectView>('/api/projects', 'POST', { ...project, name: 'second', domain: '' })).body;
  assert.equal((await api<McpServer>('/api/mcps', 'POST', { ...managed, name: 'wrong-owner', projectId: other.id })).status, 400);
  await api(`/api/mcps/${m.body.id}`, 'DELETE');
  assert.equal((await api(`/api/services/${s.id}`, 'DELETE')).status, 200);
});

test('project Git PAT API creates, rotates and removes credentials without returning the secret', async t => {
  const { api, store } = await setup(t);
  const gitAuth = { token: 'test-github-pat', username: 'tool-operator' };
  const created = await api<ProjectView>('/api/projects', 'POST', { ...project, gitAuth });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.gitAuth, { provider: 'github', username: gitAuth.username });
  assert.doesNotMatch(JSON.stringify(created.body), /test-github-pat/);
  assert.equal((await api('/api/projects', 'POST', { ...project, repository: 'http://example.test/team/repo.git', gitAuth })).status, 400);

  const endpoint = `/api/projects/${created.body.id}/git-auth`;
  const rotated = await api(endpoint, 'PUT', { ...gitAuth, token: 'rotated-token' });
  assert.equal(rotated.status, 200);
  assert.doesNotMatch(JSON.stringify(rotated.body), /rotated-token/);
  assert.equal(store.getGitAuth(created.body.id, created.body.repository)?.token, 'rotated-token');
  const removed = await api(endpoint, 'DELETE');
  assert.deepEqual(removed, { status: 200, body: { gitAuth: null } });
  assert.equal((await api(endpoint + '/check', 'POST', {})).status, 400);
});

test('Forgejo project credentials are restricted to the configured local origin', async t => {
  const { api, store } = await setup(t);
  assert.equal((await api<{ state: string }>('/api/forgejo')).body.state, 'unconfigured');
  assert.deepEqual((await api('/api/forgejo/repositories')).body, []);
  store.configureForgejo('/test/forgejo-data', 3301);
  assert.equal(store.configureForgejo('/other/forgejo-data', 3302).port, 3301);
  store.setForgejoToken('local-user', 'private-management-token');
  assert.equal(store.getForgejoToken()?.token, 'private-management-token');

  const repository = 'http://127.0.0.1:3301/local-user/project.git';
  const gitAuth = { username: 'local-user', token: 'private-deployment-token' };
  const data = { ...project, repository, gitAuth };
  const created = await api<ProjectView>('/api/projects', 'POST', data);
  assert.equal(created.status, 201);
  assert.equal(created.body.repository, repository);
  assert.deepEqual(created.body.gitAuth, { provider: 'forgejo', username: 'local-user' });
  assert.equal(store.getGitAuth(created.body.id, repository)?.token, gitAuth.token);
  assert.doesNotMatch(JSON.stringify((await api('/api/state')).body), /private-(management|deployment)-token/);
  for (const badOrigin of ['http://127.0.0.1:3302', 'http://localhost:3301', 'http://example.test']) {
    assert.equal((await api('/api/projects', 'POST', { ...data, repository: repository.replace('http://127.0.0.1:3301', badOrigin) })).status, 400);
  }
  assert.equal((await api('/api/projects', 'POST', { ...data, gitAuth: { ...gitAuth, provider: 'github' } })).status, 400);
});

test('Nginx site drafts reject directive injection and remain separate from applied settings', async t => {
  const { api, store } = await setup(t);
  const site = { domain: 'Localhost', target: 'port', port: 8080, tls: 'private' };
  assert.equal((await api('/api/nginx/sites', 'PUT', { ...site, domain: 'local.test; include /etc/nginx/a.conf' })).status, 400);
  assert.equal((await api('/api/nginx/sites', 'PUT', { ...site, port: '8080; return 200' })).status, 400);
  assert.equal((await api('/api/nginx/sites', 'PUT', site)).status, 200);
  assert.deepEqual(store.nginxState().sites, [{ ...site, domain: 'localhost' }]);
  assert.deepEqual(store.nginxState().applied, []);
  assert.equal((await api('/api/nginx/stop', 'POST', {})).status, 400);
  assert.equal(store.nginxBindAddress(), '127.0.0.1');
  for (const address of ['0.0.0.0', '1.1.1.1', '127.0.0.1:3999']) {
    assert.equal((await api('/api/nginx/bind', 'POST', { address, confirmed: true })).status, 400);
  }
  assert.equal(store.nginxBindAddress(), '127.0.0.1');
  assert.equal((await api('/api/nginx/sites?domain=localhost', 'DELETE')).status, 200);
  assert.deepEqual(store.nginxState().sites, []);
});

test('the local deployment domain is optional, persists, and updates existing project and service addresses', async t => {
  const { api, database, store } = await setup(t);
  const p = store.createProject(project);
  const service = store.createService(p.id, {
    name: 'api', kind: 'app', language: 'typescript', sourcePath: '.', dockerfile: 'Dockerfile',
    buildContext: '.', containerPort: 3000, routeSegment: 'api', healthPath: '/health', watchPaths: []
  });
  const endpoint = '/api/settings/deployment-domain';
  assert.deepEqual(store.snapshot().deploymentDomain, { domain: '', editable: true });
  for (const domain of ['https://apps.example.test', 'apps.example.test:443', 'a.test; include ', '127.0.0.1']) {
    assert.equal((await api(endpoint, 'PUT', { domain })).status, 400);
  }
  assert.deepEqual((await api(endpoint, 'PUT', { domain: 'Apps.Example.Test' })).body, { domain: 'apps.example.test' });
  assert.equal(store.snapshot().projects[0].defaultUrl, `https://apps.example.test/${p.id}/`);
  assert.equal((await api<DeploymentPlan>(`/api/services/${service.id}/deployment-plan`)).body.defaultUrl, `https://apps.example.test/${p.id}/api/`);
  const reopened = createStore(database);
  try { assert.equal(reopened.getDeploymentDomain(), 'apps.example.test'); }
  finally { reopened.close(); }
  assert.equal((await api(endpoint, 'PUT', { domain: '' })).status, 200);
  assert.equal(store.getService(service.id).defaultUrl, '');
  assert.equal(store.getService(service.id).basePath, `/${p.id}/api`);
});
