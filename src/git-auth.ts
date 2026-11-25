import type { GitAuth, JsonObject } from './types.js';
import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { promisify } from 'node:util';
import { fail, HttpError, text } from './validation.js';

const exec = promisify(execFile);

export function gitRepository(value: unknown, forgejoOrigin?: string): URL {
  const input = text(value, 'Git 저장소', 2048);
  let url: URL;
  try { url = new URL(input); } catch { return fail('Git 저장소의 HTTPS 주소를 입력하세요.'); }
  if ((url.protocol !== 'https:' && url.origin !== forgejoOrigin) || url.username || url.password || url.search || url.hash ||
      !/^\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/i.test(url.pathname)) {
    fail('PAT 인증에는 HTTPS 복제 주소 또는 Dama에서 실행 중인 Forgejo 저장소 주소를 입력하세요.');
  }
  return url;
}

export function gitAuthInput(value: unknown, repository: string, forgejoOrigin?: string): GitAuth {
  const url = gitRepository(repository, forgejoOrigin);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Git 인증 설정을 입력하세요.');
  const body = value as JsonObject;
  let provider = body.provider;
  const knownProvider = url.origin === forgejoOrigin ? 'forgejo' : url.hostname === 'github.com' ? 'github' : url.hostname === 'gitlab.com' ? 'gitlab' : undefined;
  if (!provider) provider = knownProvider;
  if (provider !== 'github' && provider !== 'gitlab' && provider !== 'forgejo') fail('GitHub, GitLab 또는 Forgejo를 선택하세요.');
  if (knownProvider && knownProvider !== provider) fail('저장소 주소와 Git 제공자를 확인하세요.');
  const token = text(body.token, 'PAT', 2048);
  if (/\s/.test(token)) fail('PAT에 공백이 포함되어 있습니다.');
  const username = text(body.username, 'Git 사용자 이름', 120, provider === 'gitlab') || 'git';
  if (/\s/.test(username)) fail('Git 사용자 이름에 공백이 포함되어 있습니다.');
  return { provider, username, token };
}

// Use Git's credential protocol. The secret travels through the child environment and helper pipe.
// The helper only answers get requests for the exact origin and repository path.
const credentialHelper = `!f() {
  [ "$1" = get ] || return 0
  protocol= host= path=
  while IFS= read -r line && [ -n "$line" ]; do
    case "$line" in
      protocol=*) protocol=\${line#protocol=} ;;
      host=*) host=\${line#host=} ;;
      path=*) path=\${line#path=} ;;
    esac
  done
  if [ "$protocol" = "$DAMA_GIT_PROTOCOL" ] && [ "$host" = "$DAMA_GIT_HOST" ] && [ "$path" = "$DAMA_GIT_PATH" ]; then
    printf 'username=%s\\npassword=%s\\n' "$DAMA_GIT_USER" "$DAMA_GIT_SECRET"
  fi
}; f`;

async function authenticatedGit(args: string[], repository: string, auth: GitAuth, timeout: number, cwd?: string, forgejoOrigin?: string): Promise<void> {
  const url = gitRepository(repository, auth.provider === 'forgejo' ? forgejoOrigin : undefined);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(TRACE|CONFIG|CURL_VERBOSE|SSL_NO_VERIFY|ASKPASS)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'false',
    DAMA_GIT_PROTOCOL: url.protocol.slice(0, -1), DAMA_GIT_HOST: url.host, DAMA_GIT_PATH: url.pathname.slice(1),
    DAMA_GIT_USER: auth.username, DAMA_GIT_SECRET: auth.token
  });
  try {
    await exec('git', [
      '-c', 'credential.helper=', '-c', `credential.helper=${credentialHelper}`,
      '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false',
      ...(url.protocol === 'http:' ? ['-c', 'http.proxy='] : []), ...args
    ], { cwd, env, timeout, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch {
    // Remote output may contain user-controlled content. Keep it out of API responses and deploy logs.
    throw new HttpError(422, 'Git 저장소를 읽지 못했습니다. 복제 주소와 PAT의 저장소 읽기 권한을 확인하세요.');
  }
}

export function checkGitAuth(repository: string, auth: GitAuth, forgejoOrigin?: string): Promise<void> {
  return authenticatedGit(['ls-remote', '--', repository, 'HEAD'], repository, auth, 12_000, undefined, forgejoOrigin);
}

export function fetchGitCommit(repository: string, sha: string, auth: GitAuth, cwd: string, forgejoOrigin?: string): Promise<void> {
  return authenticatedGit(['-c', 'protocol.file.allow=never', 'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', repository, sha], repository, auth, 120_000, cwd, forgejoOrigin);
}
