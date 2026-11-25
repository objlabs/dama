import { readFile, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DeployEnvironment } from './types.js';

interface DatabaseConnection {
  id: string;
  environment: DeployEnvironment;
  runtimeEnv: string;
  migrationEnv?: string;
}

async function connections(): Promise<DatabaseConnection[]> {
  const path = process.env.DAMA_DB_CONNECTIONS;
  if (!path) return [];
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(input)) throw new Error('DB 연결 목록 형식이 올바르지 않습니다.');
  const result: DatabaseConnection[] = [];
  for (const item of input) {
    if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) ||
        !['dev', 'test', 'release'].includes(item.environment) || typeof item.runtimeEnv !== 'string' || !item.runtimeEnv ||
        (item.migrationEnv !== undefined && (typeof item.migrationEnv !== 'string' || !item.migrationEnv)) ||
        result.some(entry => entry.id === item.id)) {
      throw new Error('DB 연결의 이름, 환경 또는 자격 증명 파일을 확인하세요.');
    }
    result.push({
      id: item.id, environment: item.environment,
      runtimeEnv: resolve(dirname(path), item.runtimeEnv),
      migrationEnv: item.migrationEnv ? resolve(dirname(path), item.migrationEnv) : undefined
    });
  }
  return result;
}

export async function listDatabaseConnections() {
  return (await connections()).map(({ id, environment }) => ({ id, environment }));
}

async function connectionUrl(path: string): Promise<URL> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && info.mode & 0o077)) {
      throw new Error('DB 자격 증명 파일의 권한이나 크기가 올바르지 않습니다.');
    }
    const lines = (await file.readFile('utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (lines.length !== 1 || !lines[0].startsWith('DATABASE_URL=')) throw new Error('DB 자격 증명 파일에는 DATABASE_URL 한 줄을 지정하세요.');
    let url: URL;
    try { url = new URL(lines[0].slice('DATABASE_URL='.length)); }
    catch { throw new Error('PostgreSQL 연결 주소 형식이 올바르지 않습니다.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' ||
        (url.port && url.port !== '5432') || !url.username || !url.password || !/^\/[a-zA-Z_][a-zA-Z0-9_]*$/.test(url.pathname) ||
        url.pathname === '/postgres' || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
        url.searchParams.getAll('sslmode').length > 1 || url.hash) {
      throw new Error('환경별 PostgreSQL의 프로젝트 데이터베이스와 계정을 지정하세요.');
    }
    return url;
  } finally { await file.close(); }
}

export async function databaseRuntime(id: string, environment: DeployEnvironment, requiresMigration: boolean) {
  const entry = (await connections()).find(item => item.id === id && item.environment === environment);
  if (!entry) throw new Error('배포 환경과 일치하는 기존 DB 연결을 찾지 못했습니다.');
  try {
    const runtime = await connectionUrl(entry.runtimeEnv);
    if (requiresMigration && !entry.migrationEnv) throw new Error('마이그레이션 전용 DB 계정을 지정하세요.');
    const migration = requiresMigration && entry.migrationEnv ? await connectionUrl(entry.migrationEnv) : undefined;
    if (migration && (migration.pathname !== runtime.pathname || migration.username === runtime.username)) {
      throw new Error('동일한 DB에 앱용 계정과 마이그레이션 전용 계정을 각각 지정하세요.');
    }
    return { network: `dama-db-${environment}`, runtimeUrl: runtime.href, migrationUrl: migration?.href };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw new Error('DB 자격 증명 파일을 읽을 수 없습니다.');
    throw error;
  }
}

export function migrationVersion(output: string): string {
  const markers = output.split(/\r?\n/).filter(line => line.startsWith('DAMA_MIGRATION_VERSION='));
  const version = markers.length === 1 ? markers[0].slice('DAMA_MIGRATION_VERSION='.length) : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,111}$/.test(version)) {
    throw new Error('마이그레이션 명령에서 적용 버전을 확인할 수 없습니다.');
  }
  return version;
}
