import type { SupportedValueType } from 'node:sqlite';
import type { ForgejoSettings, NginxSite } from './types.js';
import type { Project, ProjectInput, ProjectView, GitAuth, GitAuthSummary, Service, ServiceInput, ServiceRow, McpInput, McpServer, Binding, BindingInput, Activity, Snapshot, ResourceType, BuildJob, BuildJobSummary, ClaimedBuild, Release, BuildEvidence, DeploymentPlan, SharedResource, SharedKind, DeployEnvironment } from './types.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { deploymentDomain, HttpError } from './validation.js';
import { configuredDeploymentDomain, projectAddress, serviceAddress } from './routing.js';
import { migrateDatabase, schemaVersion } from './migrations.js';
import { deploymentPlan } from './deployment-plan.js';
import { gitSecrets } from './git-secrets.js';

export function createStore(path: string) {
  const installedDomain = configuredDeploymentDomain();
  const domainEditable = !installedDomain && !process.env.DAMA_NGINX_CONFIG;
  const db = new DatabaseSync(path);
  const secrets = gitSecrets(path);
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version > schemaVersion) { db.close(); throw new Error('현재 앱보다 새로운 데이터베이스 버전입니다.'); }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      kind TEXT NOT NULL CHECK(kind IN ('app','mcp')),
      repository TEXT NOT NULL, branch TEXT NOT NULL, domain TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_domain ON projects(domain) WHERE domain != '';
    CREATE TABLE IF NOT EXISTS mcps (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      source TEXT NOT NULL CHECK(source IN ('external','managed')),
      transport TEXT NOT NULL CHECK(transport = 'streamable-http'), endpoint TEXT NOT NULL,
      projectId TEXT REFERENCES projects(id) ON DELETE RESTRICT,
      credentialRef TEXT NOT NULL, createdAt TEXT NOT NULL,
      CHECK((source = 'managed' AND projectId IS NOT NULL) OR (source = 'external' AND projectId IS NULL))
    );
    CREATE TABLE IF NOT EXISTS bindings (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      mcpId TEXT NOT NULL REFERENCES mcps(id) ON DELETE CASCADE,
      policy TEXT NOT NULL CHECK(policy IN ('read-only','approval-required')),
      createdAt TEXT NOT NULL, UNIQUE(projectId,mcpId)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
      resourceId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL
    );
  `);
  try { migrateDatabase(db); }
  catch (error) { db.close(); throw error; }
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) {
      db.exec('ROLLBACK');
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ERR_SQLITE') && /UNIQUE constraint/.test(error.message)) throw new HttpError(409, '같은 이름·도메인 또는 MCP 연결이 이미 존재합니다.');
      throw error;
    }
  }
  // SQLite returns untyped column maps. Keep schema assertions at this boundary.
  const queryOne = <T>(sql: string, ...params: SupportedValueType[]): T | undefined => db.prepare(sql).get(...params) as unknown as T | undefined;
  const queryAll = <T>(sql: string): T[] => db.prepare(sql).all() as unknown as T[];
  const getDeploymentDomain = () => installedDomain || queryOne<{ domain: string }>('SELECT domain FROM deployment_settings WHERE id=1')!.domain;
  const getProject = (id: string) => queryOne<Project>('SELECT * FROM projects WHERE id = ?', id);
  const getMcp = (id: string) => queryOne<Omit<McpServer, 'status'>>('SELECT * FROM mcps WHERE id = ?', id);
  const getService = (id: string) => queryOne<ServiceRow>('SELECT * FROM services WHERE id = ?', id);
  const formatService = (service: ServiceRow): Service => {
    const { deployment, ...rest } = service;
    const settings = JSON.parse(deployment) as Service['deployment'];
    return { ...rest, ...(settings?.environment ? { deployment: settings } : {}),
      watchPaths: JSON.parse(service.watchPaths) as string[], ...serviceAddress(service.projectId, service.routeSegment, getDeploymentDomain()) };
  };
  const withEvidence = <T extends { evidence: string | null }>(row: T) => ({
    ...row, evidence: row.evidence ? JSON.parse(row.evidence) as BuildEvidence : null
  });
  function requireRecord<T>(value: T | undefined): T { if (!value) throw new HttpError(404, '항목을 찾을 수 없습니다.'); return value; }
  function event(action: string, record: { id: string; name: string }): void {
    db.prepare('INSERT INTO events(action,resourceId,name,createdAt) VALUES (?,?,?,?)').run(action, record.id, record.name, new Date().toISOString());
  }
  function authSummary(id: string): GitAuthSummary | null {
    const row = queryOne<GitAuthSummary>('SELECT provider, username FROM project_git_auth WHERE projectId=?', id);
    return row ? { provider: row.provider, username: row.username } : null;
  }
  function projectView(record: Project): ProjectView {
    return { ...record, ...projectAddress(record.id, getDeploymentDomain()), gitAuth: authSummary(record.id) };
  }
  const hasSecrets = () => Boolean(queryOne('SELECT id FROM shared_resources UNION ALL SELECT projectId FROM project_git_auth UNION ALL SELECT id FROM forgejo_settings WHERE ciphertext IS NOT NULL LIMIT 1'));
  const forgejoSettings = () => queryOne<ForgejoSettings>('SELECT dataPath, port, owner FROM forgejo_settings WHERE id=1') ?? null;
  const forgejoOrigin = () => {
    const settings = forgejoSettings();
    return settings ? `http://127.0.0.1:${settings.port}` : undefined;
  };
  type ResourceRow = Omit<SharedResource, 'ready'> & { ready: number; ciphertext: string };
  const resourceColumns = 'id, projectId, environment, kind, name, ready';
  function resourceView(row: Omit<ResourceRow, 'ciphertext'>): SharedResource {
    return { ...row, ready: row.ready === 1 };
  }
  function resourceSecret(row: ResourceRow): [string, string] {
    return JSON.parse(secrets.decrypt(row.ciphertext, JSON.stringify(['shared-resource', row.id]))) as [string, string];
  }
  function authScope(project: Pick<Project, 'id' | 'repository'>, auth: GitAuthSummary): string {
    return JSON.stringify([project.id, project.repository, auth.provider, auth.username]);
  }
  function saveAuth(project: Project, auth: GitAuth): void {
    const allowKeyCreation = !hasSecrets();
    const ciphertext = secrets.encrypt(auth.token, authScope(project, auth), allowKeyCreation);
    db.prepare(`
      INSERT INTO project_git_auth(projectId, provider, username, ciphertext) VALUES (?, ?, ?, ?)
      ON CONFLICT(projectId) DO UPDATE SET provider=excluded.provider, username=excluded.username, ciphertext=excluded.ciphertext
    `).run(project.id, auth.provider, auth.username, ciphertext);
  }
  function validateManaged(input: McpInput): void {
    if (input.source !== 'managed') return;
    const project = requireRecord(getProject(input.projectId ?? ''));
    if (input.serviceId) {
      const service = requireRecord(getService(input.serviceId));
      if (service.projectId !== project.id || service.kind !== 'mcp') throw new HttpError(400, '해당 프로젝트의 MCP 유형 서비스를 선택하세요.');
    } else if (project.kind !== 'mcp') throw new HttpError(400, 'MCP 유형 프로젝트 또는 MCP 서비스를 선택하세요.');
  }
  return {
    getDeploymentDomain,
    setDeploymentDomain(value: unknown) {
      if (!domainEditable) throw new HttpError(409, '운영 서버의 기본 도메인은 설치 설정에서 관리합니다.');
      const domain = deploymentDomain(value, true);
      db.prepare('UPDATE deployment_settings SET domain=? WHERE id=1').run(domain);
      return domain;
    },
    nginxBindAddress() {
      return queryOne<{ bindAddress: string }>('SELECT bindAddress FROM nginx_state WHERE id=1')!.bindAddress;
    },
    setNginxBindAddress(address: string) {
      db.prepare('UPDATE nginx_state SET bindAddress=? WHERE id=1').run(address);
    },
    nginxState() {
      const row = queryOne<{ draft: string; applied: string; previous: string | null }>('SELECT draft,applied,previous FROM nginx_state WHERE id=1')!;
      return {
        sites: JSON.parse(row.draft) as NginxSite[], applied: JSON.parse(row.applied) as NginxSite[],
        previous: row.previous === null ? null : JSON.parse(row.previous) as NginxSite[]
      };
    },
    saveNginxSites(sites: NginxSite[]) {
      db.prepare('UPDATE nginx_state SET draft=? WHERE id=1').run(JSON.stringify(sites));
    },
    applyNginxSites(sites: NginxSite[], rollback: boolean) {
      const value = JSON.stringify(sites);
      db.prepare(`UPDATE nginx_state SET previous=applied, applied=?${rollback ? ', draft=?' : ''} WHERE id=1`)
        .run(value, ...(rollback ? [value] : []));
    },
    forgejoSettings,
    forgejoOrigin,
    configureForgejo(dataPath: string, port: number) {
      return transaction(() => {
        db.prepare('INSERT OR IGNORE INTO forgejo_settings(id,dataPath,port) VALUES(1,?,?)').run(dataPath, port);
        return forgejoSettings()!;
      });
    },
    setForgejoPort(previous: number, port: number) {
      db.prepare('UPDATE forgejo_settings SET port=? WHERE id=1 AND port=? AND owner IS NULL').run(port, previous);
      return forgejoSettings()!;
    },
    setForgejoToken(owner: string | null, token?: string) {
      transaction(() => {
        const ciphertext = owner && token ? secrets.encrypt(token, JSON.stringify(['forgejo', owner]), !hasSecrets()) : null;
        db.prepare('UPDATE forgejo_settings SET owner=?, ciphertext=? WHERE id=1').run(owner, ciphertext);
      });
    },
    getForgejoToken() {
      const row = queryOne<{ owner: string; ciphertext: string }>('SELECT owner,ciphertext FROM forgejo_settings WHERE id=1 AND ciphertext IS NOT NULL');
      if (!row) return;
      try { return { owner: row.owner, token: secrets.decrypt(row.ciphertext, JSON.stringify(['forgejo', row.owner])) }; }
      catch { throw new HttpError(503, 'Forgejo 관리 토큰을 읽지 못했습니다. 서버의 Git 키 파일을 확인하세요.'); }
    },
    snapshot(): Snapshot {
      return {
        deploymentDomain: { domain: getDeploymentDomain(), editable: domainEditable },
        projects: queryAll<Project>('SELECT * FROM projects ORDER BY createdAt DESC, rowid DESC').map(projectView),
        services: queryAll<ServiceRow>('SELECT * FROM services ORDER BY createdAt, rowid').map(formatService),
        mcps: queryAll<Omit<McpServer, 'status'>>('SELECT * FROM mcps ORDER BY createdAt DESC, rowid DESC').map(mcp => ({ ...mcp, status: 'unverified' })),
        bindings: queryAll<Binding>('SELECT * FROM bindings ORDER BY createdAt DESC'),
        events: queryAll<Activity>('SELECT * FROM events ORDER BY id DESC LIMIT 30'),
        buildJobs: queryAll<Omit<BuildJobSummary, 'evidence'> & { evidence: string | null }>("SELECT id, serviceId, commitSha, createdAt, status, active, error, evidence, CASE WHEN active=1 THEN json_extract(release, '$.upstreamPort') END AS hostPort FROM build_jobs ORDER BY rowid").map(withEvidence),
        capabilities: { deployment: false, mcpExecution: false, authentication: false }
      };
    },
    createProject(input: ProjectInput, auth?: GitAuth) { return transaction(() => {
      const record = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)').run(record.id, record.name, record.kind, record.repository, record.branch, record.domain, record.createdAt);
      if (auth) saveAuth(record, auth);
      event('project.created', record);
      return projectView(record);
    }); },
    setGitAuth(projectId: string, auth: GitAuth | null): GitAuthSummary | null {
      return transaction(() => {
        const project = requireRecord(getProject(projectId));
        if (auth) {
          saveAuth(project, auth);
          event('project.git_auth_saved', project);
        } else if (db.prepare('DELETE FROM project_git_auth WHERE projectId=?').run(projectId).changes) {
          event('project.git_auth_deleted', project);
        }
        return authSummary(projectId);
      });
    },
    getGitAuth(projectId: string, repository: string): GitAuth | undefined {
      const row = queryOne<GitAuthSummary & { ciphertext: string; repository: string }>(`
        SELECT a.provider, a.username, a.ciphertext, p.repository FROM project_git_auth a JOIN projects p
        ON p.id=a.projectId WHERE a.projectId=?`, projectId);
      if (!row || row.repository !== repository) return;
      const scope = authScope({ id: projectId, repository }, row);
      try { return { provider: row.provider, username: row.username, token: secrets.decrypt(row.ciphertext, scope) }; }
      catch { throw new HttpError(503, '저장된 Git 인증을 읽지 못했습니다. 서버의 Git 키 파일을 확인하세요.'); }
    },
    listSharedResources(): SharedResource[] {
      return queryAll<Omit<ResourceRow, 'ciphertext'>>(`SELECT ${resourceColumns} FROM shared_resources ORDER BY environment, name, kind`).map(resourceView);
    },
    ensureSharedResource(projectId: string, environment: DeployEnvironment, kind: SharedKind) {
      return transaction(() => {
        const project = requireRecord(getProject(projectId));
        const previous = queryOne<ResourceRow>('SELECT * FROM shared_resources WHERE projectId=? AND environment=? AND kind=?', projectId, environment, kind);
        if (previous) {
          const { ciphertext, ...metadata } = previous;
          return { resource: resourceView(metadata), secret: resourceSecret({ ...metadata, ciphertext }) };
        }
        const name = `dama_${project.id.replaceAll('-', '')}`;
        const id = `${kind}-${environment}-${project.id}`;
        const secret: [string, string] = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')];
        const ciphertext = secrets.encrypt(JSON.stringify(secret), JSON.stringify(['shared-resource', id]), !hasSecrets());
        db.prepare('INSERT INTO shared_resources(id, projectId, environment, kind, name, ciphertext) VALUES(?,?,?,?,?,?)')
          .run(id, projectId, environment, kind, name, ciphertext);
        return { resource: { id, projectId, environment, kind, name, ready: false }, secret };
      });
    },
    finishSharedResource(id: string): SharedResource {
      return transaction(() => {
        const row = requireRecord(queryOne<Omit<ResourceRow, 'ciphertext'>>(`SELECT ${resourceColumns} FROM shared_resources WHERE id=?`, id));
        if (!row.ready) {
          db.prepare('UPDATE shared_resources SET ready=1 WHERE id=?').run(id);
          event('shared_resource.created', { id, name: row.name });
        }
        return resourceView({ ...row, ready: 1 });
      });
    },
    sharedResourceBinding(id: string, projectId: string, environment: DeployEnvironment, kind: SharedKind) {
      const row = queryOne<ResourceRow>('SELECT * FROM shared_resources WHERE id=?', id);
      if (!row) return undefined;
      if (row.projectId !== projectId || row.environment !== environment || row.kind !== kind || !row.ready) {
        throw new HttpError(400, '준비된 현재 프로젝트·환경의 공용 자원을 선택하세요.');
      }
      const { ciphertext, ...metadata } = row;
      return { resource: resourceView(metadata), secret: resourceSecret({ ...metadata, ciphertext }) };
    },
    createMcp(input: McpInput) { return transaction(() => {
      validateManaged(input);
      const record = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO mcps(id,name,source,transport,endpoint,projectId,credentialRef,createdAt,serviceId) VALUES (?,?,?,?,?,?,?,?,?)').run(record.id, record.name, record.source, record.transport, record.endpoint, record.projectId, record.credentialRef, record.createdAt, record.serviceId ?? null);
      event('mcp.created', record); return { ...record, status: 'unverified' as const };
    }); },
    getService(id: string) { return formatService(requireRecord(getService(id))); },
    getProject(id: string) { return requireRecord(getProject(id)); },
    enqueueBuild(serviceId: string, commitSha: string, promoteJobId?: string): BuildJob {
      return transaction(() => {
        const service = formatService(requireRecord(getService(serviceId)));
        const project = requireRecord(getProject(service.projectId));
        if (!project.repository) throw new HttpError(400, '빌드하려면 프로젝트에 Git 저장소를 등록하세요.');
        const plan = deploymentPlan(project, service);
        if (plan.settings?.environment === 'release' && plan.settings.portableImage && !promoteJobId) {
          throw new HttpError(400, 'release 배포에는 검증된 test 이미지를 선택하세요.');
        }
        if (promoteJobId) {
          const previous = queryOne<{ commitSha: string; plan: string; evidence: string }>(
            "SELECT commitSha, plan, evidence FROM build_jobs WHERE id=? AND status='deployed'", promoteJobId);
          const testPlan = previous?.plan ? JSON.parse(previous.plan) as DeploymentPlan : null;
          const evidence = previous?.evidence ? JSON.parse(previous.evidence) as BuildEvidence : null;
          const buildArgs = (item: DeploymentPlan) => item.build.argv.filter((_, i) => i !== item.build.argv.indexOf('--tag') + 1);
          if (!testPlan || !evidence?.verifiedAt || !/^sha256:[a-f0-9]{64}$/.test(evidence.image) ||
              previous?.commitSha !== commitSha || testPlan.projectId !== project.id ||
              testPlan.source.repository !== plan.source.repository || testPlan.source.sourcePath !== plan.source.sourcePath ||
              plan.settings?.environment !== 'release' || testPlan.settings?.environment !== 'test' ||
              !plan.settings.portableImage || !testPlan.settings.portableImage ||
              JSON.stringify(buildArgs(testPlan)) !== JSON.stringify(buildArgs(plan))) {
            throw new HttpError(400, '동일 프로젝트·커밋·빌드 설정의 검증된 test 이미지를 선택하세요.');
          }
          plan.promotion = { jobId: promoteJobId, image: evidence.image };
        }
        const source = { repository: plan.source.repository, branch: plan.source.branch, sourcePath: plan.source.sourcePath };
        const job: BuildJob = { id: randomUUID(), serviceId, commitSha, source, build: plan.build, createdAt: new Date().toISOString(), status: 'queued', active: 0, error: null };
        const inserted = db.prepare(`
          INSERT INTO build_jobs(id, serviceId, commitSha, source, build, createdAt, plan) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(serviceId, commitSha) WHERE status IN ('queued','running') DO NOTHING
        `).run(job.id, serviceId, commitSha, JSON.stringify(job.source), JSON.stringify(job.build), job.createdAt, JSON.stringify(plan));
        if (!inserted.changes) throw new HttpError(409, '같은 서비스와 커밋이 이미 대기열에 있습니다.');
        event('build.queued', { id: job.id, name: service.name });
        return job;
      });
    },
    cancelBuild(id: string): void {
      transaction(() => {
        const job = requireRecord(queryOne<{ name: string; status: string }>('SELECT services.name, build_jobs.status FROM build_jobs JOIN services ON services.id = build_jobs.serviceId WHERE build_jobs.id = ?', id));
        if (job.status !== 'queued') throw new HttpError(409, '대기 중인 작업만 취소할 수 있습니다.');
        db.prepare('DELETE FROM build_jobs WHERE id = ?').run(id);
        event('build.cancelled', { id, name: job.name });
      });
    },
    claimBuild(): ClaimedBuild | undefined {
      return transaction(() => {
        if (queryOne("SELECT id FROM build_jobs WHERE status='running'")) throw new HttpError(409, '실행 중인 작업이 있습니다.');
        const row = queryOne<Omit<BuildJobSummary, 'evidence'> & { evidence: string | null; source: string; build: string; plan: string | null }>(
          "SELECT * FROM build_jobs WHERE status='queued' ORDER BY rowid LIMIT 1"
        );
        if (!row) return;
        db.prepare("UPDATE build_jobs SET status='running' WHERE id=?").run(row.id);
        return {
          ...withEvidence(row), status: 'running',
          source: JSON.parse(row.source) as BuildJob['source'],
          build: JSON.parse(row.build) as BuildJob['build'],
          plan: row.plan ? JSON.parse(row.plan) as ClaimedBuild['plan'] : null
        };
      });
    },
    runningBuildId(): string | undefined {
      return queryOne<{ id: string }>("SELECT id FROM build_jobs WHERE status='running'")?.id;
    },
    recordEvidence(id: string, evidence: BuildEvidence): void {
      if (!db.prepare("UPDATE build_jobs SET evidence=? WHERE id=? AND status='running'").run(JSON.stringify(evidence), id).changes) {
        throw new Error('실행 중인 배포를 찾을 수 없습니다.');
      }
    },
    recordCandidate(id: string, release: Release): void {
      const result = db.prepare("UPDATE build_jobs SET release=? WHERE id=? AND status='running'")
        .run(JSON.stringify(release), id);
      if (!result.changes) throw new Error('실행 중인 배포를 찾을 수 없습니다.');
    },
    runningCandidate(id: string): Release | undefined {
      const row = queryOne<{ release: string | null }>("SELECT release FROM build_jobs WHERE id=? AND status='running'", id);
      return row?.release ? JSON.parse(row.release) as Release : undefined;
    },
    activeReleases(): (Release & { serviceId: string })[] {
      return queryAll<{ release: string; serviceId: string }>('SELECT release,serviceId FROM build_jobs WHERE active=1 ORDER BY serviceId')
        .map(row => ({ ...JSON.parse(row.release) as Release, serviceId: row.serviceId }));
    },
    refreshReleasePorts(releases: Release[]): void {
      transaction(() => {
        const update = db.prepare("UPDATE build_jobs SET release=json_set(release, '$.upstreamPort', ?) WHERE id=? AND active=1");
        for (const release of releases) {
          if (!update.run(release.upstreamPort, release.deploymentId).changes) {
            throw new Error('복구 중 활성 배포가 변경되었습니다.');
          }
        }
      });
    },
    finishBuild(id: string, result: { release: Release } | { error: string }): void {
      transaction(() => {
        const job = requireRecord(queryOne<{ serviceId: string; name: string }>(`
          SELECT build_jobs.serviceId, services.name FROM build_jobs JOIN services
          ON services.id=build_jobs.serviceId WHERE build_jobs.id=? AND build_jobs.status='running'
        `, id));
        if ('release' in result) {
          db.prepare('UPDATE build_jobs SET active=0 WHERE serviceId=? AND active=1').run(job.serviceId);
          db.prepare("UPDATE build_jobs SET status='deployed',release=?,active=1 WHERE id=?").run(JSON.stringify(result.release), id);
          event('build.deployed', { id, name: job.name });
        } else {
          db.prepare("UPDATE build_jobs SET status='failed',error=? WHERE id=?").run(result.error, id);
          event('build.failed', { id, name: job.name });
        }
      });
    },
    createService(projectId: string, input: ServiceInput) { return transaction(() => {
      requireRecord(getProject(projectId));
      const record = { id: randomUUID(), projectId, ...input, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO services(id,projectId,name,kind,language,sourcePath,dockerfile,buildContext,containerPort,routeSegment,healthPath,watchPaths,createdAt,updatedAt,deployment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(record.id, projectId, input.name, input.kind, input.language, input.sourcePath, input.dockerfile, input.buildContext, input.containerPort, input.routeSegment, input.healthPath, JSON.stringify(input.watchPaths), record.createdAt, record.createdAt, JSON.stringify(input.deployment ?? {}));
      event('service.created', record); return formatService(requireRecord(getService(record.id)));
    }); },
    updateService(id: string, input: ServiceInput) { return transaction(() => {
      const previous = requireRecord(getService(id));
      if (input.kind !== 'mcp' && db.prepare('SELECT id FROM mcps WHERE serviceId = ?').get(id)) throw new HttpError(409, 'MCP 등록에 사용 중인 서비스는 앱 유형으로 바꿀 수 없습니다.');
      db.prepare('UPDATE services SET name=?,kind=?,language=?,sourcePath=?,dockerfile=?,buildContext=?,containerPort=?,routeSegment=?,healthPath=?,watchPaths=?,updatedAt=?,deployment=? WHERE id=?').run(input.name, input.kind, input.language, input.sourcePath, input.dockerfile, input.buildContext, input.containerPort, input.routeSegment, input.healthPath, JSON.stringify(input.watchPaths), new Date().toISOString(), JSON.stringify(input.deployment ?? JSON.parse(previous.deployment)), previous.id);
      event('service.updated', { id, name: input.name }); return formatService(requireRecord(getService(id)));
    }); },
    bind(projectId: string, input: BindingInput) { return transaction(() => {
      const project = requireRecord(getProject(projectId));
      const mcp = requireRecord(getMcp(input.mcpId));
      const record = { id: randomUUID(), projectId, ...input, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO bindings VALUES (?,?,?,?,?)').run(record.id, projectId, record.mcpId, record.policy, record.createdAt);
      event('binding.created', { id: record.id, name: `${project.name} → ${mcp.name}` }); return record;
    }); },
    remove(type: ResourceType, id: string) { return transaction(() => {
      const table = { projects: 'projects', services: 'services', mcps: 'mcps', bindings: 'bindings' }[type];
      if (!table) throw new HttpError(404, '항목을 찾을 수 없습니다.');
      const record = requireRecord(queryOne<{ id: string; name?: string }>(`SELECT * FROM ${table} WHERE id = ?`, id));
      if (type === 'projects' && queryOne('SELECT id FROM shared_resources WHERE projectId=?', id)) throw new HttpError(409, '이 프로젝트의 공용 자원과 데이터를 먼저 정리하세요.');
      if (type === 'projects' && db.prepare('SELECT id FROM mcps WHERE projectId = ?').get(id)) throw new HttpError(409, '이 프로젝트가 제공하는 MCP를 먼저 삭제하세요.');
      if (type === 'services' && db.prepare('SELECT id FROM mcps WHERE serviceId = ?').get(id)) throw new HttpError(409, '이 서비스를 제공자로 등록한 MCP를 먼저 삭제하세요.');
      if (type === 'services' || type === 'projects') {
        const scope = type === 'services' ? 'services.id' : 'services.projectId';
        const live = queryOne(`SELECT build_jobs.id FROM build_jobs JOIN services ON services.id=build_jobs.serviceId
          WHERE ${scope}=? AND (build_jobs.active=1 OR build_jobs.status='running')`, id);
        if (live) throw new HttpError(409, '실행 중인 배포 또는 활성 서비스 경로가 있습니다.');
      }
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      event(`${type}.deleted`, { id, name: record.name ?? 'MCP 연결' });
    }); },
    close() { db.close(); }
  };
}

export type Store = ReturnType<typeof createStore>;
