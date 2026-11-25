import type { IncomingMessage } from 'node:http';
import type { Store } from './store.js';
import type { JsonObject, ResourceType } from './types.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { HttpError, projectInput, mcpInput, bindingInput, serviceInput, commitSha, deployEnvironment, sharedKind } from './validation.js';
import { deploymentPlan } from './deployment-plan.js';
import { checkGitAuth, gitAuthInput, gitRepository } from './git-auth.js';
import { listDatabaseConnections } from './database-connections.js';
import { createSharedEnvironment, dashboardSharedDirectory } from './shared-environment.js';
import { createForgejo, requireLocalForgejo } from './forgejo.js';
import { createNginxAdmin } from './nginx-admin.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets: Record<string, readonly [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
async function readJson(req: IncomingMessage): Promise<JsonObject> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'application/json 요청이 필요합니다.');
  let body = ''; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, '요청이 너무 큽니다.');
    body += chunk;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as JsonObject;
  } catch { throw new HttpError(400, '올바른 JSON 객체를 입력하세요.'); }
}
export function createApp(store: Store, shared: ReturnType<typeof createSharedEnvironment> = createSharedEnvironment(store, dashboardSharedDirectory()), forgejo = createForgejo(store)) {
  const proxy = createNginxAdmin(store);
  return createServer(async (req, res) => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Local development only. Host/Origin checks also block browser DNS rebinding and cross-site writes.
      const local = new URL(`http://${req.headers.host ?? ''}`);
      const port = String(req.socket.localPort);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname) || (local.port || '80') !== port) throw new HttpError(403, '로컬 주소로 접속하세요.');
      if (req.headers.origin && req.headers.origin !== local.origin) throw new HttpError(403, '다른 출처의 요청은 허용하지 않습니다.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '다른 출처의 요청은 허용하지 않습니다.');
      const route = new URL(req.url ?? '/', local);
      const { pathname: path } = route;
      if (req.method === 'GET' && path === '/api/state') return json(200, store.snapshot());
      if (req.method === 'PUT' && path === '/api/settings/deployment-domain') {
        return json(200, { domain: store.setDeploymentDomain((await readJson(req)).domain) });
      }
      if (req.method === 'GET' && path === '/api/database-connections') {
        const legacy = await listDatabaseConnections();
        const projectId = route.searchParams.get('projectId');
        const managed = projectId ? store.listSharedResources()
          .filter(resource => resource.projectId === projectId && resource.kind === 'postgres' && resource.ready)
          .map(({ id, environment, name }) => ({ id, environment, name })) : [];
        return json(200, [...legacy, ...managed]);
      }
      if (req.method === 'GET' && path === '/api/shared-resources') return json(200, store.listSharedResources());
      if (req.method === 'GET' && path === '/api/shared-environments') return json(200, await shared.list());
      if (req.method === 'GET' && path === '/api/nginx') return json(200, await proxy.state());
      if (req.method === 'GET' && path === '/api/nginx/ca') {
        const pem = await proxy.ca();
        res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="dama-private-ca.pem"' });
        return res.end(pem);
      }
      if (req.method === 'GET' && path === '/api/nginx/inspect') return json(200, await proxy.inspect(route.searchParams.get('domain') ?? ''));
      if (req.method === 'PUT' && path === '/api/nginx/sites') {
        await proxy.save(await readJson(req));
        return json(200, { ok: true });
      }
      if (req.method === 'DELETE' && path === '/api/nginx/sites') {
        await proxy.remove(route.searchParams.get('domain'));
        return json(200, { ok: true });
      }
      const proxyAction = path.match(/^\/api\/nginx\/(start|stop|restart|reload|validate|apply|rollback|logs|timer|private|issue|renew|bind)$/);
      if (req.method === 'POST' && proxyAction) return json(200, { output: await proxy.action(proxyAction[1], await readJson(req)) });
      if (req.method === 'GET' && path === '/api/forgejo') return json(200, await forgejo.status());
      if (req.method === 'POST' && path === '/api/forgejo/start') return json(200, await forgejo.start((await readJson(req)).dataPath));
      if (req.method === 'POST' && path === '/api/forgejo/stop') return json(200, await forgejo.stop());
      if (req.method === 'PUT' && path === '/api/forgejo/token') return json(200, await forgejo.saveToken((await readJson(req)).token));
      if (req.method === 'DELETE' && path === '/api/forgejo/token') return json(200, await forgejo.forgetToken());
      if (req.method === 'GET' && path === '/api/forgejo/repositories') return json(200, await forgejo.list());
      if (req.method === 'POST' && path === '/api/forgejo/repositories') return json(201, await forgejo.create(await readJson(req)));
      const sharedAction = path.match(/^\/api\/shared-environments\/([a-z]+)\/(start|stop)$/);
      if (req.method === 'POST' && sharedAction) {
        const environment = deployEnvironment(sharedAction[1]);
        if (sharedAction[2] === 'start') return json(200, await shared.start(environment));
        if ((await readJson(req)).confirmed !== true) throw new HttpError(400, '공용 환경 중지를 확인하세요.');
        return json(200, await shared.stop(environment));
      }
      const sharedResources = path.match(/^\/api\/projects\/([\w-]+)\/shared-resources$/);
      if (req.method === 'POST' && sharedResources) {
        const body = await readJson(req);
        return json(200, await shared.provision(sharedResources[1], deployEnvironment(body.environment), sharedKind(body.kind)));
      }
      if (req.method === 'GET' && path === '/api/health') return json(200, { ok: true, mode: 'local-development' });
      if (req.method === 'POST' && path === '/api/projects') {
        const body = await readJson(req);
        const project = projectInput(body);
        const auth = body.gitAuth === undefined ? undefined : gitAuthInput(body.gitAuth, project.repository, store.forgejoOrigin());
        return json(201, store.createProject(project, auth));
      }
      if (req.method === 'POST' && path === '/api/git-auth/check') {
        const body = await readJson(req);
        const repository = gitRepository(body.repository, store.forgejoOrigin()).href;
        const auth = gitAuthInput(body.gitAuth, repository, store.forgejoOrigin());
        await checkGitAuth(repository, auth, await requireLocalForgejo(store, repository));
        return json(200, { ok: true });
      }
      const gitAuth = path.match(/^\/api\/projects\/([\w-]+)\/git-auth(?:\/(check))?$/);
      if (gitAuth) {
        const { id, repository } = store.getProject(gitAuth[1]);
        if (!gitAuth[2] && req.method === 'PUT') {
          const auth = gitAuthInput(await readJson(req), repository, store.forgejoOrigin());
          return json(200, { gitAuth: store.setGitAuth(id, auth) });
        }
        if (!gitAuth[2] && req.method === 'DELETE') return json(200, { gitAuth: store.setGitAuth(id, null) });
        if (gitAuth[2] && req.method === 'POST') {
          const body = await readJson(req);
          const auth = body.gitAuth === undefined ? store.getGitAuth(id, repository) : gitAuthInput(body.gitAuth, repository, store.forgejoOrigin());
          if (!auth) throw new HttpError(400, '연결을 확인할 PAT를 입력하세요.');
          await checkGitAuth(repository, auth, await requireLocalForgejo(store, repository));
          return json(200, { ok: true });
        }
      }
      if (req.method === 'POST' && path === '/api/mcps') return json(201, store.createMcp(mcpInput(await readJson(req))));
      const services = path.match(/^\/api\/projects\/([\w-]+)\/services$/);
      if (req.method === 'POST' && services) return json(201, store.createService(services[1], serviceInput(await readJson(req))));
      const service = path.match(/^\/api\/services\/([\w-]+)$/);
      if (req.method === 'PUT' && service) return json(200, store.updateService(service[1], serviceInput(await readJson(req))));
      const plan = path.match(/^\/api\/services\/([\w-]+)\/deployment-plan$/);
      if (req.method === 'GET' && plan) {
        const item = store.getService(plan[1]);
        return json(200, deploymentPlan(store.getProject(item.projectId), item));
      }
      const serviceBuilds = path.match(/^\/api\/services\/([\w-]+)\/build-jobs$/);
      if (req.method === 'POST' && serviceBuilds) {
        const body = await readJson(req);
        if (body.promoteJobId !== undefined && (typeof body.promoteJobId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.promoteJobId))) {
          throw new HttpError(400, '승격할 test 배포를 선택하세요.');
        }
        return json(201, store.enqueueBuild(serviceBuilds[1], commitSha(body.commitSha), body.promoteJobId));
      }
      const build = path.match(/^\/api\/build-jobs\/([\w-]+)$/);
      if (req.method === 'DELETE' && build) { store.cancelBuild(build[1]); return json(200, { ok: true }); }
      const binding = path.match(/^\/api\/projects\/([\w-]+)\/bindings$/);
      if (req.method === 'POST' && binding) return json(201, store.bind(binding[1], bindingInput(await readJson(req))));
      const deletion = path.match(/^\/api\/(projects|services|mcps|bindings)\/([\w-]+)$/);
      if (req.method === 'DELETE' && deletion) { store.remove(deletion[1] as ResourceType, deletion[2]); return json(200, { ok: true }); }
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        const data = await readFile(resolve(publicDir, file));
        res.writeHead(200, { 'Content-Type': type }); return res.end(data);
      }
      throw new HttpError(404, '요청한 경로를 찾을 수 없습니다.');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      json(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '서버 오류가 발생했습니다.' });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const database = resolve(process.env.DAMA_DB ?? 'data/dama.sqlite');
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const store = createStore(database);
  chmodSync(database, 0o600);
  const port = Number(process.env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1~65535여야 합니다.');
  const server = createApp(store);
  server.listen(port, '127.0.0.1', () => console.log(`Dama → http://127.0.0.1:${port} (local development)`));
  server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
