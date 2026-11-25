import type { Snapshot, DeploymentPlan, Language, GitAuthSummary, DeployEnvironment, SharedKind, SharedResource, ForgejoStatus, ForgejoRepository, NginxState } from '../src/types.js';
type EditorType = 'project' | 'service' | 'mcp' | 'binding' | 'git-auth';
type View = 'overview' | 'projects' | 'services' | 'mcps' | 'connections' | 'activity' | 'shared';
let state: Snapshot = { projects: [], services: [], mcps: [], bindings: [], events: [], buildJobs: [], capabilities: { deployment: false, mcpExecution: false, authentication: false } };
let view: View = 'overview';
let editorType: EditorType = 'project';
let editingServiceId = '';
let editingGitProjectId = '';
type SharedStatus = { environment: DeployEnvironment; available: boolean; services: { kind: SharedKind; status: string }[] };
let shared: { environments: SharedStatus[]; resources: SharedResource[] } | null = null;
let sharedMessage = '';
let sharedBusy = false;
let forgejo: ForgejoStatus | null = null;
let repositories: ForgejoRepository[] = [];
let forgejoMessage = '';
let forgejoBusy = false;
let nginx: NginxState | null = null;
let nginxEdit = '';
let nginxMessage = '';
let nginxBusy = false;
const sharedLabels: Record<SharedKind, string> = { postgres: 'PostgreSQL', minio: 'MinIO', redis: 'Redis' };
let lastPlan: DeploymentPlan | null = null;
function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`화면 요소를 찾을 수 없습니다: ${selector}`);
  return element;
}
function control(name: string): HTMLInputElement | HTMLSelectElement {
  const element = $<HTMLFormElement>('#editor-form').elements.namedItem(name);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) throw new Error(`입력 항목을 찾을 수 없습니다: ${name}`);
  return element;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '요청에 실패했습니다.'; }
function isView(value: string): value is View { return Object.hasOwn(titles, value); }
function isEditorType(value: string): value is EditorType { return ['project', 'service', 'mcp', 'binding', 'git-auth'].includes(value); }
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[char]));
const titles = {
  overview: ['개요', '운영 공간을 한눈에.', '프로젝트와 MCP를 모으고, 필요한 곳에 연결하세요.'],
  projects: ['프로젝트', '아이디어가 실행되는 곳.', '웹 앱, API, MCP 서버를 하나의 목록에서 관리하세요.'],
  shared: ['공용 환경', '공용 환경', '환경별 공용 인스턴스를 켜고 프로젝트에 필요한 자원을 준비하세요.'],
  services: ['서비스', '언어는 달라도, 운영은 한곳에서.', '모노레포의 Python · Rust · TypeScript 서비스를 독립적으로 설정하세요.'],
  mcps: ['MCP 레지스트리', '도구를 한곳에 모으세요.', '직접 배포한 MCP와 외부 MCP의 연결 정보를 관리하세요.'],
  connections: ['연결 관리', '필요한 도구를, 필요한 곳에.', '프로젝트가 사용할 MCP와 향후 실행 정책을 지정하세요.'],
  activity: ['활동 기록', '변경의 흐름을 확인하세요.', '프로젝트와 MCP의 등록·삭제·연결 이력입니다.']
};
const actionNames: Record<string, string> = { 'project.created': '프로젝트 등록', 'project.git_auth_saved': 'Git 인증 저장', 'project.git_auth_deleted': 'Git 인증 해제', 'shared_resource.created': '공용 자원 생성', 'service.created': '서비스 등록', 'service.updated': '서비스 수정', 'services.deleted': '서비스 삭제', 'build.queued': '빌드 작업 등록', 'build.cancelled': '빌드 작업 취소', 'build.deployed': '배포 완료', 'build.failed': '배포 실패', 'mcp.created': 'MCP 등록', 'binding.created': 'MCP 연결', 'projects.deleted': '프로젝트 삭제', 'mcps.deleted': 'MCP 삭제', 'bindings.deleted': '연결 해제' };
async function request<T = unknown>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : '요청에 실패했습니다.');
  return body as T;
}
function showError(error: unknown) { $('#error').textContent = errorMessage(error); $('#error').hidden = false; }
async function refresh() {
  state = await request<Snapshot>('/api/state');
  $('#error').hidden = true;
  render();
}
function empty(icon: string, title: string, copy: string, type: EditorType | '', label: string): string {
  return `<div class="empty"><span class="empty-icon">${icon}</span><h3>${title}</h3><p>${copy}</p>${type ? `<button class="button secondary" data-open="${type}">${label}</button>` : ''}</div>`;
}
function projectCards() {
  if (!state.projects.length) return empty('▦', '첫 프로젝트를 등록하세요', '운영 중인 앱이나 MCP 서버의 정보를 모아보세요.', 'project', '프로젝트 추가');
  return `<div class="card-grid">${state.projects.map(p => `<article class="project-card"><div class="card-top"><span class="app-icon">${p.kind === 'mcp' ? '⌘' : '▦'}</span><span class="badge neutral">${state.buildJobs.some(job => job.active && state.services.some(service => service.id === job.serviceId && service.projectId === p.id)) ? '활성 배포 있음' : '미배포'}</span></div><h3>${escape(p.name)}</h3><p class="domain">${escape(p.domain || '커스텀 도메인 미설정')}</p><p class="default-address">기본 주소 · 배포 예정<small>${escape(p.defaultUrl)}</small></p><div class="project-meta"><span>${p.kind === 'mcp' ? 'MCP 서버' : '애플리케이션'}</span><span>⑂ ${escape(p.branch)}</span></div><div class="card-bottom"><span>서비스 ${state.services.filter(item => item.projectId === p.id).length}개</span><button class="text-button" data-open="service" data-project="${p.id}">＋ 서비스</button>${p.repository ? `<button class="text-button" data-open="git-auth" data-project="${p.id}">Git 인증${p.gitAuth ? ' ✓' : ''}</button>` : ''}<button class="text-button danger" data-delete="projects" data-id="${p.id}" data-name="${escape(p.name)}">삭제</button></div></article>`).join('')}</div>`;
}

const languageNames: Record<Language, string> = { python: 'Python', rust: 'Rust', typescript: 'TypeScript' };
function serviceTable() {
  if (!state.services.length) return empty('▦', '프로젝트에 서비스를 추가하세요', '같은 저장소에 있는 웹 앱, API, MCP를 서로 다른 서비스로 설정하세요.', state.projects.length ? 'service' : 'project', state.projects.length ? '서비스 추가' : '프로젝트 추가');
  return `<div class="table-wrap"><table><thead><tr><th>프로젝트 / 서비스</th><th>빌드 설정</th><th>접속 경로 / 포트</th><th>작업</th></tr></thead><tbody>${state.services.map(item => `<tr><td><strong>${escape(item.name)}</strong><small>${escape(state.projects.find(p => p.id === item.projectId)?.name)} · ${languageNames[item.language]} · ${item.kind === 'mcp' ? 'MCP' : '앱'}</small></td><td><span class="endpoint">${escape(item.dockerfile)}</span><small>컨텍스트: ${escape(item.buildContext)}</small><small>소스: ${escape(item.sourcePath)}</small></td><td><span class="endpoint">${escape(item.basePath)}/</span><small>내부 포트 ${item.containerPort} · ${state.buildJobs.some(job => job.active && job.serviceId === item.id) ? '활성 배포 있음' : '미배포'}</small></td><td><div class="service-actions"><button class="text-button" data-plan="${item.id}">배포 계획</button><button class="text-button" data-edit="${item.id}">편집</button><button class="text-button danger" data-delete="services" data-id="${item.id}" data-name="${escape(item.name)}">삭제</button></div></td></tr>`).join('')}</tbody></table></div>`;
}

function buildQueue() {
  if (!state.buildJobs.length) return '<p class="quiet">등록된 배포 작업이 없습니다.</p>';
  const status = { queued: '대기', running: '실행 중', deployed: '완료', failed: '실패' };
  const rows = state.buildJobs.map(job => {
    const service = state.services.find(item => item.id === job.serviceId);
    const project = state.projects.find(item => item.id === service?.projectId);
    const label = job.active ? `활성${job.hostPort ? ` · 호스트 ${job.hostPort}` : ''}` : status[job.status];
    const evidence = job.evidence;
    const detail = evidence ? `<small title="${escape(evidence.image)}">이미지 ${escape(evidence.image.slice(7, 19))}${evidence.migrationVersion ? ` · DB ${escape(evidence.migrationVersion)}` : ''}</small>` : '';
    const action = job.status === 'queued' ? `<button class="text-button" data-cancel-build="${escape(job.id)}">취소</button>` : '';
    return `<tr><td>${escape(project?.name)} / ${escape(service?.name)}</td><td><code class="endpoint" title="${escape(job.commitSha)}">${escape(job.commitSha.slice(0, 12))}</code></td><td>${new Date(job.createdAt).toLocaleString('ko-KR')}</td><td>${label}${job.error ? `<small>${escape(job.error)}</small>` : ''}${detail}</td><td>${action}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr><th>프로젝트 / 서비스</th><th>커밋</th><th>등록 시각</th><th>상태</th><th>작업</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function mcpTable() {
  if (!state.mcps.length) return empty('⌘', '연결할 도구를 모아보세요', '외부 MCP를 등록하거나 직접 배포할 MCP를 연결하세요.', 'mcp', 'MCP 등록');
  return `<div class="table-wrap"><table><thead><tr><th>MCP / 연결 주소</th><th>출처</th><th>상태</th><th>연결</th><th><span class="sr-only">작업</span></th></tr></thead><tbody>${state.mcps.map(m => `<tr><td><strong>${escape(m.name)}</strong><small class="endpoint">${escape(m.endpoint)}</small></td><td>${m.source === 'managed' ? '직접 배포' : '외부 서비스'}</td><td><span class="badge neutral">연결 미확인</span></td><td>${state.bindings.filter(b => b.mcpId === m.id).length}개 프로젝트</td><td><button class="text-button danger" data-delete="mcps" data-id="${m.id}" data-name="${escape(m.name)}">삭제</button></td></tr>`).join('')}</tbody></table></div>`;
}
function connections() {
  const intro = '<p class="section-note">정책은 설계 정보로 저장됩니다. MCP 호출 및 실제 권한 집행은 후속 버전에서 지원합니다.</p>';
  if (!state.bindings.length) return intro + empty('⇄', '아직 연결된 MCP가 없습니다', '프로젝트와 MCP를 각각 등록한 다음 연결하세요.', state.projects.length && state.mcps.length ? 'binding' : '', 'MCP 연결');
  return intro + `<div class="connection-list">${state.bindings.map(b => `<div class="connection"><strong>${escape(state.projects.find(p => p.id === b.projectId)?.name)}</strong><span class="connection-arrow">→</span><strong>${escape(state.mcps.find(m => m.id === b.mcpId)?.name)}</strong><span class="badge">${b.policy === 'read-only' ? '읽기 전용 예정' : '승인 후 실행 예정'}</span><button class="text-button danger" data-delete="bindings" data-id="${b.id}" data-name="MCP 연결">해제</button></div>`).join('')}</div>`;
}
function activity(limit = 30) {
  if (!state.events.length) return '<div class="quiet">등록과 연결을 시작하면 변경 이력이 여기에 표시됩니다.</div>';
  return `<div class="activity-list">${state.events.slice(0, limit).map(e => `<div class="event"><span class="event-icon">↗</span><div><strong>${escape(e.name)}</strong><small>${escape(actionNames[e.action] ?? e.action)}</small></div><time>${new Date(e.createdAt).toLocaleString('ko-KR')}</time></div>`).join('')}</div>`;
}
function section(title: string, content: string, action = ''): string { return `<section><div class="section-heading"><h2>${title}</h2>${action}</div>${content}</section>`; }
function repositoryPanel() {
  const title = '저장소 · Forgejo';
  if (!forgejo) return section(title, '<p class="quiet">Forgejo 상태를 확인하고 있습니다.</p>');
  const { settings, state: status, url } = forgejo;
  const disabled = forgejoBusy ? 'disabled' : '';
  const labels = { unconfigured: '미설치', starting: '시작 중', setup: '초기 설정 필요', ready: '실행 중', stopped: '중지', unavailable: 'Docker 연결 확인 필요' };
  const running = ['starting', 'setup', 'ready'].includes(status);
  const open = url && running ? `<a class="button secondary" href="${escape(url)}" target="_blank" rel="noopener">Forgejo 열기</a>` : '';
  const lifecycle = settings ? `<p class="field-note">저장 경로 <strong>${escape(settings.dataPath)}</strong> · 포트 ${settings.port}</p>
      <div class="git-actions">${open}${running ? `<button class="button secondary" data-forgejo="stop" ${disabled}>중지</button>`
        : `<button class="button secondary" data-forgejo="start" ${disabled}>시작</button>`}
        <button class="button secondary" data-forgejo="refresh" ${disabled}>상태 새로고침</button></div>`
    : `<form id="forgejo-start-form" class="shared-form">
      <label>호스트 저장 경로<input name="dataPath" required maxlength="1024" value="${escape(forgejo.defaultPath)}"></label>
      <button class="button primary" ${disabled}>설치 및 시작</button>
    </form>`;
  const authentication = status === 'ready' ? `<form id="forgejo-token-form" class="shared-form">
      <label>저장소 관리 토큰<input name="token" type="password" required maxlength="2048" autocomplete="off" spellcheck="false"></label>
      <button class="button secondary" ${disabled}>${settings?.owner ? '토큰 교체' : '토큰 등록'}</button>
      ${settings?.owner ? `<button type="button" class="text-button danger" data-forgejo="forget" ${disabled}>토큰 제거</button>` : ''}
    </form><p class="field-note">${settings?.owner ? `연결된 계정 ${escape(settings.owner)}. ` : ''}Forgejo 설정 → 애플리케이션에서 모든 저장소 접근, write:user, write:repository 권한으로 생성하세요.</p>` : '';
  const rows = repositories.map(repository => `<tr><td><a href="${escape(repository.cloneUrl.slice(0, -4))}" target="_blank" rel="noopener"><strong>${escape(repository.fullName)}</strong></a><small class="endpoint">${escape(repository.cloneUrl)}</small></td>
    <td>${repository.private ? '비공개' : '공개'}</td><td>${repository.empty ? '커밋 없음' : escape(repository.branch)}</td></tr>`).join('');
  return section(title, `<div class="project-card forgejo-panel"><strong>${labels[status]}</strong>
    <p role="status" class="section-note">${escape(forgejoMessage || (status === 'setup' ? 'Forgejo를 열고 첫 관리자 계정을 만든 뒤 상태를 새로고침하세요.' : ''))}</p>
    ${lifecycle}${authentication}
    ${status === 'ready' && settings?.owner ? `<form id="forgejo-repository-form" class="shared-form">
      <label>새 저장소 이름<input required maxlength="100" name="name" placeholder="objet-backend"></label>
      <label>공개 범위<select name="visibility"><option value="private">비공개</option><option value="public">공개</option></select></label>
      <label>초기 파일<select name="initialize"><option value="">빈 저장소</option><option value="yes">README 생성</option></select></label>
      <button class="button primary" ${disabled}>저장소 생성</button>
    </form>${rows ? `<div class="table-wrap"><table><thead><tr><th>저장소</th><th>공개 범위</th><th>브랜치</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="field-note">표시할 저장소가 없습니다.</p>'}` : ''}
    </div>`);
}
async function loadForgejo() {
  forgejo = await request<ForgejoStatus>('/api/forgejo');
  repositories = [];
  if (forgejo.state === 'ready' && forgejo.settings?.owner) {
    try { repositories = await request<ForgejoRepository[]>('/api/forgejo/repositories'); }
    catch (error) { forgejoMessage = errorMessage(error); }
  }
  if (view === 'shared') render();
}
async function changeForgejo(path: string, method: string, data?: unknown) {
  if (forgejoBusy) return;
  forgejoBusy = true;
  forgejoMessage = 'Forgejo 요청을 처리하고 있습니다.';
  render();
  try {
    await request(`/api/forgejo/${path}`, method, data);
    forgejoMessage = '';
  } catch (error) { forgejoMessage = errorMessage(error); }
  finally {
    forgejoBusy = false;
    await loadForgejo().catch(showError);
  }
}
function nginxPanel() {
  if (!nginx) return section('Nginx', '<p class="quiet">Nginx 상태를 확인하고 있습니다.</p>');
  const local = nginx.mode === 'docker';
  const selected = nginx.sites.find(site => site.domain === nginxEdit);
  const applied = nginx.applied;
  const sameSite = (site: NginxState['sites'][number], other?: NginxState['sites'][number]) =>
    Boolean(other && site.target === other.target && site.port === other.port && site.tls === other.tls);
  const editedDomains = nginx.sites.filter(site => !sameSite(site, applied.find(item => item.domain === site.domain))).map(site => site.domain);
  const removedDomains = applied.filter(site => !nginx!.sites.some(item => item.domain === site.domain)).map(site => site.domain);
  const statuses = { running: '실행 중', stopped: '중지', unavailable: '연결 확인 필요' };
  const button = (action: string, label: string, domain = '', disabled = false) =>
    `<button class="button secondary" type="button" data-nginx="${action}" data-domain="${escape(domain)}" ${nginxBusy || disabled ? 'disabled' : ''}>${label}</button>`;
  const choice = (value: string, label: string, chosen: string) =>
    `<option value="${escape(value)}" ${value === chosen ? 'selected' : ''}>${escape(label)}</option>`;
  const lanEnabled = nginx.bindAddress !== '127.0.0.1';
  const bindingForm = local ? `<form id="nginx-binding-form" class="shared-form">
    <label>접속 범위<select name="address">
      ${choice('127.0.0.1', '이 Mac에서만', nginx.bindAddress)}
      ${nginx.lanAddresses.map(address => choice(address, `LAN · ${address}`, nginx!.bindAddress)).join('')}
      ${lanEnabled && !nginx.lanAddresses.includes(nginx.bindAddress) ? `<option selected disabled value="${escape(nginx.bindAddress)}">사용할 수 없는 LAN 주소 · ${escape(nginx.bindAddress)}</option>` : ''}
    </select></label>
    <button class="button secondary" ${nginxBusy ? 'disabled' : ''}>접속 범위 적용</button>
    </form>
    ${lanEnabled && nginx.httpsPort ? `<p class="field-note">공유기 포트포워딩 대상 · 외부 TCP 443 → ${escape(nginx.bindAddress)}:${nginx.httpsPort}
      <br>HTTP를 외부에 제공하는 경우 · 외부 TCP 80 → ${escape(nginx.bindAddress)}:${nginx.httpPort}</p>`
      : '<p class="field-note">LAN 주소를 선택하고 Nginx를 시작하면 공유기에 입력할 주소와 포트가 표시됩니다.</p>'}` : '';
  const targets = local ? choice('port', '이 Mac의 앱 포트', selected?.target ?? 'port')
    : state.services.filter(service => state.buildJobs.some(job => job.serviceId === service.id && job.active))
      .map(service => choice('service:' + service.id, (state.projects.find(project => project.id === service.projectId)?.name ?? '') + ' / ' + service.name, selected?.target ?? '')).join('');
  const tlsOptions = [['http','HTTP'], ['private','사설 CA'], ...(!local ? [['existing','기존 운영 인증서'], ['acme','Let’s Encrypt']] : [])]
    .map(([value, label]) => choice(value, label, selected?.tls ?? 'http')).join('');
  const rows = nginx.sites.map(site => {
    const saved = applied.find(item => item.domain === site.domain);
    const active = sameSite(site, saved);
    const port = site.tls === 'http' ? nginx!.httpPort : nginx!.httpsPort;
    const target = site.target === 'forgejo' ? 'Forgejo' : site.target === 'port' ? `127.0.0.1:${site.port}`
      : state.services.find(service => 'service:' + service.id === site.target)?.name ?? '서비스';
    const link = `${site.tls === 'http' ? 'http' : 'https'}://${site.domain}${local ? ':' + port : ''}`;
    return `<tr><td><strong>${escape(site.domain)}</strong><small>${escape(target)} · ${active ? '적용됨' : '초안'}</small>
      ${active && port && nginx!.status === 'running' ? `<small><a href="${escape(link)}" target="_blank" rel="noopener">열기 ↗</a></small>` : ''}</td>
      <td>${{ http: 'HTTP', private: '사설 CA', existing: '기존 인증서', acme: 'Let’s Encrypt' }[site.tls]}</td>
      <td><div class="git-actions">${button('edit', '편집', site.domain)}${button('inspect', 'DNS·인증서', site.domain)}
      ${site.tls === 'private' ? button('private', '사설 인증서 발급·갱신', site.domain) : ''}
      ${site.tls === 'acme' ? button('edit', '발급·갱신', site.domain) : ''}
      ${button('delete', '제거', site.domain)}</div></td></tr>`;
  }).join('');
  const certificateForm = selected?.tls === 'acme' ? `<form id="nginx-certificate-form" class="shared-form">
    <input type="hidden" name="domain" value="${escape(selected.domain)}">
    <label>검증 방식<select name="method"><option value="http">HTTP-01</option><option value="route53">DNS-01 · Route 53</option></select></label>
    <label>ACME 이메일<input name="email" type="email" placeholder="ops@example.com"></label>
    <label>실행 모드<select name="mode"><option value="staging">테스트</option><option value="production">실제 실행</option></select></label>
    <button name="action" value="issue" class="button secondary" ${nginxBusy ? 'disabled' : ''}>발급</button>
    <button name="action" value="renew" class="button secondary" ${nginxBusy ? 'disabled' : ''}>갱신</button>
    </form><p class="field-note">HTTP-01로 발급하려면 먼저 해당 도메인을 HTTP로 적용하세요. 발급 후 인증서 유형을 Let’s Encrypt로 적용합니다.</p>` : '';
  return section('Nginx', `<div class="project-card forgejo-panel nginx-panel">
    <div class="card-top"><strong>${statuses[nginx.status]}</strong><span class="badge neutral">${local ? 'Docker · 로컬' : 'Linux · systemd'}</span></div>
    ${nginx.httpPort ? `<p class="field-note">HTTP ${nginx.httpPort} · HTTPS ${nginx.httpsPort}</p>` : ''}
    <div class="git-actions">
      ${button('start', '시작', '', nginx.status === 'running')}${button('stop', '중지', '', nginx.status !== 'running')}${button('restart', '재시작', '', nginx.status !== 'running')}
      ${button('reload', '리로드', '', nginx.status !== 'running')}${button('logs', '최근 로그')}${local ? '' : button('timer', '자동 갱신 상태')}${button('refresh', '새로고침')}
    </div>
    ${nginxMessage ? `<pre class="field-note nginx-output" role="status">${escape(nginxMessage)}</pre>` : ''}
    ${bindingForm}
    <h3>도메인</h3>
    ${local ? `<p class="field-note">${lanEnabled ? '다른 기기에서 쓸 서비스 이름을 도메인으로 등록하세요.' : 'localhost를 쓰거나 DNS·hosts에서 도메인을 이 Mac의 127.0.0.1에 연결하세요.'}</p>` : ''}
    <form id="nginx-site-form" class="shared-form">
      <input type="hidden" name="previous" value="${escape(selected?.domain ?? '')}">
      <label>도메인<input name="domain" value="${escape(selected?.domain ?? '')}" required maxlength="253" placeholder="${local ? 'localhost' : 'app.example.com'}"></label>
      <label>연결 대상<select name="target" required>${targets}${choice('forgejo', 'Forgejo', selected?.target ?? '')}</select></label>
      ${local ? `<label data-nginx-port ${selected?.target === 'forgejo' ? 'hidden' : ''}>앱 포트<input name="port" type="number" min="1024" max="65535" value="${selected?.target === 'port' ? selected.port : ''}" placeholder="3000"></label>` : ''}
      <label>인증서<select name="tls">${tlsOptions}</select></label>
      <button class="button primary" ${nginxBusy ? 'disabled' : ''}>${selected ? '도메인 수정' : '도메인 추가'}</button>
      ${selected ? button('clear', '편집 닫기') : ''}
    </form>
    ${certificateForm}
    ${nginx.ca ? '<p class="field-note"><a class="button secondary" href="/api/nginx/ca">사설 CA 인증서 내려받기</a> HTTPS에 접속하는 기기의 신뢰 저장소에 설치하세요.</p>' : ''}
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>도메인</th><th>TLS</th><th>관리</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    <h3>설정</h3>
    ${editedDomains.length ? `<p class="field-note">추가·변경 ${escape(editedDomains.join(', '))}</p>` : ''}
    ${removedDomains.length ? `<p class="field-note">연결 해제 예정 ${escape(removedDomains.join(', '))}</p>` : ''}
    <div class="git-actions">${button('validate', '초안 검증')}${button('apply', '설정 적용')}${button('rollback', '이전 설정 복원', '', !nginx.canRollback)}</div>
    <details><summary>초안 보기</summary><pre class="nginx-output">${escape(nginx.preview)}</pre></details>
    <details><summary>현재 적용 설정 보기</summary><pre class="nginx-output">${escape(nginx.current)}</pre></details>
    </div>`);
}
async function loadNginx() {
  nginx = await request<NginxState>('/api/nginx');
  if (view === 'shared') render();
}
async function changeNginx(path: string, method: string, data?: unknown, after?: () => void) {
  if (nginxBusy) return;
  nginxBusy = true;
  nginxMessage = 'Nginx 작업을 처리하고 있습니다.';
  render();
  try {
    const result = await request<{ output?: string; addresses?: string[]; certificate?: string }>(`/api/nginx/${path}`, method, data);
    nginxMessage = result.addresses
      ? `DNS ${result.addresses.join(', ') || '조회 결과 없음'}${result.certificate ? '\n' + result.certificate : ''}`
      : result.output || (path === 'validate' ? 'Nginx 설정 검증을 통과했습니다.' : '완료했습니다.');
    after?.();
  } catch (error) { nginxMessage = errorMessage(error); }
  finally { nginxBusy = false; await loadNginx().catch(showError); }
}
function sharedPanel() {
  if (!shared) return nginxPanel() + repositoryPanel() + '<p class="quiet">공용 환경 상태를 확인하고 있습니다.</p>';
  const statusNames: Record<string, string> = { running: '실행 중', absent: '미설치', exited: '중지', starting: '시작 중', unhealthy: '상태 확인 필요', unknown: '연결 확인 필요' };
  const cards = shared.environments.map(item => `<article class="project-card">
    <h3>${item.environment}</h3>
    <ul class="shared-services">${item.services.map(service => `<li><strong>${sharedLabels[service.kind]}</strong><span>${escape(statusNames[service.status] ?? service.status)}</span></li>`).join('')}</ul>
    <button class="button secondary" data-start-shared="${item.environment}" ${sharedBusy || item.services.every(service => service.status === 'running') ? 'disabled' : ''}>공용 환경 시작</button>
    <button class="button secondary" data-stop-shared="${item.environment}" ${sharedBusy || !item.services.some(service => ['running','starting','unhealthy'].includes(service.status)) ? 'disabled' : ''}>중지</button>
  </article>`).join('');
  const resourceName = (resource: SharedResource) => resource.kind === 'minio' ? resource.name.replaceAll('_', '-')
    : resource.kind === 'redis' ? `${resource.name}:${resource.environment}:*` : resource.name;
  const rows = shared.resources.map(resource => `<tr><td>${escape(state.projects.find(project => project.id === resource.projectId)?.name)}</td>
    <td>${resource.environment}</td><td>${sharedLabels[resource.kind]}<small class="endpoint">${escape(resourceName(resource))}</small></td>
    <td>${resource.ready ? '연결 가능' : '생성 다시 시도 필요'}</td></tr>`).join('');
  return nginxPanel() + repositoryPanel() + `<p role="status" class="section-note">${escape(sharedMessage)}</p><div class="card-grid">${cards}</div>` +
    section('프로젝트 자원', (state.projects.length ? `<form id="shared-resource-form" class="shared-form">
      <label>프로젝트<select name="projectId" required><option value="">프로젝트 선택</option>${options(state.projects)}</select></label>
      <label>환경<select name="environment"><option value="dev">dev</option><option value="test">test</option><option value="release">release</option></select></label>
      <label>자원<select name="kind"><option value="postgres">PostgreSQL DB</option><option value="minio">MinIO 버킷</option><option value="redis">Redis 사용자</option></select></label>
      <button class="button primary" ${sharedBusy ? 'disabled' : ''}>자원 준비</button>
    </form>` : '<p class="quiet">프로젝트를 등록하면 자원을 연결할 수 있습니다.</p>') +
    (rows ? `<div class="table-wrap"><table><thead><tr><th>프로젝트</th><th>환경</th><th>자원</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''));
}
async function loadShared() {
  shared = await request<NonNullable<typeof shared>>('/api/shared-environments');
  if (view === 'shared') render();
}
async function changeShared(path: string, body?: unknown) {
  if (sharedBusy) return;
  sharedBusy = true;
  sharedMessage = '공용 환경을 준비하고 있습니다.';
  render();
  try {
    await request(path, 'POST', body);
    sharedMessage = '완료했습니다.';
  } catch (error) { sharedMessage = errorMessage(error); }
  finally {
    sharedBusy = false;
    await loadShared().catch(showError);
    if (view === 'shared') render();
  }
}
document.addEventListener('change', event => {
  if (!(event.target instanceof HTMLSelectElement) || !event.target.matches('#nginx-site-form [name=target]')) return;
  const port = document.querySelector<HTMLElement>('[data-nginx-port]');
  if (port) port.hidden = event.target.value !== 'port';
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !['nginx-site-form','nginx-certificate-form','nginx-binding-form'].includes(form.id)) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (form.id === 'nginx-binding-form') {
    const address = data.address;
    if (!address || address === nginx?.bindAddress) return;
    const scope = address === '127.0.0.1' ? '이 Mac에서만 접속하도록' : `LAN ${address}에서도 접속하도록`;
    const restart = nginx?.status === 'running' ? '\n변경하는 동안 Nginx 연결이 잠시 중단됩니다.' : '';
    if (confirm(`Nginx를 ${scope} 변경할까요?${restart}`)) {
      void changeNginx('bind', 'POST', { address, confirmed: true });
    }
    return;
  }
  if (form.id === 'nginx-site-form') {
    void changeNginx('sites', 'PUT', { ...data, port: Number(data.port) }, () => { nginxEdit = String(data.domain).trim().toLowerCase(); });
    return;
  }
  const action = (event as SubmitEvent).submitter;
  if (!(action instanceof HTMLButtonElement)) return;
  const staging = data.mode === 'staging';
  if (!staging && !confirm(`${data.domain}의 실제 인증서를 ${action.value === 'issue' ? '발급' : '갱신'}할까요? 발급 시 Let’s Encrypt 약관 동의가 포함됩니다.`)) return;
  void changeNginx(action.value, 'POST', { ...data, staging, confirmed: !staging });
});
document.addEventListener('submit', event => {
  if (!(event.target instanceof HTMLFormElement) || event.target.id !== 'shared-resource-form') return;
  event.preventDefault();
  const data = new FormData(event.target);
  const project = state.projects.find(item => item.id === data.get('projectId'));
  if (project) void changeShared(`/api/projects/${project.id}/shared-resources`, { environment: data.get('environment'), kind: data.get('kind') });
});
function render() {
  const [breadcrumb, title, description] = titles[view];
  $('#breadcrumb').textContent = breadcrumb; $('#page-title').textContent = title; $('#page-description').textContent = description;
  $('#nav-projects').textContent = String(state.projects.length); $('#nav-mcps').textContent = String(state.mcps.length); $('#nav-services').textContent = String(state.services.length);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  const connect = '<button class="button secondary small" data-open="binding">＋ MCP 연결</button>';
  const metrics = `<div class="metrics">${[['프로젝트', state.projects.length, '등록된 앱과 MCP 서버', '▦'], ['MCP 레지스트리', state.mcps.length, '직접 배포 및 외부 서비스', '⌘'], ['프로젝트 연결', state.bindings.length, '프로젝트와 도구의 연결', '⇄']].map(([label, number, sub, icon]) => `<div class="metric"><div>${label}<span>${icon}</span></div><strong>${number}<small>개</small></strong><p>${sub}</p></div>`).join('')}</div>`;
  $('#content').innerHTML = view === 'overview' ? metrics + section('프로젝트', projectCards(), '<button class="text-button" data-view="projects">모두 보기 ↗</button>') + section('MCP 레지스트리', mcpTable(), '<button class="text-button" data-view="mcps">모두 보기 ↗</button>') + section('최근 활동', activity(5))
    : view === 'projects' ? section(`프로젝트 <span class="count">${state.projects.length}</span>`, projectCards())
    : view === 'services' ? section(`서비스 <span class="count">${state.services.length}</span>`, serviceTable(), '<button class="button secondary small" data-open="service">＋ 서비스 추가</button>') + section('배포 작업', buildQueue(), '<button class="text-button" data-refresh>새로고침</button>')
    : view === 'mcps' ? section(`MCP 레지스트리 <span class="count">${state.mcps.length}</span>`, mcpTable())
    : view === 'shared' ? sharedPanel()
    : view === 'connections' ? section('프로젝트별 MCP 연결', connections(), connect)
    : section('변경 이력', activity());
}
const field = (label: string, name: string, placeholder = '', required = false, type = 'text'): string => `<label>${label}<input name="${name}" type="${type}" placeholder="${placeholder}" ${required ? 'required' : ''} maxlength="${type === 'url' ? 2048 : 253}"></label>`;
const options = (items: readonly { id: string; name: string }[]): string => items.map(item => `<option value="${item.id}">${escape(item.name)}</option>`).join('');
function gitFields(auth?: GitAuthSummary | null): string {
  return '<div class="git-fields">' +
    '<label>Git 제공자<select name="gitProvider"><option value="">주소로 자동 선택</option><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="forgejo">Forgejo</option></select></label>' +
    field('Git 사용자 이름', 'gitUsername', 'GitHub·Forgejo 사용자 이름') +
    '<label>PAT<input name="gitToken" type="password" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="' +
    (auth ? '교체할 때 새 토큰 입력' : '저장소 읽기 전용 토큰') + '"></label>' +
    '<div class="git-actions"><button type="button" class="button secondary" data-check-git>연결 확인</button>' +
    (auth ? '<button type="button" class="text-button danger" data-remove-git>PAT 삭제</button>' : '') +
    '</div><p id="git-status" role="status" class="field-note" hidden></p></div>';
}
function gitAuthFromForm(body: Record<string, unknown>) {
  if (!body.gitToken) return undefined;
  return { provider: body.gitProvider, username: body.gitUsername, token: body.gitToken };
}
function providerFor(repository: string) {
  try {
    const url = new URL(repository.trim());
    return url.origin === forgejo?.url ? 'forgejo'
      : url.hostname === 'github.com' ? 'github' : url.hostname === 'gitlab.com' ? 'gitlab' : '';
  } catch { return ''; }
}
function wireRepositoryPicker() {
  const picker = $<HTMLSelectElement>('#forgejo-picker');
  const note = $('#forgejo-picker-note');
  const url = control('repository') as HTMLInputElement;
  const branch = control('branch');
  let priorUrl = '';
  let priorBranch = branch.value;
  url.addEventListener('change', () => { control('gitProvider').value = providerFor(url.value); });
  picker.disabled = true;
  void request<ForgejoRepository[]>('/api/forgejo/repositories').then(items => {
    if (!picker.isConnected) return;
    picker.insertAdjacentHTML('beforeend', items.map(repo => `<option value="${escape(repo.cloneUrl)}">${escape(repo.fullName)}${repo.private ? ' · 비공개' : ''}</option>`).join(''));
    picker.disabled = !items.length;
    note.textContent = items.length ? '' : '공용 환경에서 Forgejo 저장소를 연결하면 여기에서 선택할 수 있습니다.';
    picker.addEventListener('change', () => {
      const selected = items.find(repo => repo.cloneUrl === picker.value);
      if (!url.readOnly) { priorUrl = url.value; priorBranch = branch.value; }
      url.readOnly = Boolean(selected);
      url.value = selected?.cloneUrl ?? priorUrl;
      branch.value = selected?.branch ?? priorBranch;
      control('gitProvider').value = selected ? 'forgejo' : providerFor(url.value);
      note.textContent = [selected?.private ? '비공개 저장소의 프로젝트 배포에는 별도의 읽기 PAT가 필요합니다.' : '',
        selected?.empty ? '첫 커밋을 푸시한 뒤 배포할 수 있습니다.' : ''].filter(Boolean).join(' ');
      if (selected?.private) $<HTMLDetailsElement>('.git-auth-panel').open = true;
    });
  }).catch(error => { if (picker.isConnected) note.textContent = errorMessage(error); });
}
function openEditor(type: EditorType, projectId = '', serviceId = ''): void {
  const gitProject = type === 'git-auth' ? state.projects.find(item => item.id === projectId) : undefined;
  if (type === 'git-auth' && !gitProject?.repository) return;
  editorType = type;
  editingServiceId = serviceId;
  editingGitProjectId = gitProject?.id ?? '';
  $<HTMLFormElement>('#editor-form').reset(); $('#form-error').hidden = true;
  $('#dialog-title').textContent = { service: serviceId ? '서비스 편집' : '서비스 추가', project: '프로젝트 추가', mcp: 'MCP 등록', binding: '프로젝트에 MCP 연결', 'git-auth': 'Git 인증 관리' }[type];
  $<HTMLButtonElement>('#submit-dialog').disabled = false;
  $('#submit-dialog').textContent = type === 'git-auth' ? (gitProject?.gitAuth ? 'PAT 교체' : 'PAT 저장') : '등록하기';
  if (type === 'project') $('#form-fields').innerHTML = field('프로젝트 이름', 'name', 'my-awesome-app', true) + '<label>프로젝트 유형<select name="kind"><option value="app">애플리케이션</option><option value="mcp">MCP 서버</option></select></label>' + '<label>공용 Forgejo 저장소<select id="forgejo-picker"><option value="">직접 URL 입력</option></select></label><p id="forgejo-picker-note" class="field-note" role="status">저장소 목록을 불러오는 중…</p>' + field('Git 저장소 URL · 선택', 'repository', 'https://github.com/you/project', false, 'url') + field('배포 브랜치', 'branch', 'main', true) + field('도메인 · 선택', 'domain', 'app.example.com') + '<details class="git-auth-panel"><summary>비공개 저장소 인증</summary>' + gitFields() + '</details>';
  if (type === 'project') {
    control('branch').value = 'main';
    wireRepositoryPicker();
  }
  if (gitProject) {
    $('#form-fields').innerHTML = `<p class="field-note endpoint">${escape(gitProject.repository)}</p>
      <p class="field-note">${gitProject.gitAuth ? 'PAT 저장됨' : '등록된 PAT 없음'}</p>` + gitFields(gitProject.gitAuth);
    if (gitProject.gitAuth) {
      control('gitProvider').value = gitProject.gitAuth.provider;
      control('gitUsername').value = gitProject.gitAuth.username;
    } else {
      control('gitProvider').value = providerFor(gitProject.repository);
    }
    control('gitToken').required = true;
  }
  if (type === 'service') {
    $('#form-fields').innerHTML = `<label>프로젝트<select name="projectId" required aria-label="프로젝트"><option value="">프로젝트 선택</option>${options(state.projects)}</select></label>` + field('서비스 이름', 'name', 'api', true) + '<div class="field-row"><label>언어<select name="language" aria-label="언어"><option value="python">Python</option><option value="rust">Rust</option><option value="typescript">TypeScript</option></select></label><label>서비스 유형<select name="kind" aria-label="서비스 유형"><option value="app">애플리케이션</option><option value="mcp">MCP 서버</option></select></label></div>' + field('소스 경로', 'sourcePath', 'apps/api', true) + field('Dockerfile 경로 · 저장소 루트 기준', 'dockerfile', 'apps/api/Dockerfile', true) + field('빌드 컨텍스트 · 저장소 루트 기준', 'buildContext', '.', true) + '<div class="field-row">' + field('컨테이너 내부 포트', 'containerPort', '8000', true, 'number') + field('상태 확인 경로 · 서비스 내부', 'healthPath', '/health', true) + '</div>' + field('접속 경로 이름 · 비우면 프로젝트 루트', 'routeSegment', 'api') + field('변경 감지 경로 · 쉼표로 구분', 'watchPaths', 'apps/api/**, packages/shared/**') + `
      <div class="field-row">
        <label>호스트 포트 유형<select name="portClass"><option value="web">웹앱 · 3000–3999</option><option value="api">API · 4000–4999</option></select></label>
        <label>배포 환경<select name="environment"><option value="dev">dev</option><option value="test">test</option><option value="release">release</option></select></label>
      </div>
      <label>기존 DB 연결<select name="databaseRef"><option value="">연결 없음</option></select></label>
      <div class="field-row"><label>공용 MinIO<select name="storageRef"><option value="">연결 없음</option></select></label>
        <label>공용 Redis<select name="redisRef"><option value="">연결 없음</option></select></label></div>
      <label>배포 전 마이그레이션 명령 (JSON 배열)<input name="migration" placeholder='["/app/migrate"]' maxlength="8000"></label>
      <label id="test-command-field">test 검증 명령 (JSON 배열)<input name="verification" placeholder='["/app/verify"]' maxlength="8000"></label>
      <label class="checkbox-line"><input type="checkbox" name="portableImage"> test에서 검증한 동일 이미지로 release 배포</label>`;
    const item = state.services.find(item => item.id === serviceId);
    const defaults = item ?? { name: '', projectId: projectId || state.projects[0]?.id || '', language: 'python', kind: 'app', sourcePath: '.', dockerfile: 'Dockerfile', buildContext: '.', containerPort: 8000, healthPath: '/health', routeSegment: '' };
    for (const key of ['projectId','name','language','kind','sourcePath','dockerfile','buildContext','containerPort','healthPath','routeSegment'] as const) control(key).value = String(defaults[key]);
    control('watchPaths').value = item?.watchPaths.join(', ') ?? '';
    const settings = item?.deployment;
    control('portClass').value = settings?.portClass ?? (item?.kind === 'mcp' || item?.name === 'api' || item?.name.endsWith('-api') || item?.routeSegment === 'api' ? 'api' : 'web');
    control('environment').value = settings?.environment ?? 'dev';
    control('migration').value = settings?.migration.length ? JSON.stringify(settings.migration) : '';
    control('verification').value = settings?.verification?.length ? JSON.stringify(settings.verification) : '';
    $<HTMLInputElement>('[name=portableImage]').checked = settings?.portableImage ?? !item;
    const environmentSelect = control('environment');
    const projectSelect = control('projectId');
    const boundSelectors = { postgres: control('databaseRef'), minio: control('storageRef'), redis: control('redisRef') };
    const currentRefs = { postgres: settings?.databaseRef, minio: settings?.storageRef, redis: settings?.redisRef };
    type Choice = { id: string; environment: DeployEnvironment; name?: string };
    let optionRequest = 0;
    async function refreshResources(restore = false) {
      const version = ++optionRequest;
      const environment = environmentSelect.value;
      const project = projectSelect.value;
      const [db, resources] = await Promise.all([
        request<Choice[]>(`/api/database-connections?projectId=${encodeURIComponent(project)}`),
        request<SharedResource[]>('/api/shared-resources')
      ]);
      if (version !== optionRequest || !projectSelect.isConnected) return;
      for (const kind of ['postgres', 'minio', 'redis'] as const) {
        const field = boundSelectors[kind];
        const choices: Choice[] = kind === 'postgres' ? db : resources.filter(resource => resource.kind === kind && resource.projectId === project && resource.ready);
        const matching = choices.filter(entry => entry.environment === environment);
        const keep = restore && settings?.environment === environment ? currentRefs[kind] || '' : '';
        if (keep && !matching.some(entry => entry.id === keep)) matching.push({ id: keep, environment: environment as DeployEnvironment });
        field.replaceChildren(new Option('연결 없음', ''), ...matching.map(entry => new Option(entry.name || entry.id, entry.id)));
        field.value = keep;
      }
    }
    for (const kind of ['postgres', 'minio', 'redis'] as const) {
      const current = currentRefs[kind];
      if (current) {
        (boundSelectors[kind] as HTMLSelectElement).add(new Option(current, current));
        boundSelectors[kind].value = current;
      }
    }
    const clearResources = () => {
      for (const field of Object.values(boundSelectors)) field.replaceChildren(new Option('연결 없음', ''));
      void refreshResources().catch(showError);
    };
    void refreshResources(true).catch(showError);
    projectSelect.addEventListener('change', clearResources);
    const toggleVerification = () => { $('#test-command-field').hidden = environmentSelect.value !== 'test'; };
    toggleVerification();
    environmentSelect.addEventListener('change', () => { clearResources(); toggleVerification(); });
    control('projectId').disabled = Boolean(item);
    $<HTMLInputElement>('[name=containerPort]').min = '1'; $<HTMLInputElement>('[name=containerPort]').max = '65535';
    $<HTMLInputElement>('[name=watchPaths]').maxLength = 8000;
    control('language').addEventListener('change', () => { control('containerPort').value = String(({ python: 8000, rust: 8080, typescript: 3000 } as Record<string, number>)[control('language').value]); });
    $<HTMLButtonElement>('#submit-dialog').disabled = !state.projects.length;
  }
  if (type === 'mcp') {
    $('#form-fields').innerHTML = field('MCP 이름', 'name', 'my-tools', true) + '<label>출처<select name="source" id="mcp-source"><option value="external">외부 MCP</option><option value="managed">직접 배포할 MCP</option></select></label>' + `<label id="managed-field" hidden>배포 프로젝트<select name="projectId"><option value="">MCP 제공 프로젝트 선택</option>${options(state.projects.filter(p => p.kind === 'mcp' || state.services.some(item => item.projectId === p.id && item.kind === 'mcp')))}</select></label><label id="managed-service-field" hidden>MCP 제공 서비스<select name="serviceId" aria-label="MCP 제공 서비스"><option value="">기존 MCP 프로젝트 사용</option></select></label>` + field('Streamable HTTP 연결 주소', 'endpoint', 'https://tools.example.com/mcp', true, 'url') + field('인증 참조 · 선택', 'credentialRef', 'env:MY_MCP_TOKEN') + '<p class="field-note">비밀값 대신 참조 이름만 저장하세요. 인증 참조 해석과 실제 연결은 아직 실행하지 않습니다.</p>';
    const provider = control('projectId');
    const fillServices = () => {
      control('serviceId').innerHTML = '<option value="">기존 MCP 프로젝트 사용</option>' + options(state.services.filter(item => item.projectId === provider.value && item.kind === 'mcp'));
    };
    provider.addEventListener('change', fillServices);
    $<HTMLSelectElement>('#mcp-source').addEventListener('change', () => { $('#managed-field').hidden = $('#managed-service-field').hidden = control('source').value !== 'managed'; fillServices(); });
  }
  if (type === 'binding') {
    $('#form-fields').innerHTML = `<label>사용할 프로젝트<select name="projectId" required><option value="">프로젝트 선택</option>${options(state.projects)}</select></label><label>연결할 MCP<select name="mcpId" required><option value="">MCP 선택</option>${options(state.mcps)}</select></label><label>향후 실행 정책<select name="policy"><option value="read-only">읽기 전용</option><option value="approval-required">승인 후 실행</option></select></label><p class="field-note">정책을 저장하는 단계입니다. MCP 실행 기능은 아직 제공하지 않습니다.</p>`;
    $<HTMLButtonElement>('#submit-dialog').disabled = !state.projects.length || !state.mcps.length;
  }
  $<HTMLDialogElement>('#editor').showModal();
}
async function verifyGit(button: HTMLButtonElement) {
  const body = Object.fromEntries(new FormData($<HTMLFormElement>('#editor-form')));
  const auth = gitAuthFromForm(body);
  const status = $('#git-status');
  status.hidden = false;
  if (!auth && !editingGitProjectId) {
    status.textContent = '연결을 확인할 PAT를 입력하세요.';
    return;
  }
  button.disabled = true;
  status.textContent = '저장소 읽기 권한을 확인하는 중…';
  try {
    if (editingGitProjectId) {
      await request(`/api/projects/${editingGitProjectId}/git-auth/check`, 'POST', auth ? { gitAuth: auth } : {});
    } else {
      await request('/api/git-auth/check', 'POST', { repository: body.repository, gitAuth: auth });
    }
    status.textContent = '저장소를 읽을 수 있습니다.';
  } catch (error) { status.textContent = errorMessage(error); }
  finally { button.disabled = false; }
}
document.addEventListener('click', async event => {
  const button = event.target instanceof Element ? event.target.closest('button') : null; if (!button) return;
  if (button.dataset.view && isView(button.dataset.view)) {
    view = button.dataset.view; render();
    if (view === 'shared') void Promise.all([loadShared(), loadForgejo(), loadNginx()]).catch(showError);
  }
  if (button.dataset.nginx) {
    const { nginx: action, domain = '' } = button.dataset;
    if (action === 'refresh') { nginxMessage = ''; await loadNginx().catch(showError); return; }
    if (action === 'edit' || action === 'clear') { nginxEdit = action === 'edit' ? domain : ''; render(); return; }
    if (action === 'delete') {
      if (confirm(`${domain}을 초안에서 제거할까요? 설정을 적용하면 연결이 해제됩니다.`)) {
        await changeNginx(`sites?domain=${encodeURIComponent(domain)}`, 'DELETE', undefined, () => { nginxEdit = ''; });
      }
      return;
    }
    if (action === 'inspect') { await changeNginx(`inspect?domain=${encodeURIComponent(domain)}`, 'GET'); return; }
    if (['stop','restart','rollback'].includes(action)) {
      const domains = nginx?.applied.map(site => site.domain).join(', ');
      if (!confirm(`Nginx에서 ${button.textContent?.trim()}을 실행할까요?${domains ? '\n연결된 도메인 ' + domains : ''}`)) return;
    }
    await changeNginx(action, 'POST', { domain, confirmed: true });
    return;
  }
  if (button.dataset.forgejo === 'start') await changeForgejo('start', 'POST', {});
  if (button.dataset.forgejo === 'stop' && confirm('Forgejo를 중지할까요? 저장소에 접속할 수 없게 됩니다.')) await changeForgejo('stop', 'POST');
  if (button.dataset.forgejo === 'refresh') { forgejoMessage = ''; await loadForgejo().catch(showError); }
  if (button.dataset.forgejo === 'forget' && confirm('Dama에서 Forgejo 관리 토큰을 제거할까요?')) await changeForgejo('token', 'DELETE');
  if (button.dataset.startShared) await changeShared(`/api/shared-environments/${button.dataset.startShared}/start`);
  if (button.dataset.stopShared && confirm(`${button.dataset.stopShared} 공용 환경을 중지하면 연결된 앱의 DB·저장소·Redis 접속이 끊깁니다. 중지할까요?`)) {
    await changeShared(`/api/shared-environments/${button.dataset.stopShared}/stop`, { confirmed: true });
  }
  if (button.dataset.open && isEditorType(button.dataset.open)) openEditor(button.dataset.open, button.dataset.project ?? '');
  if (button.hasAttribute('data-check-git')) await verifyGit(button);
  if (button.hasAttribute('data-remove-git') && editingGitProjectId && confirm('저장된 PAT를 삭제할까요?')) {
    button.disabled = true;
    try {
      await request(`/api/projects/${editingGitProjectId}/git-auth`, 'DELETE');
      $<HTMLDialogElement>('#editor').close();
      await refresh();
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
  }
  if (button.dataset.edit) openEditor('service', '', button.dataset.edit);
  if (button.dataset.plan) {
    try {
      lastPlan = await request<DeploymentPlan>(`/api/services/${button.dataset.plan}/deployment-plan`);
      $('#plan-output').textContent = JSON.stringify(lastPlan, null, 2);
      const form = $<HTMLFormElement>('#queue-build-form');
      form.reset();
      form.hidden = !lastPlan.source.repository;
      configurePromotion(lastPlan);
      $('#queue-build-error').hidden = true;
      $<HTMLDialogElement>('#plan-dialog').showModal();
    } catch (error) { showError(error); }
  }
  if (button.hasAttribute('data-refresh')) await refresh().catch(showError);
  if (button.dataset.cancelBuild) {
    button.disabled = true;
    try { await request(`/api/build-jobs/${button.dataset.cancelBuild}`, 'DELETE'); await refresh(); }
    catch (error) { showError(error); button.disabled = false; }
  }
  if (button.dataset.delete) {
    if (!confirm(`“${button.dataset.name}” 항목을 삭제할까요? 관련 MCP 연결도 해제됩니다. 실제 컨테이너나 외부 서비스는 삭제되지 않습니다.`)) return;
    button.disabled = true;
    try { await request(`/api/${button.dataset.delete}/${button.dataset.id}`, 'DELETE'); await refresh(); }
    catch (error) { showError(error); button.disabled = false; }
  }
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !['forgejo-start-form', 'forgejo-token-form', 'forgejo-repository-form'].includes(form.id)) return;
  event.preventDefault();
  const data = new FormData(form);
  if (form.id === 'forgejo-start-form') void changeForgejo('start', 'POST', { dataPath: data.get('dataPath') });
  if (form.id === 'forgejo-token-form') void changeForgejo('token', 'PUT', { token: data.get('token') });
  if (form.id === 'forgejo-repository-form') void changeForgejo('repositories', 'POST', {
    name: data.get('name'), private: data.get('visibility') === 'private', initialize: data.get('initialize') === 'yes'
  });
});
$<HTMLDialogElement>('#editor').addEventListener('close', () => {
  const secret = $<HTMLFormElement>('#editor-form').elements.namedItem('gitToken');
  if (secret instanceof HTMLInputElement) secret.value = '';
});
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $<HTMLDialogElement>('#editor').close();
$<HTMLFormElement>('#editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  const body: Record<string, unknown> = Object.fromEntries(new FormData($<HTMLFormElement>('#editor-form')));
  const auth = gitAuthFromForm(body);
  delete body.gitToken;
  delete body.gitProvider;
  delete body.gitUsername;
  if (editorType === 'project' && auth) body.gitAuth = auth;
  if (editorType === 'mcp') body.transport = 'streamable-http';
  if (editorType === 'service') {
    let migration: unknown = [];
    let verification: unknown = [];
    try {
      if (body.migration) migration = JSON.parse(String(body.migration));
      if (body.environment === 'test' && body.verification) verification = JSON.parse(String(body.verification));
    }
    catch { $('#form-error').textContent = '마이그레이션과 검증 명령을 JSON 배열로 입력하세요.'; $('#form-error').hidden = false; return; }
    body.deployment = { portClass: body.portClass, environment: body.environment, databaseRef: body.databaseRef, storageRef: body.storageRef, redisRef: body.redisRef, migration, verification, portableImage: body.portableImage === 'on' };
    for (const key of ['portClass', 'environment', 'databaseRef', 'storageRef', 'redisRef', 'migration', 'verification', 'portableImage']) delete body[key];
    body.containerPort = Number(body.containerPort);
    body.watchPaths = String(body.watchPaths ?? '').split(',').map(path => path.trim()).filter(Boolean);
  }
  const path = editorType === 'git-auth' ? `/api/projects/${editingGitProjectId}/git-auth` : editorType === 'service' ? (editingServiceId ? `/api/services/${editingServiceId}` : `/api/projects/${body.projectId}/services`) : editorType === 'project' ? '/api/projects' : editorType === 'mcp' ? '/api/mcps' : `/api/projects/${body.projectId}/bindings`;
  $<HTMLButtonElement>('#submit-dialog').disabled = true;
  try { await request(path, editingServiceId || editingGitProjectId ? 'PUT' : 'POST', editorType === 'git-auth' ? auth : body); $<HTMLDialogElement>('#editor').close(); await refresh(); }
  catch (error) { $('#form-error').textContent = errorMessage(error); $('#form-error').hidden = false; }
  finally { $<HTMLButtonElement>('#submit-dialog').disabled = false; }
});
$('#close-plan').onclick = () => $<HTMLDialogElement>('#plan-dialog').close();
const queueBuildForm = $<HTMLFormElement>('#queue-build-form');
function configurePromotion(plan: DeploymentPlan) {
  const select = $<HTMLSelectElement>('[name=promoteJobId]');
  const sha = $<HTMLInputElement>('[name=commitSha]');
  const active = plan.settings?.environment === 'release' && plan.settings.portableImage;
  $('#promotion-label').hidden = !active;
  select.disabled = !active;
  select.required = !!active;
  sha.readOnly = !!active;
  select.replaceChildren(new Option('test 이미지 선택', ''));
  if (!active) return;
  const jobs = state.buildJobs.filter(job => job.status === 'deployed' && job.evidence?.verifiedAt && state.services.some(service =>
    service.id === job.serviceId && service.projectId === plan.projectId && service.deployment?.environment === 'test' && service.deployment.portableImage));
  for (const job of jobs.reverse()) {
    const service = state.services.find(entry => entry.id === job.serviceId);
    select.add(new Option(`${service?.name} · ${job.commitSha.slice(0, 12)}`, job.id));
  }
}
$<HTMLSelectElement>('[name=promoteJobId]').addEventListener('change', event => {
  const id = (event.target as HTMLSelectElement).value;
  $<HTMLInputElement>('[name=commitSha]').value = state.buildJobs.find(job => job.id === id)?.commitSha ?? '';
});
queueBuildForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!lastPlan) return;
  const fields = new FormData(queueBuildForm);
  const commitSha = fields.get('commitSha');
  const promoteJobId = fields.get('promoteJobId');
  const submit = $<HTMLButtonElement>('#queue-build-submit');
  const errorElement = $('#queue-build-error');
  errorElement.hidden = true;
  submit.disabled = true;
  try {
    await request(`/api/services/${lastPlan.serviceId}/build-jobs`, 'POST', { commitSha, ...(promoteJobId ? { promoteJobId } : {}) });
    $<HTMLDialogElement>('#plan-dialog').close();
    await refresh().catch(showError);
  } catch (error) {
    errorElement.textContent = errorMessage(error);
    errorElement.hidden = false;
  } finally { submit.disabled = false; }
});
$('#download-plan').onclick = () => {
  if (!lastPlan) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(lastPlan, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `dama-${lastPlan.serviceId}-plan.json`; link.click(); URL.revokeObjectURL(url);
};
refresh().catch(showError);
