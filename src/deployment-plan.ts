import type { Project, Service, DeploymentPlan } from './types.js';
import { randomUUID } from 'node:crypto';
import { serviceAddress } from './routing.js';

// A reviewable plan only; the web process does not run Git, Docker or Nginx.
export function deploymentPlan(project: Project, service: Service): DeploymentPlan {
  const { basePath, defaultUrl } = service;
  const tag = `dama/${service.id}:${randomUUID()}`;
  const container = `dama-${service.id}-${randomUUID().slice(0, 8)}`;
  const settings = service.deployment ?? {
    portClass: service.kind === 'mcp' || service.routeSegment === 'api' || service.name.endsWith('-api') || service.name === 'api' ? 'api' : 'web',
    environment: 'dev', databaseRef: '', migration: [], portableImage: false
  } satisfies NonNullable<Service['deployment']>;
  const healthPath = basePath + (service.healthPath === '/' ? '/' : service.healthPath);
  return {
    mode: 'preview', executableByApi: false,
    projectId: project.id, serviceId: service.id, language: service.language,
    source: { repository: project.repository, branch: project.branch, sourcePath: service.sourcePath, commit: null },
    basePath, defaultUrl, settings,
    build: {
      cwd: 'repository-root',
      argv: ['docker', 'build', '--file', service.dockerfile, ...settings.portableImage ? [] : ['--build-arg', `DAMA_BASE_PATH=${basePath}`], '--tag', tag, service.buildContext]
    },
    run: {
      argv: ['docker', 'run', '--detach', '--name', container, '--restart', 'unless-stopped', '--label', `team.objlabs.dama.service=${service.id}`, '--publish', `127.0.0.1:<available-port>:${service.containerPort}`, '--env', `DAMA_BASE_PATH=${basePath}`, '--env', `PORT=${service.containerPort}`, tag]
    },
    discoverPort: { argv: ['docker', 'port', container, `${service.containerPort}/tcp`] },
    healthCheck: { path: healthPath, origin: 'http://127.0.0.1:<available-port>', timeoutSeconds: 30 },
    nginxRoute: { projectId: project.id, routeSegment: service.routeSegment, upstreamPort: null },
    watchPaths: service.watchPaths,
    requirements: [
      'Dockerfile과 빌드 컨텍스트는 체크아웃한 저장소 루트 기준 상대 경로입니다.',
      '실제 실행 전 브랜치를 불변 커밋 SHA로 고정해야 합니다.',
      'Dockerfile과 앱이 DAMA_BASE_PATH 및 PORT를 반영해야 합니다.',
      '웹앱은 3999부터, API는 4999부터 각 범위에서 포트 번호를 낮춰 빈 호스트 포트를 찾습니다.',
      '변경 감지 경로는 저장만 하며 자동 트리거와 의존성 분석은 아직 실행하지 않습니다.'
    ]
  };
}
