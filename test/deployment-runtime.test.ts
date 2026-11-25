import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Release, ServiceInput } from '../src/types.js';
import { createStore } from '../src/store.js';
import { deployNext } from '../src/deploy-worker.js';
import { databaseRuntime, listDatabaseConnections, migrationVersion } from '../src/database-connections.js';
import { allocateHostPort } from '../src/deployment-ports.js';
import { nginxLocations } from '../src/routing.js';

const commit = 'a'.repeat(40);
const image = 'sha256:' + 'b'.repeat(64);
const service: ServiceInput = {
  name: 'api-test', kind: 'app', language: 'typescript', sourcePath: '.', dockerfile: 'Dockerfile',
  buildContext: '.', containerPort: 8080, routeSegment: 'api-test', healthPath: '/health', watchPaths: [],
  deployment: { environment: 'test', portClass: 'api', databaseRef: '', migration: [], verification: ['node', 'verify.js'], portableImage: true }
};
const project = { name: 'application', kind: 'app' as const, repository: 'https://github.com/example/app', branch: 'main', domain: '' };

test('host port selection starts at each range maximum and retries descending on collisions', async () => {
  for (const [kind, expected] of [['web', 3999], ['api', 4999], ['db', 5999]] as const) {
    assert.equal(await allocateHostPort(kind, async () => true, async () => false), expected);
  }
  const attempts: number[] = [];
  assert.equal(await allocateHostPort('api', async port => {
    attempts.push(port);
    return port !== 4998;
  }, async port => port === 4999), 4997);
  assert.deepEqual(attempts, [4998, 4997]);
  assert.equal(await allocateHostPort('web', async () => true, async port => port > 3000), 3000);
  await assert.rejects(allocateHostPort('web', async () => true, async () => true), /3000–3999/);
});

test('release requires a verified test deployment for the same immutable image and retains migration evidence', () => {
  const store = createStore(':memory:');
  try {
    const p = store.createProject(project);
    const testing = store.createService(p.id, service);
    const release = store.createService(p.id, { ...service, name: 'api-release', routeSegment: 'api-release',
      deployment: { ...service.deployment!, environment: 'release' } });
    assert.throws(() => store.enqueueBuild(release.id, commit), /검증된 test/);
    const testJob = store.enqueueBuild(testing.id, commit);
    assert.ok(store.claimBuild());
    store.recordEvidence(testJob.id, { image });
    store.finishBuild(testJob.id, { release: fixtureRelease(p.id, testJob.id, testing.routeSegment) });
    assert.throws(() => store.enqueueBuild(release.id, commit, testJob.id), /검증된 test/);

    const verifiedJob = store.enqueueBuild(testing.id, commit);
    assert.ok(store.claimBuild());
    store.recordEvidence(verifiedJob.id, { image, verifiedAt: '2026-11-25T00:00:00.000Z' });
    store.finishBuild(verifiedJob.id, { release: fixtureRelease(p.id, verifiedJob.id, testing.routeSegment) });
    assert.throws(() => store.enqueueBuild(release.id, 'c'.repeat(40), verifiedJob.id), /검증된 test/);
    const releaseJob = store.enqueueBuild(release.id, commit, verifiedJob.id);
    assert.deepEqual(store.claimBuild()?.plan?.promotion, { jobId: verifiedJob.id, image });
    store.recordEvidence(releaseJob.id, { image, migrationVersion: '0014', migratedAt: '2026-11-25T00:00:00.000Z' });
    store.finishBuild(releaseJob.id, { error: '앱 상태 확인 실패' });
    assert.equal(store.snapshot().buildJobs.at(-1)?.evidence?.migrationVersion, '0014');
  } finally { store.close(); }
});

function fixtureRelease(projectId: string, deploymentId: string, routeSegment: string): Release {
  return { projectId, deploymentId, routeSegment, upstreamPort: 4091, container: 'previous', healthPath: '/health', image };
}

test('migration uses a separate role and a failure keeps the live route and skips app startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dama-runtime-'));
  const store = createStore(':memory:');
  const priorPath = process.env.PATH;
  const priorConnections = process.env.DAMA_DB_CONNECTIONS;
  t.after(async () => {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorConnections === undefined) delete process.env.DAMA_DB_CONNECTIONS; else process.env.DAMA_DB_CONNECTIONS = priorConnections;
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin');
  await mkdir(bin);
  const include = join(root, 'routes.conf');
  const trace = join(root, 'migration-ran');
  await writeFile(join(bin, 'nginx'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(bin, 'docker'), `#!/bin/sh
case "$1" in
  image) printf '%s\\n' '${image}';;
  run)
    case "$DATABASE_URL" in
      postgresql://migrator:*) printf '%s\\n' migration > '${trace}';;
      *) exit 90;;
    esac
    printf '%s\\n' 'private-migration-error' >&2
    exit 1;;
  ps) ;;
  *) exit 91;;
esac
`, { mode: 0o700 });
  process.env.PATH = bin + ':' + priorPath;
  const connections = join(root, 'connections.json');
  process.env.DAMA_DB_CONNECTIONS = connections;
  await writeFile(connections, JSON.stringify([{ id: 'app-release', environment: 'release', runtimeEnv: 'runtime.env', migrationEnv: 'migration.env' }]));
  await writeFile(join(root, 'runtime.env'), 'DATABASE_URL=postgresql://app:fake-runtime@postgres/app\n', { mode: 0o600 });
  await writeFile(join(root, 'migration.env'), 'DATABASE_URL=postgresql://migrator:fake-migrate@postgres/app\n', { mode: 0o600 });
  assert.deepEqual(await listDatabaseConnections(), [{ id: 'app-release', environment: 'release' }]);
  await assert.rejects(databaseRuntime('app-release', 'test', true), /배포 환경/);
  assert.equal(migrationVersion('done\nDAMA_MIGRATION_VERSION=0014\n'), '0014');
  assert.throws(() => migrationVersion('DAMA_MIGRATION_VERSION=one\nDAMA_MIGRATION_VERSION=two'));

  const p = store.createProject(project);
  const testing = store.createService(p.id, service);
  const release = store.createService(p.id, { ...service, name: 'api-release', routeSegment: 'api-release',
    deployment: { ...service.deployment!, environment: 'release', databaseRef: 'app-release', migration: ['/app/migrate'] } });
  const testJob = store.enqueueBuild(testing.id, commit);
  store.claimBuild();
  store.recordEvidence(testJob.id, { image, verifiedAt: '2026-11-25T00:00:00.000Z' });
  const testRoute = fixtureRelease(p.id, testJob.id, testing.routeSegment);
  store.finishBuild(testJob.id, { release: testRoute });
  const liveJob = store.enqueueBuild(release.id, commit, testJob.id);
  store.claimBuild();
  store.finishBuild(liveJob.id, { release: fixtureRelease(p.id, liveJob.id, release.routeSegment) });
  const content = '# Managed by Dama deployment worker\n' + nginxLocations(store.activeReleases()) + '\n';
  await writeFile(include, content);
  const job = store.enqueueBuild(release.id, commit, testJob.id);
  await assert.rejects(deployNext(store, { include, nginxConfig: join(root, 'nginx.conf'), probeOrigin: 'http://127.0.0.1' }),
    error => error instanceof Error && /마이그레이션이 실패/.test(error.message) && !error.message.includes('private-migration-error'));
  assert.equal(await readFile(trace, 'utf8'), 'migration\n');
  assert.equal(await readFile(include, 'utf8'), content);
  const failed = store.snapshot().buildJobs.find(item => item.id === job.id);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.evidence?.image, image);
  assert.ok(store.activeReleases().some(item => item.deploymentId === liveJob.id));
  assert.equal(store.snapshot().buildJobs.find(item => item.id === liveJob.id)?.hostPort, 4091);
});

test('shared resources reuse durable credentials and reject another project or environment', () => {
  const store = createStore(':memory:');
  try {
    const p = store.createProject(project);
    const other = store.createProject({ ...project, name: 'another-project' });
    const early = store.ensureSharedResource(p.id, 'test', 'postgres');
    assert.equal(early.resource.ready, false);
    assert.throws(() => store.sharedResourceBinding(early.resource.id, p.id, 'test', 'postgres'), /준비된/);
    assert.equal(store.finishSharedResource(early.resource.id).ready, true);
    const again = store.ensureSharedResource(p.id, 'test', 'postgres');
    assert.equal(early.resource.id, again.resource.id);
    assert.deepEqual(early.secret, again.secret);
    assert.equal(store.listSharedResources().length, 1);
    assert.doesNotMatch(JSON.stringify(store.listSharedResources()), new RegExp(early.secret[0]));
    assert.throws(() => store.sharedResourceBinding(early.resource.id, other.id, 'test', 'postgres'), /현재 프로젝트/);
    assert.throws(() => store.sharedResourceBinding(early.resource.id, p.id, 'release', 'postgres'), /현재 프로젝트/);
    assert.throws(() => store.remove('projects', p.id), /공용 자원/);
  } finally { store.close(); }
});
