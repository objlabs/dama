import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { allocateHostPort } from './deployment-ports.js';
import { nginxDomain, nginxSitesConfig, productionService } from './nginx-sites.js';
import { deploymentHost } from './routing.js';
import type { Store } from './store.js';
import type { JsonObject, NginxSite, NginxState } from './types.js';
import { fail, HttpError, text } from './validation.js';

const exec = promisify(execFile);
const image = 'nginx:stable';
const helper = '/usr/local/libexec/dama/nginx-admin';
const loopback = '127.0.0.1';

function lanAddresses() {
  const addresses = Object.values(networkInterfaces()).flatMap(items => items ?? [])
    .filter(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'));
  return [...new Set(addresses.map(item => item.address))].sort();
}

async function command(file: string, argv: string[], timeout = 15_000) {
  return (await exec(file, argv, { timeout, maxBuffer: 256 * 1024 })).stdout.trim();
}

export function createNginxAdmin(store: Store, options: { local: boolean; directory: string; containerName?: string } = {
  local: !process.env.DAMA_NGINX_CONFIG,
  directory: resolve(dirname(resolve(process.env.DAMA_DB ?? 'data/dama.sqlite')), 'nginx')
}) {
  const { local, directory } = options;
  const container = options.containerName ?? 'dama-nginx';
  const backups = [`${container}-backup-running`, `${container}-backup-stopped`];
  const configDir = local ? join(directory, 'conf') : '/etc/nginx/dama-sites';
  const certDir = join(directory, 'certs');
  const authority = join(directory, 'authority');
  const active = join(configDir, 'active.conf');
  const candidate = join(local ? directory : configDir, 'candidate.conf');
  const production = (args: string[], timeout?: number) => command('/usr/bin/sudo', ['-n', helper, ...args], timeout);
  const docker = (args: string[], timeout?: number) => command('docker', args, timeout);
  const label = 'team.objlabs.dama.nginx';
  let busy = false;
  async function perform<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) throw new HttpError(409, '다른 Nginx 작업이 진행 중입니다.');
    busy = true;
    try { return await fn(); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      const message = (error as { stderr?: string }).stderr?.trim().split('\n').slice(-5).join('\n');
      throw new HttpError(503, message ? `Nginx 작업에 실패했습니다. ${message.slice(0, 900)}` : 'Nginx 작업에 실패했습니다. Docker 또는 서버 연동 상태를 확인하세요.');
    } finally { busy = false; }
  }

  async function instance(name = container) {
    const result = await docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
    if (!result) return null;
    const row = JSON.parse(await docker(['inspect', '--format', '{{json .}}', name])) as {
      Image: string;
      Config: { Labels: Record<string, string> };
      HostConfig: { PortBindings: Record<string, { HostIp: string; HostPort: string }[]> };
      State: { Running: boolean };
    };
    if (row.Config.Labels?.[label] !== directory) throw new Error('Dama Nginx container belongs to another workspace');
    const http = row.HostConfig.PortBindings['80/tcp'] ?? [];
    const https = row.HostConfig.PortBindings['443/tcp'] ?? [];
    const bindAddress = http.find(binding => binding.HostIp !== loopback)?.HostIp ?? loopback;
    const httpPort = Number(http.find(binding => binding.HostIp === loopback)?.HostPort ?? 0);
    const httpsPort = Number(https.find(binding => binding.HostIp === loopback)?.HostPort ?? 0);
    if (!httpPort || !httpsPort || (bindAddress !== loopback && (
      !http.some(binding => binding.HostIp === bindAddress && Number(binding.HostPort) === httpPort) ||
      !https.some(binding => binding.HostIp === bindAddress && Number(binding.HostPort) === httpsPort)
    ))) throw new Error('Unexpected Nginx port mappings');
    return { running: row.State.Running, httpPort, httpsPort, bindAddress, image: row.Image };
  }
  async function runtime() {
    const result: Pick<NginxState, 'status' | 'httpPort' | 'httpsPort' | 'bindAddress' | 'lanAddresses'> = {
      status: 'unavailable', httpPort: local ? 0 : 80, httpsPort: local ? 0 : 443,
      bindAddress: local ? store.nginxBindAddress() : '', lanAddresses: local ? lanAddresses() : []
    };
    try {
      if (!local) result.status = await production(['status']) === 'active' ? 'running' : 'stopped';
      else {
        const state = await instance();
        result.status = state?.running ? 'running' : 'stopped';
        result.httpPort = state?.httpPort ?? 0;
        result.httpsPort = state?.httpsPort ?? 0;
        if (state) result.bindAddress = state.bindAddress;
      }
    } catch { /* Docker or the Linux helper is unavailable. */ }
    return result;
  }
  function render(sites: NginxSite[]) { return nginxSitesConfig(sites, store, local); }
  async function ca() {
    try { return local ? await readFile(join(authority, 'ca.pem'), 'utf8') : await production(['ca']); }
    catch { throw new HttpError(404, '사설 CA 인증서가 아직 없습니다.'); }
  }
  async function state(): Promise<NginxState> {
    const settings = store.nginxState();
    const current = await readFile(active, 'utf8').catch(() => '# Dama managed sites\n');
    return {
      ...await runtime(), mode: local ? 'docker' : 'systemd', sites: settings.sites, applied: settings.applied,
      canRollback: settings.previous !== null, preview: render(settings.sites), current,
      ca: await ca().then(() => true, () => false)
    };
  }
  async function prepare() {
    if (!local) return;
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(certDir, { recursive: true, mode: 0o700 });
    try { await writeFile(active, render([]), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  function certMounts() { return ['--mount', `type=bind,source=${certDir},target=/etc/dama/certs,readonly`]; }
  async function validate(config: string, sites: NginxSite[]) {
    await prepare();
    await writeFile(candidate, config, { mode: 0o600 });
    try {
      if (local) {
        await docker(['run', '--rm', ...certMounts(), '--mount',
          `type=bind,source=${candidate},target=/etc/nginx/conf.d/default.conf,readonly`, image, 'nginx', '-t'], 120_000);
      } else {
        await production(['test-candidate']);
        for (const site of sites.filter(item => item.tls !== 'http')) {
          await production(['inspect', site.tls, site.domain]);
        }
      }
    } finally { await rm(candidate, { force: true }); }
  }
  async function replaceConfig(config: string) {
    const temp = active + '.next';
    await writeFile(temp, config, { mode: 0o600 });
    await rename(temp, active);
  }
  async function reload() {
    if (local) {
      if (!(await instance())?.running) throw new HttpError(409, 'Nginx를 먼저 시작하세요.');
      await docker(['exec', container, 'nginx', '-t']);
      await docker(['exec', container, 'nginx', '-s', 'reload']);
    } else await production(['reload']);
  }
  async function apply(rollback: boolean) {
    const settings = store.nginxState();
    const sites = rollback ? settings.previous : settings.sites;
    if (!sites) throw new HttpError(409, '복원할 설정이 없습니다.');
    const config = render(sites);
    await validate(config, sites);
    if (!local && store.runningBuildId()) throw new HttpError(409, '배포가 끝난 뒤 Nginx 설정을 적용하세요.');
    const before = await readFile(active, 'utf8');
    const running = (await runtime()).status === 'running';
    await replaceConfig(config);
    try {
      if (!local) await production(['test']);
      if (running) await reload();
      store.applyNginxSites(sites, rollback);
    } catch (error) {
      await replaceConfig(before);
      if (running) await reload();
      throw error;
    }
  }
  async function start() {
    if (!local) { await production(['start']); return; }
    await recoverBindings();
    const current = await instance();
    if (current) {
      if (!current.running) await docker(['start', container]);
      return;
    }
    const address = store.nginxBindAddress();
    if (address !== loopback && !lanAddresses().includes(address)) fail('현재 Mac에 할당된 LAN 주소를 선택하세요.');
    await prepare();
    const upstreamPorts = new Set([...store.nginxState().sites, ...store.nginxState().applied].map(site => site.port));
    await allocateHostPort('web', async httpPort => {
      if (upstreamPorts.has(httpPort)) return false;
      let recordedCollision = '';
      try {
        await allocateHostPort('web', async httpsPort => {
          if (httpsPort === httpPort || upstreamPorts.has(httpsPort)) return false;
          try {
            await createContainer(httpPort, httpsPort, address, true);
            return true;
          } catch (error) {
            const stderr = (error as { stderr?: string }).stderr ?? '';
            if (!/address already in use|port is already allocated|ports are not available/i.test(stderr)) throw error;
            if (await instance()) await docker(['rm', container]);
            if (stderr.includes(`:${httpPort}`)) { recordedCollision = stderr; throw error; }
            return false;
          }
        });
      } catch (error) {
        if (recordedCollision) return false;
        throw error;
      }
      return true;
    });
  }
  async function createContainer(httpPort: number, httpsPort: number, address: string, run: boolean, imageRef = image) {
    const addresses = address === loopback ? [loopback] : [loopback, address];
    const ports = addresses.flatMap(ip => ['--publish', `${ip}:${httpPort}:80`, '--publish', `${ip}:${httpsPort}:443`]);
    await docker([...(run ? ['run', '-d'] : ['create']), '--name', container, '--label', `${label}=${directory}`,
      '--restart', 'unless-stopped', ...ports, '--mount', `type=bind,source=${configDir},target=/etc/nginx/conf.d,readonly`,
      ...certMounts(), imageRef], 120_000);
  }
  async function restoreBindingBackup(backup: string, shouldRun: boolean) {
    const replacement = await instance();
    if (replacement) {
      if (replacement.running) await docker(['stop', container], 40_000);
      await docker(['rm', container]);
    }
    await docker(['rename', backup, container]);
    if (shouldRun && !(await instance())?.running) await docker(['start', container], 40_000);
  }
  async function recoverBindings() {
    for (const [index, backup] of backups.entries()) {
      if (!await instance(backup)) continue;
      const current = await instance();
      if (current?.bindAddress === store.nginxBindAddress()) await docker(['rm', backup]);
      else await restoreBindingBackup(backup, index === 0);
    }
  }
  async function changeBinding(body: JsonObject) {
    if (!local) fail('Docker Nginx에서만 접속 주소를 변경할 수 있습니다.');
    const address = body.address;
    if (typeof address !== 'string' || (address !== loopback && !lanAddresses().includes(address))) {
      fail('현재 Mac에 할당된 LAN 주소를 선택하세요.');
    }
    if (address !== loopback && body.confirmed !== true) fail('LAN에서 Nginx 접속을 허용할지 확인하세요.');
    await recoverBindings();
    const current = await instance();
    if (!current || current.bindAddress === address) {
      store.setNginxBindAddress(address);
      return;
    }
    if (current.running && body.confirmed !== true) fail('Nginx가 잠시 중단될 수 있습니다. 접속 주소 변경을 확인하세요.');
    const backup = backups[current.running ? 0 : 1];
    await docker(['rename', container, backup]);
    try {
      if (current.running) await docker(['stop', backup], 40_000);
      await createContainer(current.httpPort, current.httpsPort, address, current.running, current.image);
      const replacement = await instance();
      if (replacement?.bindAddress !== address || (current.running && !replacement.running)) {
        throw new HttpError(503, '새 Nginx 접속 주소 또는 실행 상태를 확인하지 못했습니다.');
      }
      store.setNginxBindAddress(address);
    } catch (error) {
      await restoreBindingBackup(backup, current.running);
      throw error;
    }
    await docker(['rm', backup]);
  }
  function siteFor(value: unknown) {
    const domain = nginxDomain(value);
    const site = store.nginxState().sites.find(item => item.domain === domain);
    if (!site) throw new HttpError(404, '등록된 도메인이 없습니다.');
    return site;
  }
  return {
    state, ca,
    save: (body: JsonObject) => perform(async () => {
      const domain = nginxDomain(body.domain);
      const previous = body.previous ? nginxDomain(body.previous) : domain;
      if (!local && domain === deploymentHost) fail('기본 배포 도메인은 기존 Nginx 설정에서 관리합니다.');
      const settings = store.nginxState();
      const target = text(body.target, '연결 대상');
      let port = 0;
      if (target === 'forgejo') {
        port = store.forgejoSettings()?.port ?? 0;
        if (!port) fail('공용 환경에서 Forgejo를 먼저 설치하세요.');
      } else if (local && target === 'port') {
        if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1024 || body.port > 65535) fail('호스트 포트는 1024–65535 정수로 입력하세요.');
        port = body.port;
        const proxy = await runtime();
        if (port === proxy.httpPort || port === proxy.httpsPort) fail('Nginx 자신의 포트는 연결 대상으로 사용할 수 없습니다.');
      } else if (!local) productionService(store, target);
      else fail('로컬 포트 또는 Forgejo를 선택하세요.');
      const tls = body.tls;
      if (tls !== 'http' && tls !== 'private' && (local || (tls !== 'existing' && tls !== 'acme'))) fail('인증서 유형을 선택하세요.');
      if (tls === 'acme' && (domain === 'localhost' || isIP(domain))) fail('이 주소에는 사설 인증서를 사용하세요.');
      if (domain !== previous && settings.sites.some(site => site.domain === domain)) throw new HttpError(409, '이미 등록된 도메인입니다.');
      const site: NginxSite = { domain, target, port, tls: tls as NginxSite['tls'] };
      store.saveNginxSites([...settings.sites.filter(item => item.domain !== previous), site].sort((a, b) => a.domain.localeCompare(b.domain)));
    }),
    remove: (domain: unknown) => perform(async () => {
      const site = siteFor(domain);
      store.saveNginxSites(store.nginxState().sites.filter(item => item.domain !== site.domain));
    }),
    inspect: async (domain: string) => {
      const site = siteFor(domain);
      const addresses = await lookup(site.domain, { all: true }).then(items => items.map(item => item.address), () => []);
      let certificate = '';
      if (site.tls !== 'http') {
        try {
          if (!local) certificate = await production(['inspect', site.tls, site.domain]);
          else {
            const leaf = new X509Certificate(await readFile(join(certDir, site.domain, 'fullchain.pem')));
            const match = isIP(site.domain) ? leaf.checkIP(site.domain) : leaf.checkHost(site.domain);
            certificate = `만료 ${leaf.validTo}\n발급자 ${leaf.issuer}\n도메인 일치 ${match ? '예' : '아니요'}`;
          }
        } catch { certificate = '인증서를 찾거나 읽을 수 없습니다.'; }
      }
      return { addresses, certificate };
    },
    action: (action: string, body: JsonObject) => perform(async () => {
      if (action === 'bind') return changeBinding(body);
      if (action === 'start') return start();
      if (action === 'validate') {
        const { sites } = store.nginxState();
        return validate(render(sites), sites);
      }
      if (action === 'apply' || action === 'rollback') return apply(action === 'rollback');
      if (action === 'reload') return reload();
      if (action === 'logs' || action === 'timer') {
        if (!local) return production([action]);
        if (action === 'timer') fail('로컬 사설 인증서는 화면에서 다시 발급할 수 있습니다.');
        const logs = await exec('docker', ['logs', '--tail', '40', container], { timeout: 15_000, maxBuffer: 128 * 1024 });
        return [logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join('\n');
      }
      if (action === 'stop' || action === 'restart') {
        if (body.confirmed !== true) fail('연결된 도메인의 접속 중단을 확인하세요.');
        if (!local) {
          if (store.runningBuildId()) throw new HttpError(409, '배포가 끝난 뒤 Nginx를 제어하세요.');
          await production([action]);
          return;
        }
        if (!(await instance())) throw new HttpError(409, 'Nginx를 먼저 시작하세요.');
        await docker([action, container], 40_000);
        return;
      }
      const site = siteFor(body.domain);
      if (action === 'private' && site.tls === 'private') {
        if (local) {
          await prepare();
          await command('/bin/sh', [resolve('deploy/nginx/private-cert'), authority, site.domain, certDir], 60_000);
        } else await production(['private', site.domain], 60_000);
        if (store.nginxState().applied.some(item => item.domain === site.domain && item.tls === 'private') &&
            (await runtime()).status === 'running') await reload();
        return;
      }
      if (!local && site.tls === 'acme' && (action === 'issue' || action === 'renew')) {
        const mode = body.staging === true ? 'staging' : 'production';
        if (mode === 'production' && body.confirmed !== true) fail('실제 인증서 발급 또는 갱신을 확인하세요.');
        if (action === 'renew') return production(['renew', site.domain, mode], 180_000);
        if (body.method !== 'http' && body.method !== 'route53') fail('인증서 검증 방식을 선택하세요.');
        if (body.method === 'http' && !store.nginxState().applied.some(item => item.domain === site.domain)) {
          fail('HTTP-01 검증을 위해 먼저 해당 도메인을 HTTP 설정으로 적용하세요.');
        }
        const email = text(body.email, 'ACME 이메일', 254);
        if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) fail('ACME 이메일을 확인하세요.');
        return production(['issue', site.domain, body.method, email, mode], 180_000);
      }
      throw new HttpError(400, '현재 모드에서 사용할 수 없는 Nginx 작업입니다.');
    })
  };
}
