import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { deploymentPlan } from './deployment-plan.js';
import { nginxLocations } from './routing.js';
import type { Store } from './store.js';
import type { ClaimedBuild, DeploymentPlan, Release } from './types.js';
import { commitSha } from './validation.js';

const exec = promisify(execFile);
const includeHeader = '# Managed by Dama deployment worker\n';
export interface WorkerConfig { include: string; nginxConfig: string; probeOrigin: string }

async function command(file: string, args: string[], cwd?: string, timeout = 30_000): Promise<string> {
  const { stdout } = await exec(file, args, {
    cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout.trim();
}

export async function waitForDeploymentDependencies(config: WorkerConfig, stopping: () => boolean): Promise<boolean> {
  let lastWaitingFor = '';
  while (!stopping()) {
    let waitingFor = 'Docker';
    try {
      await command('docker', ['info', '--format', '{{.ServerVersion}}'], undefined, 5000);
      waitingFor = 'Nginx';
      const response = await fetch(config.probeOrigin, {
        method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2000)
      });
      // An empty deployment host can return 404. Any HTTP response confirms it is listening.
      await response.body?.cancel();
      return !stopping();
    } catch {
      if (waitingFor !== lastWaitingFor) {
        console.log(`${waitingFor} 준비를 기다리는 중입니다.`);
        lastWaitingFor = waitingFor;
      }
    }
    if (!stopping()) await delay(2000);
  }
  return false;
}

async function withinCheckout(root: string, path: string, directory: boolean): Promise<void> {
  const target = await realpath(join(root, path));
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error('빌드 경로가 체크아웃 디렉터리 밖을 가리킵니다.');
  }
  const info = await stat(target);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('빌드 경로 유형이 올바르지 않습니다.');
}

async function waitForHttp(origin: string, path: string, timeout: number, deploymentId?: string, expectAbsent = false): Promise<void> {
  const end = Date.now() + timeout;
  do {
    try {
      const response = await fetch(origin + path, {
        signal: AbortSignal.timeout(Math.min(2000, Math.max(1, end - Date.now()))),
        redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }
      });
      await response.body?.cancel();
      const marker = response.headers.get('X-Dama-Deployment');
      if (expectAbsent ? marker !== deploymentId : response.ok && (!deploymentId || marker === deploymentId)) return;
    } catch {
      // The application or newly loaded Nginx worker may still be starting.
    }
    if (Date.now() < end) await delay(250);
  } while (Date.now() < end);
  throw new Error(deploymentId ? 'Nginx에서 새 배포의 정상 응답을 확인하지 못했습니다.' : '컨테이너 상태 확인 시간이 초과되었습니다.');
}

function includeText(releases: Release[]): string {
  return includeHeader + nginxLocations(releases) + (releases.length ? '\n' : '');
}

async function readInclude(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error('Dama include는 일반 파일이어야 합니다.');
  return readFile(path, 'utf8');
}

async function writeInclude(path: string, content: string): Promise<void> {
  const staging = join(dirname(path), `.dama-${randomUUID()}.tmp`);
  try {
    await writeFile(staging, content, { flag: 'wx', mode: 0o644 });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

async function nginx(config: WorkerConfig, reload: boolean): Promise<void> {
  await command('nginx', ['-c', config.nginxConfig, '-t']);
  if (reload) await command('nginx', ['-c', config.nginxConfig, '-s', 'reload']);
}

function savedPlan(store: Store, job: ClaimedBuild): DeploymentPlan {
  if (job.plan) return job.plan;
  const service = store.getService(job.serviceId);
  const plan = deploymentPlan(store.getProject(service.projectId), service);
  // v3 stored build settings but no runtime settings. Refuse a stale build configuration.
  const withoutTag = (args: string[]) => args.filter((_, index) => index !== args.indexOf('--tag') + 1);
  if (JSON.stringify(withoutTag(plan.build.argv)) !== JSON.stringify(withoutTag(job.build.argv))) {
    throw new Error('서비스 빌드 설정이 변경되었습니다. 현재 설정으로 작업을 다시 등록하세요.');
  }
  return plan;
}

async function removeCandidate(id: string): Promise<void> {
  const owned = await command('docker', ['ps', '-aq', '--filter', `label=team.objlabs.dama.deployment=${id}`]);
  if (!owned) return;
  await command('docker', ['rm', '-f', ...owned.split(/\s+/)]);
}

export async function deployNext(store: Store, config: WorkerConfig): Promise<boolean> {
  const job = store.claimBuild();
  if (!job) return false;

  const log = (message: string) => console.log(`[${job.id}] ${message}`);
  let checkout: string | undefined;
  let before: string | undefined;
  let installed = false;
  let attemptedRun = false;
  let candidate: Release | undefined;
  let phase = '배포 설정';
  try {
    const plan = savedPlan(store, job);
    const routes = store.activeReleases();
    before = await readInclude(config.include);
    if (before !== includeText(routes) && !(routes.length === 0 && before === '')) {
      throw new Error('Dama include가 데이터베이스의 활성 배포와 일치하지 않습니다.');
    }
    // Validate the existing server before building. This also checks certificate access.
    await nginx(config, false);
    const sha = commitSha(job.commitSha);
    const repo = new URL(job.source.repository);
    if (!['http:', 'https:'].includes(repo.protocol) || repo.username || repo.password) throw new Error('HTTP(S) Git 저장소가 필요합니다.');
    const existing = routes.filter(route => route.serviceId !== job.serviceId);
    nginxLocations([...existing, { ...plan.nginxRoute, upstreamPort: 1024 }]);

    phase = 'Git 체크아웃';
    log(phase);
    checkout = await realpath(await mkdtemp(join(tmpdir(), 'dama-build-')));
    await command('git', ['init', '--quiet'], checkout);
    await command('git', ['-c', 'protocol.file.allow=never', 'fetch', '--no-tags', '--depth=1', '--', repo.href, sha], checkout, 120_000);
    if (await command('git', ['rev-parse', 'FETCH_HEAD'], checkout) !== sha) throw new Error('요청한 커밋과 가져온 커밋이 다릅니다.');
    await command('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', sha], checkout);
    await rm(join(checkout, '.git'), { recursive: true });
    const buildArgs = plan.build.argv.slice(1);
    await withinCheckout(checkout, buildArgs[buildArgs.indexOf('--file') + 1], false);
    await withinCheckout(checkout, buildArgs.at(-1)!, true);

    phase = 'Docker 빌드';
    log(phase);
    await command('docker', buildArgs, checkout, 900_000);
    const tag = buildArgs[buildArgs.indexOf('--tag') + 1];
    const image = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
    if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('빌드한 이미지 ID를 확인할 수 없습니다.');

    phase = '컨테이너 상태 확인';
    log(phase);
    const container = `dama-release-${job.id}`;
    const args = plan.run.argv.slice(1, -1);
    args[args.indexOf('--name') + 1] = container;
    attemptedRun = true;
    await command('docker', [...args, '--label', `team.objlabs.dama.deployment=${job.id}`, image]);
    const port = await command('docker', ['port', container, plan.discoverPort.argv.at(-1)!]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(port);
    if (!match) throw new Error('Docker의 루프백 포트 할당을 확인할 수 없습니다.');
    const upstreamPort = Number(match[1]);
    await waitForHttp(`http://127.0.0.1:${upstreamPort}`, plan.healthCheck.path, plan.healthCheck.timeoutSeconds * 1000);

    phase = 'Nginx 전환';
    log(phase);
    const release: Release = { ...plan.nginxRoute, upstreamPort, container, healthPath: plan.healthCheck.path, deploymentId: job.id, image };
    candidate = release;
    const next = [...existing, { ...release, serviceId: job.serviceId }].sort((a, b) => a.serviceId.localeCompare(b.serviceId));
    if (await readInclude(config.include) !== before) throw new Error('빌드 도중 Nginx include가 변경되었습니다.');
    store.recordCandidate(job.id, release);
    await writeInclude(config.include, includeText(next));
    installed = true;
    await nginx(config, true);
    await Promise.all(next.map(route => waitForHttp(config.probeOrigin, route.healthPath, 10_000, route.deploymentId)));
    store.finishBuild(job.id, { release });
    log('배포 완료');
    return true;
  } catch (error) {
    // Restore before cleaning up the candidate so a failed restore cannot leave a dead upstream.
    if (installed && before !== undefined) {
      try {
        await writeInclude(config.include, before);
        await nginx(config, true);
        const previous = store.activeReleases().find(route => route.serviceId === job.serviceId);
        if (previous) await waitForHttp(config.probeOrigin, previous.healthPath, 10_000, previous.deploymentId);
        if (candidate && previous?.healthPath !== candidate.healthPath) {
          await waitForHttp(config.probeOrigin, candidate.healthPath, 10_000, job.id, true);
        }
      } catch (cause) {
        throw new Error('Nginx 복원을 확인하지 못했습니다. 워커를 중지한 상태에서 --recover로 복구하세요.', { cause });
      }
    }
    if (attemptedRun) await removeCandidate(job.id).catch(() => log('실패한 컨테이너 정리를 확인하세요.'));
    store.finishBuild(job.id, { error: `${phase} 실패` });
    log(`${phase} 실패`);
    throw error;
  } finally {
    if (checkout) await rm(checkout, { recursive: true, force: true }).catch(() => log('임시 체크아웃 정리를 확인하세요.'));
  }
}

export async function recoverDeployment(store: Store, config: WorkerConfig): Promise<void> {
  const id = store.runningBuildId();
  if (!id) throw new Error('복구할 실행 중 작업이 없습니다.');
  const previous = store.activeReleases();
  const candidate = store.runningCandidate(id);
  const current = await readInclude(config.include);
  if (current !== '' && !current.startsWith(includeHeader)) throw new Error('Dama가 관리하는 include 파일이 아닙니다.');
  await writeInclude(config.include, includeText(previous));
  await nginx(config, true);
  await Promise.all(previous.map(route => waitForHttp(config.probeOrigin, route.healthPath, 10_000, route.deploymentId)));
  if (candidate && !previous.some(route => route.healthPath === candidate.healthPath)) {
    await waitForHttp(config.probeOrigin, candidate.healthPath, 10_000, id, true);
  }
  // Keep the candidate for inspection and for requests draining after the reload.
  store.finishBuild(id, { error: '중단된 배포 복구' });
}

async function inspectActiveRelease(release: Release): Promise<Release> {
  const result = await command('docker', ['container', 'inspect', '--format', '{{json .}}', release.container], undefined, 5000);
  const container = JSON.parse(result) as {
    Image: string;
    State: { Running: boolean };
    Config: { Labels: Record<string, string> | null };
    NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
  };
  if (container.Config.Labels?.['team.objlabs.dama.deployment'] !== release.deploymentId || container.Image !== release.image) {
    throw new Error(`컨테이너 또는 이미지가 활성 배포 기록과 다릅니다: ${release.container}`);
  }
  const bindings = Object.values(container.NetworkSettings.Ports ?? {}).flatMap(ports => ports ?? []);
  const port = Number(bindings.find(binding => binding.HostIp === '127.0.0.1')?.HostPort);
  if (!container.State.Running || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`실행 중인 컨테이너와 루프백 포트를 확인할 수 없습니다: ${release.container}`);
  }
  await waitForHttp(`http://127.0.0.1:${port}`, release.healthPath, 30_000);
  return { ...release, upstreamPort: port };
}

// Called at startup by the single worker service, after Docker and Nginx are reachable.
export async function restoreAtStartup(store: Store, config: WorkerConfig): Promise<void> {
  const interrupted = store.runningBuildId();
  const active = store.activeReleases();
  const current = await readInclude(config.include);
  if (current !== '' && !current.startsWith(includeHeader)) throw new Error('Dama가 관리하는 include 파일이 아닙니다.');
  const refreshed = await Promise.all(active.map(inspectActiveRelease));
  const restored = includeText(refreshed);
  if (!refreshed.length && !interrupted && (current === '' || current === restored)) return;
  if (current !== restored) await writeInclude(config.include, restored);
  // A prior process may have updated the file without completing the reload.
  await nginx(config, true);
  await Promise.all(refreshed.map(route => waitForHttp(config.probeOrigin, route.healthPath, 10_000, route.deploymentId)));
  if (interrupted) {
    const candidate = store.runningCandidate(interrupted);
    if (candidate && !refreshed.some(route => route.healthPath === candidate.healthPath)) {
      await waitForHttp(config.probeOrigin, candidate.healthPath, 10_000, interrupted, true);
    }
  }
  store.refreshReleasePorts(refreshed);
  if (interrupted) store.finishBuild(interrupted, { error: '재시작 중 중단된 배포 복구' });
}
