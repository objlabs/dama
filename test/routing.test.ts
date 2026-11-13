import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectAddress, nginxConfig } from '../src/routing.js';
const id = '00000000-0000-4000-8000-000000000001';

test('UUID base path is stable and input cannot inject Nginx directives', () => {
  assert.deepEqual(projectAddress(id), { basePath: `/${id}`, defaultUrl: `https://apps.objlabs.team/${id}/` });
  assert.throws(() => projectAddress('../admin'));
  assert.throws(() => projectAddress(`${id}; return 200;`));
  // @ts-expect-error Exercise invalid runtime input even though TypeScript rejects it.
  assert.throws(() => nginxConfig({ routes: [{ projectId: id, upstreamPort: '3000; return 200;' }] }));
  assert.throws(() => nginxConfig({ routes: [{ projectId: id, upstreamPort: 80 }] }));
  assert.throws(() => nginxConfig({ routes: [{ projectId: id, upstreamPort: 32780 }, { projectId: id, upstreamPort: 32781 }] }));
});

test('HTTP bootstrap works without certificate files and cannot proxy unverified apps', () => {
  const config = nginxConfig({ routes: [] }, { bootstrap: true });
  assert.match(config, /listen 80;/);
  assert.match(config, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.doesNotMatch(config, /ssl_certificate|listen 443|proxy_pass/);
});

test('HTTPS config keeps UUID paths, isolates prefixes and retains ACME endpoint', () => {
  const config = nginxConfig({ routes: [{ projectId: id, upstreamPort: 32780 }] });
  assert.match(config, /server_name apps\.objlabs\.team;/);
  assert.ok(config.includes(`location = /${id} {`));
  assert.ok(config.includes(`location ^~ /${id}/ {`));
  assert.ok(config.includes(`return 308 /${id}/$is_args$args;`));
  assert.ok(config.includes('proxy_pass http://127.0.0.1:32780;'));
  assert.doesNotMatch(config, /proxy_pass http:\/\/127\.0\.0\.1:32780\//);
  assert.match(config, /fullchain\.pem/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(config, /proxy_buffering off;/);
  assert.match(config, /return 308 https:\/\/apps\.objlabs\.team\$request_uri;/);
});

test('monorepo services route independently and reuse an existing wildcard certificate', () => {
  const config = nginxConfig({
    tls: { certificate: '/etc/nginx/ssl/objlabs.team-chain.pem', privateKey: '/etc/nginx/ssl/objlabs.team-key.pem' },
    routes: [{ projectId: id, routeSegment: '', upstreamPort: 32780 }, { projectId: id, routeSegment: 'api', upstreamPort: 32781 }]
  });
  assert.ok(config.includes(`location ^~ /${id}/ {`));
  assert.ok(config.includes(`location ^~ /${id}/api/ {`));
  assert.ok(config.includes('proxy_pass http://127.0.0.1:32781;'));
  assert.ok(config.includes('ssl_certificate "/etc/nginx/ssl/objlabs.team-chain.pem";'));
  assert.doesNotMatch(config, /letsencrypt/);
  assert.throws(() => nginxConfig({ routes: [], tls: { certificate: '/tmp/a"; return 200;' } }));
  assert.throws(() => nginxConfig({ routes: [{ projectId: id, routeSegment: '../evil', upstreamPort: 3000 }] }));
});
