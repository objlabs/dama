import type { NginxSite } from './types.js';
import { isIP } from 'node:net';
import { deploymentHost, serviceAddress } from './routing.js';
import { fail, HttpError } from './validation.js';
import type { Store } from './store.js';

const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function nginxDomain(value: unknown): string {
  if (typeof value !== 'string') return fail('도메인을 입력하세요.');
  const domain = value.trim().toLowerCase();
  if (domain === 'localhost' || isIP(domain) === 4 || (hostname.test(domain) && !/^[\d.]+$/.test(domain))) return domain;
  return fail('도메인 또는 localhost를 입력하세요.');
}

export function nginxSitesConfig(sites: NginxSite[], store: Store, local: boolean): string {
  const blocks = sites.map(site => {
    const { domain, tls } = site;
    const address = local ? 'host.docker.internal' : '127.0.0.1';
    const release = site.target.startsWith('service:') ? store.activeReleases().find(item => `service:${item.serviceId}` === site.target) : undefined;
    if (site.target.startsWith('service:') && !release) throw new HttpError(409, '연결된 서비스의 활성 배포를 찾을 수 없습니다.');
    const releasePath = release ? serviceAddress(release.projectId, release.routeSegment).basePath : '';
    const upstream = releasePath ? `https://127.0.0.1` : `http://${address}:${site.port}`;
    const target = releasePath ? `    location = / { return 308 ${releasePath}/; }
    location = ${releasePath} { return 308 ${releasePath}/$is_args$args; }
    location / { return 404; }
    location ^~ ${releasePath}/ {` : '    location / {';
    const route = `${target}
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Host ${releasePath ? deploymentHost : '$http_host'};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $dama_site_upgrade;
        proxy_buffering off;
        proxy_read_timeout 300s;${releasePath ? `
        proxy_ssl_server_name on;
        proxy_ssl_name ${deploymentHost};
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;` : ''}
    }`;
    const cert = tls === 'existing' ? '/etc/dama/nginx-default'
      : tls === 'private' ? `/etc/dama/certs/${domain}` : `/etc/letsencrypt/live/${domain}`;
    // HTTP remains usable for local development when the HTTPS port differs from 443.
    const challenge = local ? '' : `
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/dama-acme;
        try_files $uri =404;
    }`;
    const http = `server {
    listen 80;
    server_name ${domain};
    if ($host != ${domain}) { return 421; }${challenge}
${tls === 'http' || local ? route : '    location / { return 308 https://$host$request_uri; }'}
}`;
    return tls === 'http' ? http : `${http}
server {
    listen 443 ssl;
    server_name ${domain};
    if ($host != ${domain}) { return 421; }
    ssl_certificate "${cert}/fullchain.pem";
    ssl_certificate_key "${cert}/privkey.pem";
    ssl_protocols TLSv1.2 TLSv1.3;
${route}
}`;
  });
  const base = local ? 'server { listen 80 default_server; server_name _; return 404; }\n' : '# Dama managed sites\n';
  return blocks.length ? base + "map $http_upgrade $dama_site_upgrade { default upgrade; '' close; }\n\n" + blocks.join('\n\n') + '\n' : base;
}

export function productionService(store: Store, value: string): string {
  if (!value.startsWith('service:')) throw new HttpError(400, '배포된 서비스 또는 Forgejo를 선택하세요.');
  const id = value.slice('service:'.length);
  store.getService(id);
  if (!store.activeReleases().some(release => release.serviceId === id)) {
    throw new HttpError(409, '서비스를 먼저 배포하세요.');
  }
  return id;
}
