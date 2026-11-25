import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkGitAuth, fetchGitCommit, gitAuthInput } from '../src/git-auth.js';
import { createStore } from '../src/store.js';

const exec = promisify(execFile);
const demoToken = 'fixture-pat-only-for-test';
const repoUrl = 'https://gitlab.com/team/project.git';

test('project PAT survives reopening, stays out of public state, can be rotated and removed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dama-pat-store-'));
  const database = join(root, 'store.sqlite');
  const initial = createStore(database);
  const project = initial.createProject(
    { name: 'private', kind: 'app', repository: repoUrl, branch: 'main', domain: '' },
    gitAuthInput({ token: demoToken }, repoUrl)
  );
  initial.close();

  const store = createStore(database);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(store.snapshot().projects[0].gitAuth, { provider: 'gitlab', username: 'git' });
  assert.equal(store.getGitAuth(project.id, repoUrl)?.token, demoToken);
  assert.equal(store.getGitAuth(project.id, 'https://gitlab.com/team/other.git'), undefined);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), new RegExp(demoToken));
  assert.equal((await readFile(database)).includes(demoToken), false);
  if (process.platform !== 'win32') assert.equal((await stat(database + '.git-key')).mode & 0o777, 0o600);

  const service = store.createService(project.id, {
    name: 'web', kind: 'app', language: 'typescript', sourcePath: '.', dockerfile: 'Dockerfile',
    buildContext: '.', containerPort: 8000, routeSegment: '', healthPath: '/health', watchPaths: []
  });
  const job = store.enqueueBuild(service.id, 'a'.repeat(40));
  store.setGitAuth(project.id, { provider: 'gitlab', username: 'git', token: 'new-fixture-token' });
  assert.doesNotMatch(JSON.stringify(job), /fixture-token|fixture-pat/);
  assert.equal(store.getGitAuth(project.id, job.source.repository)?.token, 'new-fixture-token');
  const wal = await readFile(database + '-wal');
  assert.equal(wal.includes(demoToken) || wal.includes('new-fixture-token'), false);
  assert.equal(store.setGitAuth(project.id, null), null);
  assert.equal(store.getGitAuth(project.id, repoUrl), undefined);
});

test('HTTPS connection check and exact commit fetch prove PAT authentication and refuse redirects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dama-pat-https-'));
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  const cert = join(root, 'cert.pem');
  const key = join(root, 'key.pem');
  const openssl = join(root, 'openssl.cfg');
  await mkdir(join(root, 'team'));
  await mkdir(source);
  await mkdir(checkout);
  await writeFile(openssl, '[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = ext\n[dn]\nCN = 127.0.0.1\n[ext]\nsubjectAltName = IP:127.0.0.1\n');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', openssl, '-keyout', key, '-out', cert]);
  const runGit = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
  await runGit(source, 'init', '--quiet');
  await writeFile(join(source, 'readme'), 'private fixture');
  await runGit(source, 'add', 'readme');
  await runGit(source, '-c', 'user.name=Dama Test', '-c', 'user.email=dama@example.test', 'commit', '--quiet', '-m', 'fixture');
  const sha = (await runGit(source, 'rev-parse', 'HEAD')).stdout.trim();
  await runGit(root, 'clone', '--quiet', '--bare', source, join(root, 'team', 'project.git'));
  await runGit(checkout, 'init', '--quiet');

  let authenticated = 0;
  let redirectDestinationHits = 0;
  const expected = 'Basic ' + Buffer.from('git:' + demoToken).toString('base64');
  const server = createServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://127.0.0.1');
    if (url.pathname.startsWith('/team/redirect.git')) {
      res.writeHead(302, { Location: '/team/unexpected.git/info/refs' });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/team/unexpected.git')) redirectDestinationHits++;
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
      res.end();
      return;
    }
    authenticated++;
    const backend = spawn('git', ['http-backend'], { env: {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      REQUEST_METHOD: req.method ?? 'GET', QUERY_STRING: url.search.slice(1),
      REMOTE_USER: 'git', CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: req.headers['content-length'] ?? ''
    } });
    const buffers: Buffer[] = [];
    backend.stdout.on('data', data => buffers.push(data));
    backend.stderr.resume();
    backend.on('error', () => { res.writeHead(500); res.end(); });
    backend.on('close', code => {
      if (res.writableEnded) return;
      const output = Buffer.concat(buffers);
      const split = output.indexOf('\r\n\r\n');
      if (code || split < 0) { res.writeHead(500); res.end(); return; }
      let status = 200;
      for (const line of output.toString('utf8', 0, split).split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else res.setHeader(name, value);
      }
      res.statusCode = status;
      res.end(output.subarray(split + 4));
    });
    backend.stdin.on('error', () => undefined);
    req.pipe(backend.stdin);
  });

  const previousCa = process.env.GIT_SSL_CAINFO;
  process.env.GIT_SSL_CAINFO = cert;
  t.after(async () => {
    if (previousCa === undefined) delete process.env.GIT_SSL_CAINFO;
    else process.env.GIT_SSL_CAINFO = previousCa;
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = origin + '/team/project.git';
  const auth = gitAuthInput({ provider: 'gitlab', token: demoToken }, url);
  await checkGitAuth(url, auth);
  await fetchGitCommit(url, sha, auth, checkout);
  assert.equal((await runGit(checkout, 'rev-parse', 'FETCH_HEAD')).stdout.trim(), sha);
  assert.ok(authenticated >= 2);
  await assert.rejects(checkGitAuth(url, { ...auth, token: 'bad-credential' }), /PAT의 저장소 읽기 권한/);
  await assert.rejects(checkGitAuth(origin + '/team/redirect.git', auth), /PAT의 저장소 읽기 권한/);
  assert.equal(redirectDestinationHits, 0);
  assert.doesNotMatch(await readFile(join(checkout, '.git', 'config'), 'utf8'), new RegExp(demoToken));
});
