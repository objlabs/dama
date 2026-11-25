import { schemaVersion } from '../src/migrations.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../src/store.js';

const projectId = '00000000-0000-4000-8000-000000000001';
test('v1 migration retains projects, MCPs, bindings and events and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dama-migration-')); const path = join(dir, 'v1.sqlite');
  let store;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, kind TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL, domain TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE mcps(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, source TEXT NOT NULL, transport TEXT NOT NULL, endpoint TEXT NOT NULL, projectId TEXT REFERENCES projects(id) ON DELETE RESTRICT, credentialRef TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE bindings(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, mcpId TEXT NOT NULL REFERENCES mcps(id) ON DELETE CASCADE, policy TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(projectId,mcpId));
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, resourceId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
      INSERT INTO projects VALUES ('${projectId}','legacy','mcp','','main','','2026-11-10T00:00:00Z');
      INSERT INTO mcps VALUES ('mcp-old','legacy-mcp','managed','streamable-http','https://example.com/mcp','${projectId}','','2026-11-10T00:00:00Z');
      INSERT INTO bindings VALUES ('binding-old','${projectId}','mcp-old','read-only','2026-11-10T00:00:00Z');
      INSERT INTO events VALUES (1,'project.created','${projectId}','legacy','2026-11-10T00:00:00Z');
      PRAGMA user_version=1;
    `); legacy.close();
    store = createStore(path);
    let state = store.snapshot();
    assert.equal(state.projects[0].id, projectId); assert.equal(state.mcps[0].id, 'mcp-old'); assert.equal(state.mcps[0].serviceId, null);
    assert.equal(state.bindings[0].id, 'binding-old'); assert.equal(state.events.length, 1); assert.deepEqual(state.services, []);
    store.createService(projectId, { name: 'api', kind: 'app', language: 'python', sourcePath: '.', dockerfile: 'Dockerfile', buildContext: '.', containerPort: 8000, routeSegment: '', healthPath: '/health', watchPaths: ['apps/**'] });
    store.close(); store = createStore(path); state = store.snapshot();
    assert.equal(state.services.length, 1); assert.deepEqual(state.services[0].watchPaths, ['apps/**']); assert.equal(state.events.length, 2);
    const check = new DatabaseSync(path); assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, schemaVersion); check.close();
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v2 migration keeps existing services when adding the build queue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dama-migration-v2-'));
  const path = join(dir, 'v2.sqlite');
  try {
    const previous = createStore(path);
    const project = previous.createProject({ name: 'legacy', kind: 'app', repository: '', branch: 'main', domain: '' });
    const service = previous.createService(project.id, { name: 'api', kind: 'app', language: 'python', sourcePath: '.', dockerfile: 'Dockerfile', buildContext: '.', containerPort: 8000, routeSegment: '', healthPath: '/health', watchPaths: ['apps/**'] });
    previous.close();
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE build_jobs; PRAGMA user_version=2;');
    db.close();

    const upgraded = createStore(path);
    try {
      assert.deepEqual(upgraded.getService(service.id), service);
      assert.deepEqual(upgraded.snapshot().buildJobs, []);
    } finally { upgraded.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('future schema is rejected without resetting its version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dama-future-')); const path = join(dir, 'future.sqlite');
  try {
    let db = new DatabaseSync(path); db.exec(`PRAGMA user_version=${schemaVersion + 1}`); db.close();
    assert.throws(() => createStore(path), /새로운 데이터베이스/);
    db = new DatabaseSync(path); assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, schemaVersion + 1); db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('v3 jobs survive upgrade and only one worker can claim a deployment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dama-migration-v3-'));
  const path = join(dir, 'v3.sqlite');
  try {
    const previous = createStore(path);
    const project = previous.createProject({ name: 'legacy', kind: 'app', repository: 'https://example.com/repo', branch: 'main', domain: '' });
    const service = previous.createService(project.id, {
      name: 'api', kind: 'app', language: 'python', sourcePath: '.', dockerfile: 'Dockerfile',
      buildContext: '.', containerPort: 8000, routeSegment: '', healthPath: '/health', watchPaths: []
    });
    const original = previous.enqueueBuild(service.id, 'a'.repeat(40));
    previous.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE build_jobs RENAME TO snapshot;
      CREATE TABLE build_jobs (
        id TEXT PRIMARY KEY, serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        commitSha TEXT NOT NULL, source TEXT NOT NULL, build TEXT NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(serviceId, commitSha)
      );
      INSERT INTO build_jobs SELECT id,serviceId,commitSha,source,build,createdAt FROM snapshot;
      DROP TABLE snapshot;
      PRAGMA user_version=3;
    `);
    legacy.close();

    const store = createStore(path);
    const other = createStore(path);
    try {
      assert.deepEqual(store.snapshot().buildJobs.map(job => [job.id, job.status]), [[original.id, 'queued']]);
      const claimed = store.claimBuild();
      assert.equal(claimed?.id, original.id);
      assert.equal(claimed.plan, null);
      assert.deepEqual(claimed.build, original.build);
      assert.throws(() => other.claimBuild(), /실행 중인 작업/);
      assert.throws(() => other.cancelBuild(original.id), /대기 중인 작업/);
      assert.throws(() => other.remove('services', service.id), /활성 서비스/);
      store.finishBuild(original.id, { error: '테스트 실패' });
      assert.equal(other.snapshot().buildJobs[0].status, 'failed');
      assert.notEqual(other.enqueueBuild(service.id, original.commitSha).id, original.id);
    } finally {
      other.close();
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
