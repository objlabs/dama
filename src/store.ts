import type { SupportedValueType } from 'node:sqlite';
import type { Project, ProjectInput, Service, ServiceInput, ServiceRow, McpInput, McpServer, Binding, BindingInput, Activity, Snapshot, ResourceType, BuildJob, BuildJobSummary, ClaimedBuild, Release } from './types.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HttpError } from './validation.js';
import { projectAddress, serviceAddress } from './routing.js';
import { migrateDatabase, schemaVersion } from './migrations.js';
import { deploymentPlan } from './deployment-plan.js';

export function createStore(path: string) {
  const db = new DatabaseSync(path);
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
  const getProject = (id: string) => queryOne<Project>('SELECT * FROM projects WHERE id = ?', id);
  const getMcp = (id: string) => queryOne<Omit<McpServer, 'status'>>('SELECT * FROM mcps WHERE id = ?', id);
  const getService = (id: string) => queryOne<ServiceRow>('SELECT * FROM services WHERE id = ?', id);
  const formatService = (service: ServiceRow): Service => ({ ...service, watchPaths: JSON.parse(service.watchPaths) as string[], ...serviceAddress(service.projectId, service.routeSegment) });
  function requireRecord<T>(value: T | undefined): T { if (!value) throw new HttpError(404, '항목을 찾을 수 없습니다.'); return value; }
  function event(action: string, record: { id: string; name: string }): void {
    db.prepare('INSERT INTO events(action,resourceId,name,createdAt) VALUES (?,?,?,?)').run(action, record.id, record.name, new Date().toISOString());
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
    snapshot(): Snapshot {
      return {
        projects: queryAll<Project>('SELECT * FROM projects ORDER BY createdAt DESC, rowid DESC').map(project => ({ ...project, ...projectAddress(project.id) })),
        services: queryAll<ServiceRow>('SELECT * FROM services ORDER BY createdAt, rowid').map(formatService),
        mcps: queryAll<Omit<McpServer, 'status'>>('SELECT * FROM mcps ORDER BY createdAt DESC, rowid DESC').map(mcp => ({ ...mcp, status: 'unverified' })),
        bindings: queryAll<Binding>('SELECT * FROM bindings ORDER BY createdAt DESC'),
        events: queryAll<Activity>('SELECT * FROM events ORDER BY id DESC LIMIT 30'),
        buildJobs: queryAll<BuildJobSummary>('SELECT id, serviceId, commitSha, createdAt, status, active, error FROM build_jobs ORDER BY rowid'),
        capabilities: { deployment: false, mcpExecution: false, authentication: false }
      };
    },
    createProject(input: ProjectInput) { return transaction(() => {
      const record = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)').run(record.id, record.name, record.kind, record.repository, record.branch, record.domain, record.createdAt);
      event('project.created', record); return { ...record, ...projectAddress(record.id) };
    }); },
    createMcp(input: McpInput) { return transaction(() => {
      validateManaged(input);
      const record = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO mcps(id,name,source,transport,endpoint,projectId,credentialRef,createdAt,serviceId) VALUES (?,?,?,?,?,?,?,?,?)').run(record.id, record.name, record.source, record.transport, record.endpoint, record.projectId, record.credentialRef, record.createdAt, record.serviceId ?? null);
      event('mcp.created', record); return { ...record, status: 'unverified' as const };
    }); },
    getService(id: string) { return formatService(requireRecord(getService(id))); },
    getProject(id: string) { return requireRecord(getProject(id)); },
    enqueueBuild(serviceId: string, commitSha: string): BuildJob {
      return transaction(() => {
        const service = formatService(requireRecord(getService(serviceId)));
        const project = requireRecord(getProject(service.projectId));
        if (!project.repository) throw new HttpError(400, '빌드하려면 프로젝트에 Git 저장소를 등록하세요.');
        const plan = deploymentPlan(project, service);
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
        const row = queryOne<BuildJobSummary & { source: string; build: string; plan: string | null }>(
          "SELECT * FROM build_jobs WHERE status='queued' ORDER BY rowid LIMIT 1"
        );
        if (!row) return;
        db.prepare("UPDATE build_jobs SET status='running' WHERE id=?").run(row.id);
        return {
          ...row, status: 'running',
          source: JSON.parse(row.source) as BuildJob['source'],
          build: JSON.parse(row.build) as BuildJob['build'],
          plan: row.plan ? JSON.parse(row.plan) as ClaimedBuild['plan'] : null
        };
      });
    },
    runningBuildId(): string | undefined {
      return queryOne<{ id: string }>("SELECT id FROM build_jobs WHERE status='running'")?.id;
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
      db.prepare('INSERT INTO services VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(record.id, projectId, input.name, input.kind, input.language, input.sourcePath, input.dockerfile, input.buildContext, input.containerPort, input.routeSegment, input.healthPath, JSON.stringify(input.watchPaths), record.createdAt, record.createdAt);
      event('service.created', record); return formatService(requireRecord(getService(record.id)));
    }); },
    updateService(id: string, input: ServiceInput) { return transaction(() => {
      const previous = requireRecord(getService(id));
      if (input.kind !== 'mcp' && db.prepare('SELECT id FROM mcps WHERE serviceId = ?').get(id)) throw new HttpError(409, 'MCP 등록에 사용 중인 서비스는 앱 유형으로 바꿀 수 없습니다.');
      db.prepare('UPDATE services SET name=?,kind=?,language=?,sourcePath=?,dockerfile=?,buildContext=?,containerPort=?,routeSegment=?,healthPath=?,watchPaths=?,updatedAt=? WHERE id=?').run(input.name, input.kind, input.language, input.sourcePath, input.dockerfile, input.buildContext, input.containerPort, input.routeSegment, input.healthPath, JSON.stringify(input.watchPaths), new Date().toISOString(), previous.id);
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
