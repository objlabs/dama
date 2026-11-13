import type { IncomingMessage } from 'node:http';
import type { Store } from './store.js';
import type { JsonObject, ResourceType } from './types.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { HttpError, projectInput, mcpInput, bindingInput, serviceInput, commitSha } from './validation.js';
import { deploymentPlan } from './deployment-plan.js';

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
export function createApp(store: Store) {
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
      const path = new URL(req.url ?? '/', local).pathname;
      if (req.method === 'GET' && path === '/api/state') return json(200, store.snapshot());
      if (req.method === 'GET' && path === '/api/health') return json(200, { ok: true, mode: 'local-development' });
      if (req.method === 'POST' && path === '/api/projects') return json(201, store.createProject(projectInput(await readJson(req))));
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
      if (req.method === 'POST' && serviceBuilds) return json(201, store.enqueueBuild(serviceBuilds[1], commitSha((await readJson(req)).commitSha)));
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
