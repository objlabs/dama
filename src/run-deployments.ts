import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from './store.js';
import { deployNext, recoverDeployment, restoreAtStartup, waitForDeploymentDependencies } from './deploy-worker.js';
import { deploymentHost } from './routing.js';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? '--once';
  if (!['--once', '--watch', '--boot-watch', '--recover'].includes(mode) || process.argv.length > 3) {
    throw new Error('사용법: npm run deploy:worker -- [--once|--watch|--boot-watch|--recover]');
  }
  const watching = mode === '--watch' || mode === '--boot-watch';
  const { DAMA_NGINX_INCLUDE, DAMA_NGINX_CONFIG, DAMA_NGINX_PROBE } = process.env;
  if (!DAMA_NGINX_INCLUDE || !DAMA_NGINX_CONFIG) throw new Error('DAMA_NGINX_INCLUDE과 DAMA_NGINX_CONFIG를 지정하세요.');
  const probe = new URL(DAMA_NGINX_PROBE ?? `https://${deploymentHost}`);
  if (probe.href !== probe.origin + '/' || !(probe.protocol === 'https:' || probe.protocol === 'http:' && probe.hostname === '127.0.0.1')) {
    throw new Error('검증 주소는 HTTPS origin 또는 로컬 127.0.0.1 HTTP origin이어야 합니다.');
  }
  const config = { include: resolve(DAMA_NGINX_INCLUDE), nginxConfig: resolve(DAMA_NGINX_CONFIG), probeOrigin: probe.origin };
  const store = createStore(resolve(process.env.DAMA_DB ?? 'data/dama.sqlite'));
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });
  try {
    if (mode === '--recover') {
      await recoverDeployment(store, config);
      console.log('이전 배포 설정 복구 완료');
      return;
    }
    if (watching && !await waitForDeploymentDependencies(config, () => stopping)) return;
    if (mode === '--boot-watch') {
      await restoreAtStartup(store, config);
      console.log('기존 배포 확인 완료');
      if (stopping) return;
    }
    do {
      try {
        if (!await deployNext(store, config)) {
          if (mode === '--once') console.log('대기 중인 빌드가 없습니다.');
          else await delay(1000);
        }
      } catch (error) {
        if (mode === '--once' || store.runningBuildId()) throw error;
        console.error(error instanceof Error ? error.message : error);
      }
    } while (watching && !stopping);
  } finally {
    store.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
