import type { Snapshot, DeploymentPlan, Language } from '../src/types.js';
type EditorType = 'project' | 'service' | 'mcp' | 'binding';
type View = 'overview' | 'projects' | 'services' | 'mcps' | 'connections' | 'activity';
let state: Snapshot = { projects: [], services: [], mcps: [], bindings: [], events: [], buildJobs: [], capabilities: { deployment: false, mcpExecution: false, authentication: false } };
let view: View = 'overview';
let editorType: EditorType = 'project';
let editingServiceId = '';
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
function isEditorType(value: string): value is EditorType { return ['project', 'service', 'mcp', 'binding'].includes(value); }
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[char]));
const titles = {
  overview: ['개요', '운영 공간을 한눈에.', '프로젝트와 MCP를 모으고, 필요한 곳에 연결하세요.'],
  projects: ['프로젝트', '아이디어가 실행되는 곳.', '웹 앱, API, MCP 서버를 하나의 목록에서 관리하세요.'],
  services: ['서비스', '언어는 달라도, 운영은 한곳에서.', '모노레포의 Python · Rust · TypeScript 서비스를 독립적으로 설정하세요.'],
  mcps: ['MCP 레지스트리', '도구를 한곳에 모으세요.', '직접 배포한 MCP와 외부 MCP의 연결 정보를 관리하세요.'],
  connections: ['연결 관리', '필요한 도구를, 필요한 곳에.', '프로젝트가 사용할 MCP와 향후 실행 정책을 지정하세요.'],
  activity: ['활동 기록', '변경의 흐름을 확인하세요.', '프로젝트와 MCP의 등록·삭제·연결 이력입니다.']
};
const actionNames: Record<string, string> = { 'project.created': '프로젝트 등록', 'service.created': '서비스 등록', 'service.updated': '서비스 수정', 'services.deleted': '서비스 삭제', 'build.queued': '빌드 작업 등록', 'build.cancelled': '빌드 작업 취소', 'build.deployed': '배포 완료', 'build.failed': '배포 실패', 'mcp.created': 'MCP 등록', 'binding.created': 'MCP 연결', 'projects.deleted': '프로젝트 삭제', 'mcps.deleted': 'MCP 삭제', 'bindings.deleted': '연결 해제' };
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
  return `<div class="card-grid">${state.projects.map(p => `<article class="project-card"><div class="card-top"><span class="app-icon">${p.kind === 'mcp' ? '⌘' : '▦'}</span><span class="badge neutral">${state.buildJobs.some(job => job.active && state.services.some(service => service.id === job.serviceId && service.projectId === p.id)) ? '활성 배포 있음' : '미배포'}</span></div><h3>${escape(p.name)}</h3><p class="domain">${escape(p.domain || '커스텀 도메인 미설정')}</p><p class="default-address">기본 주소 · 배포 예정<small>${escape(p.defaultUrl)}</small></p><div class="project-meta"><span>${p.kind === 'mcp' ? 'MCP 서버' : '애플리케이션'}</span><span>⑂ ${escape(p.branch)}</span></div><div class="card-bottom"><span>서비스 ${state.services.filter(item => item.projectId === p.id).length}개</span><button class="text-button" data-open="service" data-project="${p.id}">＋ 서비스</button><button class="text-button danger" data-delete="projects" data-id="${p.id}" data-name="${escape(p.name)}">삭제</button></div></article>`).join('')}</div>`;
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
    const label = job.active ? '활성' : status[job.status];
    const action = job.status === 'queued' ? `<button class="text-button" data-cancel-build="${escape(job.id)}">취소</button>` : '';
    return `<tr><td>${escape(project?.name)} / ${escape(service?.name)}</td><td><code class="endpoint" title="${escape(job.commitSha)}">${escape(job.commitSha.slice(0, 12))}</code></td><td>${new Date(job.createdAt).toLocaleString('ko-KR')}</td><td>${label}${job.error ? `<small>${escape(job.error)}</small>` : ''}</td><td>${action}</td></tr>`;
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
    : view === 'connections' ? section('프로젝트별 MCP 연결', connections(), connect)
    : section('변경 이력', activity());
}
const field = (label: string, name: string, placeholder = '', required = false, type = 'text'): string => `<label>${label}<input name="${name}" type="${type}" placeholder="${placeholder}" ${required ? 'required' : ''} maxlength="${type === 'url' ? 2048 : 253}"></label>`;
const options = (items: readonly { id: string; name: string }[]): string => items.map(item => `<option value="${item.id}">${escape(item.name)}</option>`).join('');
function openEditor(type: EditorType, projectId = '', serviceId = ''): void {
  editorType = type; editingServiceId = serviceId;
  $<HTMLFormElement>('#editor-form').reset(); $('#form-error').hidden = true;
  $('#dialog-title').textContent = { service: serviceId ? '서비스 편집' : '서비스 추가', project: '프로젝트 추가', mcp: 'MCP 등록', binding: '프로젝트에 MCP 연결' }[type];
  $<HTMLButtonElement>('#submit-dialog').disabled = false;
  if (type === 'project') $('#form-fields').innerHTML = field('프로젝트 이름', 'name', 'my-awesome-app', true) + '<label>프로젝트 유형<select name="kind"><option value="app">애플리케이션</option><option value="mcp">MCP 서버</option></select></label>' + field('Git 저장소 URL · 선택', 'repository', 'https://github.com/you/project', false, 'url') + field('배포 브랜치', 'branch', 'main', true) + field('도메인 · 선택', 'domain', 'app.example.com') + '<p class="field-note">현재는 정보 등록만 지원합니다. 서버 설정은 변경하지 않습니다.</p>';
  if (type === 'project') control('branch').value = 'main';
  if (type === 'service') {
    $('#form-fields').innerHTML = `<label>프로젝트<select name="projectId" required aria-label="프로젝트"><option value="">프로젝트 선택</option>${options(state.projects)}</select></label>` + field('서비스 이름', 'name', 'api', true) + '<div class="field-row"><label>언어<select name="language" aria-label="언어"><option value="python">Python</option><option value="rust">Rust</option><option value="typescript">TypeScript</option></select></label><label>서비스 유형<select name="kind" aria-label="서비스 유형"><option value="app">애플리케이션</option><option value="mcp">MCP 서버</option></select></label></div>' + field('소스 경로', 'sourcePath', 'apps/api', true) + field('Dockerfile 경로 · 저장소 루트 기준', 'dockerfile', 'apps/api/Dockerfile', true) + field('빌드 컨텍스트 · 저장소 루트 기준', 'buildContext', '.', true) + '<div class="field-row">' + field('컨테이너 내부 포트', 'containerPort', '8000', true, 'number') + field('상태 확인 경로 · 서비스 내부', 'healthPath', '/health', true) + '</div>' + field('접속 경로 이름 · 비우면 프로젝트 루트', 'routeSegment', 'api') + field('변경 감지 경로 · 쉼표로 구분', 'watchPaths', 'apps/api/**, packages/shared/**') + '<p class="field-note">루트는 /프로젝트UUID/, api는 /프로젝트UUID/api/에 연결됩니다. 앱은 해당 기본 경로를 지원해야 합니다. 변경 감지와 실제 배포는 아직 실행하지 않습니다.</p>';
    const form = $<HTMLFormElement>('#editor-form');
    const item = state.services.find(item => item.id === serviceId);
    const defaults = item ?? { name: '', projectId: projectId || state.projects[0]?.id || '', language: 'python', kind: 'app', sourcePath: '.', dockerfile: 'Dockerfile', buildContext: '.', containerPort: 8000, healthPath: '/health', routeSegment: '' };
    for (const key of ['projectId','name','language','kind','sourcePath','dockerfile','buildContext','containerPort','healthPath','routeSegment'] as const) control(key).value = String(defaults[key]);
    control('watchPaths').value = item?.watchPaths.join(', ') ?? '';
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
document.addEventListener('click', async event => {
  const button = event.target instanceof Element ? event.target.closest('button') : null; if (!button) return;
  if (button.dataset.view && isView(button.dataset.view)) { view = button.dataset.view; render(); }
  if (button.dataset.open && isEditorType(button.dataset.open)) openEditor(button.dataset.open, button.dataset.project ?? '');
  if (button.dataset.edit) openEditor('service', '', button.dataset.edit);
  if (button.dataset.plan) {
    try {
      lastPlan = await request<DeploymentPlan>(`/api/services/${button.dataset.plan}/deployment-plan`);
      $('#plan-output').textContent = JSON.stringify(lastPlan, null, 2);
      const form = $<HTMLFormElement>('#queue-build-form');
      form.reset();
      form.hidden = !lastPlan.source.repository;
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
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $<HTMLDialogElement>('#editor').close();
$<HTMLFormElement>('#editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  const body: Record<string, unknown> = Object.fromEntries(new FormData($<HTMLFormElement>('#editor-form')));
  if (editorType === 'mcp') body.transport = 'streamable-http';
  if (editorType === 'service') {
    body.containerPort = Number(body.containerPort);
    body.watchPaths = String(body.watchPaths ?? '').split(',').map(path => path.trim()).filter(Boolean);
  }
  const path = editorType === 'service' ? (editingServiceId ? `/api/services/${editingServiceId}` : `/api/projects/${body.projectId}/services`) : editorType === 'project' ? '/api/projects' : editorType === 'mcp' ? '/api/mcps' : `/api/projects/${body.projectId}/bindings`;
  $<HTMLButtonElement>('#submit-dialog').disabled = true;
  try { await request(path, editingServiceId ? 'PUT' : 'POST', body); $<HTMLDialogElement>('#editor').close(); await refresh(); }
  catch (error) { $('#form-error').textContent = errorMessage(error); $('#form-error').hidden = false; }
  finally { $<HTMLButtonElement>('#submit-dialog').disabled = false; }
});
$('#close-plan').onclick = () => $<HTMLDialogElement>('#plan-dialog').close();
const queueBuildForm = $<HTMLFormElement>('#queue-build-form');
queueBuildForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!lastPlan) return;
  const commitSha = new FormData(queueBuildForm).get('commitSha');
  const submit = $<HTMLButtonElement>('#queue-build-submit');
  const errorElement = $('#queue-build-error');
  errorElement.hidden = true;
  submit.disabled = true;
  try {
    await request(`/api/services/${lastPlan.serviceId}/build-jobs`, 'POST', { commitSha });
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
