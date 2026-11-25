import { execFile } from 'node:child_process';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { allocateHostPort } from './deployment-ports.js';
import type { Store } from './store.js';
import type { ForgejoRepository, ForgejoSettings, ForgejoStatus, JsonObject } from './types.js';
import { fail, HttpError, text } from './validation.js';

const exec = promisify(execFile);
const composeFile = resolve('deploy/forgejo/compose.yaml');
const slug = /^[a-z0-9_.-]+$/i;
const isSlug = (value: string) => slug.test(value) && value !== '.' && value !== '..';

async function compose(settings: ForgejoSettings | null, args: string[], timeout = 10_000) {
  const env = {
    ...process.env,
    DAMA_FORGEJO_PORT: String(settings?.port ?? 3000),
    DAMA_FORGEJO_PATH: settings?.dataPath ?? '/',
    DAMA_FORGEJO_UID: String(process.platform === 'darwin' ? 1000 : process.getuid?.() || 1000),
    DAMA_FORGEJO_GID: String(process.platform === 'darwin' ? 1000 : process.getgid?.() || 1000)
  };
  return (await exec('docker', ['compose', '-p', 'dama-forgejo', '-f', composeFile, ...args], { env, timeout, maxBuffer: 512 * 1024 })).stdout.trim();
}

async function isRunning(settings: ForgejoSettings) {
  const result = await compose(settings, ['ps', '--status', 'running', '--quiet', 'forgejo']);
  if (!result) return false;
  return (await compose(settings, ['port', 'forgejo', '3000'])) === `127.0.0.1:${settings.port}`;
}

export async function requireLocalForgejo(store: Store, repository: string): Promise<string | undefined> {
  const origin = store.forgejoOrigin();
  if (!origin || new URL(repository).origin !== origin) return;
  try { if (await isRunning(store.forgejoSettings()!)) return origin; } catch { /* Report the same connection error. */ }
  throw new HttpError(503, '공용 환경에서 Forgejo를 시작한 다음 다시 시도하세요.');
}

async function forgejoRequest(origin: string, path: string, token?: string, body?: JsonObject) {
  try {
    return await fetch(`${origin}/api/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(token ? { Authorization: `token ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(5000)
    });
  } catch { throw new HttpError(503, 'Forgejo에 연결하지 못했습니다. 설치 상태를 확인하세요.'); }
}

function apiError(status: number): never {
  if (status === 401 || status === 403) throw new HttpError(422, 'Forgejo 관리 토큰과 저장소 권한을 확인하세요.');
  if (status === 409 || status === 422) throw new HttpError(409, '저장소 이름이 이미 사용 중이거나 Forgejo에서 허용되지 않습니다.');
  throw new HttpError(502, 'Forgejo에서 저장소 요청을 처리하지 못했습니다.');
}

function repositoryView(value: unknown, origin: string): ForgejoRepository {
  const row = value as { name?: string; full_name?: string; default_branch?: string; private?: boolean; empty?: boolean } | null;
  if (typeof row?.name !== 'string' || !isSlug(row.name) || typeof row.full_name !== 'string' ||
      row.full_name.split('/').length !== 2 || !row.full_name.split('/').every(isSlug)) apiError(502);
  return {
    name: row.name, fullName: row.full_name, cloneUrl: `${origin}/${row.full_name}.git`,
    branch: row.default_branch || 'main', private: row.private === true, empty: row.empty === true
  };
}

export function createForgejo(store: Store, defaultPath = resolve(dirname(resolve(process.env.DAMA_DB ?? 'data/dama.sqlite')), 'forgejo')) {
  let changing = false;
  const status = async (): Promise<ForgejoStatus> => {
    const settings = store.forgejoSettings();
    const url = store.forgejoOrigin() ?? null;
    let state: ForgejoStatus['state'] = 'unconfigured';
    if (settings && url) {
      state = 'unavailable';
      try {
        if (!await isRunning(settings)) state = 'stopped';
        else {
          state = 'starting';
          const response = await forgejoRequest(url, '/version');
          const version = response.ok ? await response.json() as { version?: unknown } : null;
          state = typeof version?.version === 'string' ? 'ready' : 'setup';
        }
      } catch { /* Preserve the latest known state. */ }
    }
    return { settings, defaultPath, url, state };
  };
  const change = async (fn: () => Promise<void>) => {
    if (changing) throw new HttpError(409, 'Forgejo 작업이 진행 중입니다.');
    changing = true;
    try { await fn(); }
    finally { changing = false; }
    return status();
  };
  async function readyOrigin() {
    const current = await status();
    if (current.state !== 'ready' || !current.url) throw new HttpError(503, 'Forgejo를 시작하고 초기 설정을 완료하세요.');
    return current.url;
  }
  return {
    status,
    start: (value: unknown) => change(async () => {
      let settings = store.forgejoSettings();
      if (settings) {
        if (value !== undefined && value !== settings.dataPath) fail('이미 설정된 저장 경로로 Forgejo를 시작하세요.');
        try {
          if (await realpath(settings.dataPath) !== settings.dataPath) throw new Error('Forgejo data path changed');
          await compose(settings, ['up', '-d'], 240_000);
        }
        catch { throw new HttpError(503, 'Forgejo를 시작하지 못했습니다. Docker, 저장 경로, 포트 사용 상태를 확인하세요.'); }
        return;
      }
      const path = value === undefined ? defaultPath : text(value, 'Forgejo 저장 경로', 1024);
      if (!isAbsolute(path) || /[\x00-\x1f$]/.test(path)) fail('호스트의 절대 저장 경로를 입력하세요.');
      let dataPath: string;
      try {
        await mkdir(path, { recursive: true, mode: 0o700 });
        dataPath = await realpath(path);
        // The image manages the ownership and permissions of this directory.
        if ((await readdir(dataPath)).length > 0) fail('Forgejo에 사용할 비어 있는 전용 폴더를 지정하세요.');
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'Forgejo 저장 폴더를 만들거나 읽을 수 없습니다.');
      }
      try {
        if (await compose(null, ['ps', '--all', '--quiet', 'forgejo'])) {
          throw new HttpError(409, '이미 존재하는 Dama Forgejo 컨테이너를 확인하세요.');
        }
        await allocateHostPort('web', async port => {
          settings = settings ? store.setForgejoPort(settings.port, port) : store.configureForgejo(dataPath, port);
          if (settings.dataPath !== dataPath || settings.port !== port) throw new HttpError(409, 'Forgejo 설정이 동시에 변경되었습니다.');
          try { await compose(settings, ['up', '-d'], 240_000); return true; }
          catch (error) {
            const stderr = (error as { stderr?: string }).stderr ?? '';
            if (/port is already allocated|address already in use/i.test(stderr)) return false;
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'Forgejo를 시작하지 못했습니다. Docker, 저장 경로, 3000–3999 포트를 확인하세요.');
      }
    }),
    stop: () => change(async () => {
      const settings = store.forgejoSettings();
      if (!settings) return;
      try { await compose(settings, ['stop', 'forgejo'], 30_000); }
      catch { throw new HttpError(503, 'Forgejo를 중지하지 못했습니다. Docker 상태를 확인하세요.'); }
    }),
    async saveToken(value: unknown) {
      const token = text(value, 'Forgejo 관리 토큰', 2048);
      if (!/^[a-z0-9_-]+$/i.test(token)) fail('Forgejo 관리 토큰 형식을 확인하세요.');
      const origin = await readyOrigin();
      const response = await forgejoRequest(origin, '/user', token);
      if (!response.ok) apiError(response.status);
      const account = await response.json() as { login?: string };
      if (typeof account.login !== 'string' || !isSlug(account.login)) apiError(502);
      const repos = await forgejoRequest(origin, '/user/repos?limit=1', token);
      if (!repos.ok) apiError(repos.status);
      store.setForgejoToken(account.login, token);
      return status();
    },
    forgetToken() { store.setForgejoToken(null); return status(); },
    async list(): Promise<ForgejoRepository[]> {
      const credential = store.getForgejoToken();
      if (!credential) return [];
      const origin = await readyOrigin();
      const repositories: ForgejoRepository[] = [];
      let page = 1;
      for (;;) {
        const response = await forgejoRequest(origin, `/user/repos?limit=50&page=${page}`, credential.token);
        if (!response.ok) apiError(response.status);
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) apiError(502);
        repositories.push(...rows.map(row => repositoryView(row, origin)));
        if (!response.headers.get('link')?.includes('rel="next"')) return repositories;
        page++;
      }
    },
    async create(body: JsonObject) {
      const name = text(body.name, '저장소 이름', 100);
      if (!isSlug(name) || /\.git$/i.test(name) || name.endsWith('.')) fail('저장소 이름에 영문, 숫자, 밑줄, 하이픈, 마침표를 사용하세요.');
      const credential = store.getForgejoToken();
      if (!credential) throw new HttpError(400, 'Forgejo 관리 토큰을 먼저 등록하세요.');
      const origin = await readyOrigin();
      const response = await forgejoRequest(origin, '/user/repos', credential.token, {
        name, private: body.private !== false, auto_init: body.initialize === true
      });
      if (!response.ok) apiError(response.status);
      return repositoryView(await response.json(), origin);
    }
  };
}
