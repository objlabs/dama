import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { allocateHostPort, hostPortRange } from '../src/deployment-ports.js';

const exec = promisify(execFile);

async function main() {
  const [environment, option, extra] = process.argv.slice(2);
  if (!['dev', 'test', 'release'].includes(environment) || (option && option !== '--host') || extra) {
    throw new Error('사용법: npm run db:shared -- <dev|test|release> [--host]');
  }
  const passwordFile = process.env.DAMA_POSTGRES_PASSWORD_FILE;
  if (!passwordFile) throw new Error('DAMA_POSTGRES_PASSWORD_FILE에 해당 환경의 관리자 암호 파일을 지정하세요.');
  const secret = await stat(passwordFile);
  if (!secret.isFile() || (process.platform !== 'win32' && secret.mode & 0o077)) {
    throw new Error('PostgreSQL 관리자 암호 파일은 소유자만 읽을 수 있어야 합니다.');
  }
  const env = { ...process.env, DAMA_ENVIRONMENT: environment, DAMA_POSTGRES_PASSWORD_FILE: resolve(passwordFile) };
  const base = ['compose', '-f', 'deploy/database/compose.yaml'];
  let previous = '';
  try {
    previous = (await exec('docker', [...base, 'port', 'postgres', '5432'], { env })).stdout.trim();
  } catch { /* A service with no published port does not return an address. */ }
  const match = /^127\.0\.0\.1:(\d+)$/.exec(previous);
  const [first, last] = hostPortRange('db');
  const oldPort = match ? Number(match[1]) : 0;
  if (previous && (!match || oldPort < first || oldPort > last)) throw new Error('기존 DB 포트가 로컬 5000–5999 범위에 있는지 확인하세요.');
  if (option === '--host' || oldPort) {
    async function start(port: number) {
      try {
        await exec('docker', [...base, '-f', 'deploy/database/compose.host.yaml', 'up', '-d', '--wait'],
          { env: { ...env, DAMA_POSTGRES_HOST_PORT: String(port) } });
        return true;
      } catch (error) {
        const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
        if (!oldPort && /address already in use|port is already allocated|ports are not available/i.test(stderr)) return false;
        throw error;
      }
    }
    const port = oldPort || await allocateHostPort('db', start);
    if (oldPort) await start(oldPort);
    console.log(`dama-db-${environment} · 127.0.0.1:${port}`);
  } else {
    await exec('docker', [...base, 'up', '-d', '--wait'], { env });
    console.log(`dama-db-${environment} · postgres:5432`);
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
