import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DeployEnvironment, SharedKind, SharedResource } from './types.js';
import type { Store } from './store.js';
import { HttpError } from './validation.js';

const environments: DeployEnvironment[] = ['dev', 'test', 'release'];
const kinds: SharedKind[] = ['postgres', 'minio', 'redis'];
const postgres = 'postgres';
const minioClient = 'minio/mc:RELEASE.2025-08-13T08-35-41Z';

function docker(args: string[], env: NodeJS.ProcessEnv, input?: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { env, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) =>
      error ? reject(new HttpError(503, '공용 환경의 Docker 작업을 완료하지 못했습니다. Docker 연결과 컨테이너 상태를 확인하세요.')) : resolve(stdout.trim()));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

async function loadOrCreate(file: string, generate: () => string): Promise<string> {
  async function read() {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('공용 환경 파일의 권한을 확인하세요.');
      return (await handle.readFile('utf8')).trim();
    } finally { await handle.close(); }
  }
  try { return await read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const tmp = file + '.' + randomUUID();
  await writeFile(tmp, generate() + '\n', { mode: 0o600, flag: 'wx' });
  try { await link(tmp, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await rm(tmp, { force: true }); }
  return read();
}

function bucket(name: string): string { return name.replaceAll('_', '-'); }
function accessKey(name: string): string { return name.slice(0, 20); }
function redisPrefix(resource: SharedResource): string { return `${resource.name}:${resource.environment}:`; }
function passwordHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function postgresSql(name: string, secret: [string, string]): string {
  // Names derive from generated project UUIDs; passwords are generated hex. No user SQL is accepted.
  const app = name + '_app';
  const migration = name + '_migrate';
  return [
    `SELECT 'CREATE ROLE ${app} LOGIN PASSWORD ''${secret[0]}''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${app}')`,
    '\\gexec',
    `SELECT 'CREATE ROLE ${migration} LOGIN PASSWORD ''${secret[1]}''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${migration}')`,
    '\\gexec',
    `SELECT 'CREATE DATABASE ${name} OWNER ${migration}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${name}')`,
    '\\gexec',
    `REVOKE ALL ON DATABASE ${name} FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE ${name} TO ${app};`,
    `\\connect ${name}`,
    `GRANT USAGE ON SCHEMA public TO ${app};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app};`,
    ''
  ].join('\n');
}

function minioPolicy(name: string) {
  const arn = 'arn:aws:s3:::' + name;
  return JSON.stringify({ Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'], Resource: [arn] },
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], Resource: [arn + '/*'] }
  ] });
}

function resp(...command: string[]): string {
  return `*${command.length}\r\n` + command.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('');
}

export function createSharedEnvironment(store: Store, dataDirectory: string) {
  const base = ['compose', '-f', resolve('deploy/database/compose.yaml'), '-f', resolve('deploy/database/compose.shared.yaml')];
  const operations = new Set<DeployEnvironment>();
  const paths = (environment: DeployEnvironment) => {
    const directory = join(dataDirectory, environment);
    return {
      directory,
      pg: join(directory, 'postgres.secret'),
      minio: join(directory, 'minio.secret'),
      redis: join(directory, 'redis.secret'),
      acl: join(directory, 'redis.acl')
    };
  };
  const variables = (environment: DeployEnvironment): NodeJS.ProcessEnv => {
    const files = paths(environment);
    return { ...process.env, DAMA_ENVIRONMENT: environment, DAMA_POSTGRES_PASSWORD_FILE: files.pg,
      DAMA_MINIO_PASSWORD_FILE: files.minio, DAMA_REDIS_ACL_FILE: files.acl };
  };
  const newPassword = () => randomBytes(24).toString('hex');
  async function ensureSecrets(environment: DeployEnvironment) {
    const files = paths(environment);
    await mkdir(files.directory, { mode: 0o700, recursive: true });
    const [, minio, redis] = await Promise.all([loadOrCreate(files.pg, newPassword), loadOrCreate(files.minio, newPassword), loadOrCreate(files.redis, newPassword)]);
    await loadOrCreate(files.acl, () => `user default off\nuser dama_admin on #${passwordHash(redis)} ~* &* +@all`);
    return { minio, redis };
  }
  async function exclusive<T>(environment: DeployEnvironment, action: () => Promise<T>) {
    if (operations.has(environment)) throw new HttpError(409, '이 환경의 작업이 진행 중입니다.');
    operations.add(environment);
    try { return await action(); } finally { operations.delete(environment); }
  }
  async function status(environment: DeployEnvironment) {
    try {
      const result = await docker([...base, 'ps', '--all', '--format', 'json'], variables(environment));
      const rows = (result.startsWith('[') ? JSON.parse(result) : result.split('\n').filter(Boolean).map(line => JSON.parse(line))) as
        { Service: string; State: string; Health?: string }[];
      return { environment, available: true, services: kinds.map(kind => {
        const item = rows.find(row => row.Service === kind);
        return { kind, status: item?.Health && item.Health !== 'healthy' ? item.Health : item?.State ?? 'absent' };
      }) };
    } catch {
      return { environment, available: false, services: kinds.map(kind => ({ kind, status: 'unknown' })) };
    }
  }
  async function redisCommand(environment: DeployEnvironment, auth: string, commands: string) {
    const result = await docker([...base, 'exec', '-T', 'redis', 'redis-cli', '--pipe'], variables(environment),
      resp('AUTH', 'dama_admin', auth) + commands, 15_000);
    if (!/errors:\s*0\b/.test(result)) throw new HttpError(503, 'Redis 공용 환경의 인증이나 자원 권한 적용에 실패했습니다.');
  }
  return {
    async list() { return { environments: await Promise.all(environments.map(status)), resources: store.listSharedResources() }; },
    start(environment: DeployEnvironment) {
      return exclusive(environment, async () => {
        const admin = await ensureSecrets(environment);
        await docker([...base, 'up', '-d', '--no-recreate', '--wait', ...kinds], variables(environment), undefined, 240_000);
        await redisCommand(environment, admin.redis, resp('PING'));
        return status(environment);
      });
    },
    stop(environment: DeployEnvironment) {
      return exclusive(environment, async () => {
        await docker([...base, 'stop', ...kinds], variables(environment), undefined, 90_000);
        return status(environment);
      });
    },
    provision(projectId: string, environment: DeployEnvironment, kind: SharedKind) {
      return exclusive(environment, async () => {
        const current = await status(environment);
        if (!current.services.some(item => item.kind === kind && item.status === 'running')) {
          throw new HttpError(409, '공용 환경에서 해당 서비스를 먼저 시작하세요.');
        }
        const { resource, secret } = store.ensureSharedResource(projectId, environment, kind);
        if (resource.ready) return resource;
        const name = resource.name;
        if (kind === 'postgres') {
          await docker([...base, 'exec', '-T', '-u', postgres, postgres, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', postgres, '-d', postgres],
            variables(environment), postgresSql(name, secret));
        } else {
          const admin = await ensureSecrets(environment);
          if (kind === 'redis') {
            const prefix = redisPrefix(resource);
            await redisCommand(environment, admin.redis, resp('ACL', 'SETUSER', name, 'reset', 'on', '#' + passwordHash(secret[0]),
              '~' + prefix + '*', '&' + prefix + '*', '+ping', '+get', '+set', '+del', '+unlink', '+mget', '+mset', '+exists',
              '+expire', '+pexpire', '+ttl', '+pttl', '+incr', '+decr', '+hget', '+hset', '+hdel', '+hgetall', '+publish', '+subscribe', '+psubscribe') +
              resp('ACL', 'SAVE'));
          } else {
            const target = bucket(name);
            await docker(['run', '--rm', '-i', '--network', `dama-db-${environment}`, '--entrypoint', '/bin/sh', minioClient, '-ec', `
              IFS= read -r admin
              IFS= read -r password
              IFS= read -r policy
              export MC_HOST_shared="http://dama-admin:$admin@minio:9000"
              printf '%s' "$policy" > /tmp/policy.json
              mc mb --ignore-existing "shared/$1"
              mc anonymous set none "shared/$1"
              mc admin policy create shared "$1" /tmp/policy.json
              mc admin user add shared "$2" "$password"
              mc admin policy attach shared "$1" --user "$2"
            `, '--', target, accessKey(name)], variables(environment), [admin.minio, secret[0], minioPolicy(target), ''].join('\n'), 100_000);
          }
        }
        return store.finishSharedResource(resource.id);
      });
    }
  };
}

export function dashboardSharedDirectory() {
  return resolve(process.env.DAMA_SHARED_DIR ?? join(dirname(resolve(process.env.DAMA_DB ?? 'data/dama.sqlite')), 'shared-environments'));
}

export function sharedRuntime(store: Store, id: string, projectId: string, environment: DeployEnvironment, kind: SharedKind) {
  const binding = store.sharedResourceBinding(id, projectId, environment, kind);
  if (!binding) return undefined;
  const { resource, secret } = binding;
  const name = resource.name;
  if (kind === 'postgres') return { database: { network: `dama-db-${environment}`,
    runtimeUrl: `postgresql://${name}_app:${secret[0]}@postgres:5432/${name}`,
    migrationUrl: `postgresql://${name}_migrate:${secret[1]}@postgres:5432/${name}` } };
  if (kind === 'minio') return { variables: { S3_ENDPOINT: 'http://minio:9000', S3_REGION: 'us-east-1',
    S3_BUCKET: bucket(name), S3_ACCESS_KEY_ID: accessKey(name), S3_SECRET_ACCESS_KEY: secret[0], S3_ALLOW_HTTP: 'true' } };
  return { variables: { REDIS_URL: `redis://${name}:${secret[0]}@redis:6379/0`, REDIS_KEY_PREFIX: redisPrefix(resource) } };
}
