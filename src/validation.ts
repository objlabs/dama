import type { JsonObject, ProjectInput, McpInput, BindingInput, ServiceInput, ServiceDeployment, DeployEnvironment, SharedKind } from './types.js';
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function fail(message: string): never { throw new HttpError(400, message); }
export function deploymentDomain(value: unknown, optional = false): string {
  const domain = text(value, '기본 배포 도메인', 253, optional).toLowerCase();
  if (!domain && optional) return '';
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain) ||
      /^[\d.]+$/.test(domain)) fail('기본 배포 도메인에는 DNS 호스트 이름만 입력하세요.');
  return domain;
}
export function commitSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value) || /^0{40}$/.test(value)) fail('전체 Git 커밋 SHA(40자리)를 입력하세요.');
  return value.toLowerCase();
}
export function text(value: unknown, label: string, max = 200, optional = false): string {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label}: 1~${max}자 문자열을 입력하세요.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${label}: 제어 문자는 사용할 수 없습니다.`);
  return value.trim();
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) fail(`${label}: ${values.join(', ')} 중 선택하세요.`);
  return value as T;
}
function url(value: unknown, label: string, optional = false): string {
  const input = text(value, label, 2048, optional);
  if (!input) return '';
  let parsed;
  try { parsed = new URL(input); } catch { fail(`${label}: 올바른 URL을 입력하세요.`); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail(`${label}: 인증 정보·쿼리·프래그먼트가 없는 HTTP(S) URL을 입력하세요.`);
  return parsed.href;
}
export function projectInput(body: JsonObject): ProjectInput {
  const domain = text(body.domain, '도메인', 253, true).toLowerCase();
  if (domain && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) fail('도메인에는 프로토콜·포트·경로 없이 호스트명만 입력하세요.');
  return {
    name: text(body.name, '프로젝트 이름', 80),
    kind: choice(body.kind, ['app', 'mcp'], '프로젝트 유형'),
    repository: url(body.repository, '저장소', true),
    branch: text(body.branch ?? 'main', '브랜치', 200),
    domain
  };
}
export function mcpInput(body: JsonObject): McpInput {
  const source = choice(body.source, ['external', 'managed'], 'MCP 출처');
  const credentialRef = text(body.credentialRef, '인증 참조', 128, true);
  if (credentialRef && !/^env:[A-Z_][A-Z0-9_]*$/.test(credentialRef)) fail('인증 정보 대신 env:MY_TOKEN 형식의 참조를 입력하세요.');
  return {
    name: text(body.name, 'MCP 이름', 80), source,
    transport: choice(body.transport, ['streamable-http'], '연결 방식'),
    endpoint: url(body.endpoint, 'MCP 연결 주소'),
    projectId: source === 'managed' ? text(body.projectId, '배포 프로젝트', 80) : null,
    serviceId: source === 'managed' && body.serviceId ? text(body.serviceId, '배포 서비스', 80) : null,
    credentialRef
  };
}
export function bindingInput(body: JsonObject): BindingInput {
  return {
    mcpId: text(body.mcpId, 'MCP', 80),
    policy: choice(body.policy, ['read-only', 'approval-required'], '권한 정책')
  };
}

export function repositoryPath(value: unknown, label: string, fallback = '.'): string {
  const path = text(value ?? fallback, label, 500);
  if (path === '.') return path;
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..') || path.startsWith('-')) fail(`${label}: 저장소 내부 상대 경로를 입력하세요.`);
  return path;
}
export function deployEnvironment(value: unknown): DeployEnvironment {
  return choice(value, ['dev', 'test', 'release'], '환경');
}

export function sharedKind(value: unknown): SharedKind {
  return choice(value, ['postgres', 'minio', 'redis'], '자원 유형');
}

export function databaseRef(input: unknown): string {
  const name = text(input, 'DB 연결 이름', 64, true);
  if (name && !/^[a-z][a-z0-9_-]*$/.test(name)) fail('DB 연결 이름은 영문 소문자로 시작해야 합니다.');
  return name;
}

function imageCommand(input: unknown, label: string): string[] {
  const args = input ?? [];
  if (!Array.isArray(args) || args.length > 24) fail(`${label}은 최대 24개 문자열을 사용하세요.`);
  const command = args.map(value => text(value, label, 300));
  if (command.length && (!/^[a-zA-Z0-9_./-]+$/.test(command[0]) || command[0].startsWith('-'))) {
    fail(`${label} 첫 항목에 이미지의 실행 파일을 지정하세요.`);
  }
  return command;
}

function serviceDeployment(value: unknown): ServiceDeployment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('배포 환경 설정을 확인하세요.');
  const item = value as JsonObject;
  const ref = databaseRef(item.databaseRef);
  const migration = imageCommand(item.migration, '마이그레이션 명령');
  const verification = imageCommand(item.verification, 'test 검증 명령');
  if (migration.length && !ref) fail('마이그레이션에 사용할 DB 연결을 지정하세요.');
  if (item.portableImage !== undefined && typeof item.portableImage !== 'boolean') fail('이미지 재사용 설정을 확인하세요.');
  return {
    portClass: choice(item.portClass, ['web', 'api'], '포트 유형'),
    environment: choice(item.environment, ['dev', 'test', 'release'], '배포 환경'),
    databaseRef: ref,
    ...(item.storageRef ? { storageRef: databaseRef(item.storageRef) } : {}),
    ...(item.redisRef ? { redisRef: databaseRef(item.redisRef) } : {}),
    migration, verification, portableImage: item.portableImage === true
  };
}

export function serviceInput(body: JsonObject): ServiceInput {
  const name = text(body.name, '서비스 이름', 63);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) fail('서비스 이름은 영문 소문자로 시작하고 소문자·숫자·하이픈을 사용하세요.');
  const routeSegment = text(body.routeSegment, '접속 경로', 63, true);
  if (routeSegment && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(routeSegment)) fail('접속 경로는 비우거나 api 같은 영문 소문자·숫자·하이픈 이름을 입력하세요.');
  if (typeof body.containerPort !== 'number' || !Number.isInteger(body.containerPort) || body.containerPort < 1 || body.containerPort > 65535) fail('컨테이너 포트는 1~65535 정수여야 합니다.');
  const healthPath = text(body.healthPath ?? '/health', '상태 확인 경로', 500);
  if (!/^\/(?:[a-zA-Z0-9_~.-]+\/?)*$/.test(healthPath) || healthPath.split('/').some(part => part === '.' || part === '..')) fail('상태 확인 경로는 /health 형식의 서비스 내부 경로여야 합니다.');
  const watchPaths = body.watchPaths ?? [];
  if (!Array.isArray(watchPaths) || watchPaths.length > 30) fail('변경 감지 경로는 최대 30개 배열이어야 합니다.');
  for (const path of watchPaths) {
    if (typeof path !== 'string' || path.length > 500 || !/^[a-zA-Z0-9_.*-]+(?:\/[a-zA-Z0-9_.*-]+)*$/.test(path) || path.split('/').some(part => part === '..' || part === '.')) fail('변경 감지 경로는 apps/api/** 같은 저장소 내부 경로여야 합니다.');
  }
  return {
    name, kind: choice(body.kind ?? 'app', ['app', 'mcp'], '서비스 유형'),
    language: choice(body.language, ['python', 'rust', 'typescript'], '언어'),
    sourcePath: repositoryPath(body.sourcePath, '소스 경로'),
    dockerfile: repositoryPath(body.dockerfile, 'Dockerfile 경로', 'Dockerfile'),
    buildContext: repositoryPath(body.buildContext, '빌드 컨텍스트'),
    containerPort: body.containerPort, routeSegment, healthPath, watchPaths,
    ...(body.deployment === undefined ? {} : { deployment: serviceDeployment(body.deployment) })
  };
}
