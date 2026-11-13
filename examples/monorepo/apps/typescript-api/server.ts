import { createServer } from 'node:http';

const base = (process.env.DAMA_BASE_PATH ?? '').replace(/\/$/, '');
createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const ok = path === `${base}/` || path === `${base}/health`;
  response.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ service: 'typescript-api', ok }));
}).listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
