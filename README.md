# Dama

내 서버의 앱과 MCP를 모으고 연결하는 셀프호스팅 운영 도구입니다. 기존 **Nginx + SSL → Docker 컨테이너** 운영을 자동화하고, 향후 로컬 AI 또는 GPT·Claude를 사용하는 운영 에이전트를 연결하는 것을 목표로 합니다.

현재는 **로컬 개발용 관리 기반 v0.1**입니다. 실제 배포 플랫폼으로 운영할 준비가 된 상태는 아닙니다.

## 설치 파일

macOS와 Windows용 설치 파일을 빌드하고 부팅 자동 시작을 등록할 수 있습니다. [설치 파일 빌드와 사용](docs/installers.md)을 참고하세요.

## 실행

Windows에서 WSL 준비부터 시작하려면 Dama 저장소의 관리자 PowerShell에서 다음 명령을 실행합니다. 기존 인증서 폴더를 입력하면 WSL 2, Dama 전용 Ubuntu, systemd와 Linux 패키지를 준비하고 Dama를 설치·검증합니다. 설치 중 Windows 계정 암호를 한 번 입력해 부팅 작업을 등록합니다. 재부팅이 필요하면 부팅 작업이 설치를 이어가고, 이후에도 로그인 전 WSL과 서비스를 시작하도록 구성합니다. [Windows 자동 설치](docs/windows-wsl-install.md)에 인증서 발급 옵션과 접속 범위를 정리했습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

새 Linux VM에 운영용으로 설치할 때는 `sudo bash scripts/install-linux-vm.sh --domain apps.example.com`를 사용합니다. 기존 인증서나 Route 53 DNS 검증 발급을 연결하는 옵션은 [Linux VM 설치](docs/windows-vm-startup.md)를 확인하세요.

Node.js 22.11 이상이 필요합니다. 서버·브라우저·테스트 소스는 TypeScript이며 TypeScript와 Node 타입 정의를 개발 의존성으로 사용합니다. 실행 코드는 Node 내장 모듈과 SQLite를 사용하고 GitHub Actions는 필요하지 않습니다. Node.js 22의 SQLite 실험적 기능 경고가 표시될 수 있습니다.

```sh
npm ci
npm start
```

npm start는 TypeScript를 먼저 빌드하고 `dist/src/server.js`를 실행합니다. 브라우저에서 http://127.0.0.1:3100 에 접속하세요. 데이터는 `data/dama.sqlite`에 저장됩니다. 빈 데이터로 시작하며 데모 데이터를 자동으로 넣지 않습니다.

```sh
PORT=3200 DAMA_DB=/tmp/dama-dev.sqlite npm start
npm run check  # 서버·브라우저 strict 타입 검사
npm test       # 빌드 후 테스트
npm run dev    # TypeScript 재컴파일 + 서버 재시작 감시
```

인증이 없는 로컬 개발 버전이므로 `127.0.0.1`에서만 수신하고 로컬 Host 및 동일 Origin만 허용합니다. 리버스 프록시로 공개하지 마세요. 현재는 Docker 소켓, Nginx 설정, 외부 MCP에 접근하지 않습니다.

## TypeScript 소스와 빌드

- `src/`: 관리 API, SQLite, 입력 검증, Nginx 설정 생성, 배포 계획
- `src/types.ts`: 서버와 화면이 공유하는 프로젝트·서비스·MCP·API 데이터 타입
- `public/app.ts`: 브라우저 화면 로직 (HTML·CSS는 그대로 유지)
- `test/`: TypeScript 통합 테스트
- `scripts/`: 정적 파일 복사와 개발 감시 스크립트

`npm run build`는 서버와 브라우저를 각각 검사·컴파일하고 HTML·CSS를 `dist/public`에 복사합니다. 빌드 결과인 JavaScript는 `dist/` 안에만 생성하며 버전 관리에서 제외합니다. ESM의 `.js` import 확장자는 컴파일 후 Node·브라우저가 읽는 파일 이름입니다. TypeScript 원본을 가리키는 정상적인 작성 방식입니다.

`npm run dev`는 초기 빌드 후 서버와 브라우저 TypeScript 변경을 감시합니다. 서버 출력이 바뀌면 서버를 재시작하고 HTML·CSS 변경도 복사합니다. 브라우저 화면은 수동 새로고침으로 반영합니다. `data/dama.sqlite` 경로와 DB 스키마는 TypeScript 전환으로 바뀌지 않습니다.

미리 빌드한 결과만 실행하려면 저장소 루트에서 `node --experimental-sqlite dist/src/server.js`를 사용합니다. `npm start`, `npm test`, `npm run nginx:config`는 빌드 도구가 설치되어 있어야 합니다.

## 구현된 기능

- 앱 / MCP 서버 프로젝트 등록·목록·삭제
- 모노레포 서비스 등록·편집·삭제: Python, Rust, TypeScript
- 서비스별 Dockerfile·빌드 컨텍스트·포트·접속 경로·상태 확인 설정
- Docker 배포 계획 미리보기와 JSON 다운로드
- 기존 인증서 경로 지정 및 서비스별 Nginx 라우팅 설정 생성
- v1→v2 SQLite 마이그레이션으로 기존 데이터 보존
- 외부 및 직접 배포할 MCP 등록·목록·삭제
- 직접 배포 MCP와 MCP 유형 프로젝트 사이의 참조 검증
- 프로젝트별 MCP 연결·해제 및 향후 실행 정책 저장
- SQLite 영속 저장, 외래 키·중복 제약, 변경 기록
- 반응형 한국어 대시보드, 서버 입력 검증, 로컬 접근 보호

MCP는 Streamable HTTP 연결 메타데이터를 등록합니다. 연결 상태는 항상 **연결 미확인**이며, 연결 테스트·도구 조회·실제 호출은 아직 구현하지 않았습니다. `env:MY_TOKEN`은 향후 사용할 인증 참조 이름일 뿐, 현재 프로세스 환경변수를 읽거나 토큰을 전송하지 않습니다. 실제 토큰을 입력하지 마세요.

연결 정책은 현재 저장되는 설계 정보이며 실행 권한을 집행하지 않습니다. 프로젝트의 `미배포` 표시는 등록 후 Dama가 아직 배포하지 않았다는 뜻입니다. 이미 운영 중인 컨테이너의 상태를 조회한 결과가 아닙니다.

## API

| 메서드 | 경로 | 기능 |
|---|---|---|
| GET | `/api/health` | 관리 서버 상태 |
| GET | `/api/state` | 프로젝트·MCP·연결·최근 활동·빌드 대기열 |
| POST | `/api/projects` | 프로젝트 등록 |
| POST | `/api/projects/:id/services` | 서비스 등록 |
| PUT | `/api/services/:id` | 서비스 설정 전체 수정 |
| GET | `/api/services/:id/deployment-plan` | 실행 전 배포 계획 |
| POST | `/api/services/:id/build-jobs` | `commitSha`(40자리)로 빌드 작업 등록 |
| DELETE | `/api/build-jobs/:id` | 대기 중인 빌드 작업 취소 |
| DELETE | `/api/services/:id` | 서비스 삭제 |
| POST | `/api/mcps` | MCP 등록 |
| POST | `/api/projects/:id/bindings` | 프로젝트와 MCP 연결 |
| DELETE | `/api/projects/:id` | 프로젝트 삭제 |
| DELETE | `/api/mcps/:id` | MCP 삭제 |
| DELETE | `/api/bindings/:id` | 연결 해제 |

삭제는 관리 데이터에만 적용됩니다. 프로젝트 또는 MCP를 삭제하면 사용 연결은 함께 해제되며, MCP를 제공하는 프로젝트는 해당 MCP 등록을 먼저 지워야 삭제할 수 있습니다.

서비스 화면의 **배포 계획**에서 전체 Git 커밋 SHA로 빌드 작업을 등록할 수 있습니다. 등록 시점의 저장소와 Docker 빌드 설정을 SQLite에 저장하며, 같은 서비스와 커밋은 한 번만 대기열에 등록됩니다. 대기 중인 작업을 취소할 수 있습니다. 워커가 실행 중이면 등록한 커밋을 배포합니다. GitHub 웹훅은 후속 작업입니다.

## 배포 워커

서비스의 **배포 계획**에서 커밋 SHA를 등록하면 워커가 Git 체크아웃, Docker 빌드·실행, 상태 확인, Nginx 경로 전환을 처리합니다. Nginx include와 기존 인증서를 연결하는 방법은 [배포 워커 실행](docs/deployment-worker.md)을 참고하세요. Windows 부팅 작업은 [WSL 자동 설치](docs/windows-wsl-install.md)에서, Hyper-V 구성은 [Linux VM 자동 시작·복구](docs/windows-vm-startup.md)에서 확인하세요.

## 다음 단계

1. 소유자 인증·세션, 비밀 저장소와 서버 실행 에이전트
2. 읽기 전용 Docker·Nginx 현황 조회와 기존 앱 가져오기
3. Git 웹훅, 병렬 빌드, 운영자가 선택하는 롤백
4. SSL 수명주기, MCP 연결 검증·도구 조회·인증 연동
5. 운영 데이터 기반 AI 분석, 승인 후 도구 실행, MCP 게이트웨이

상세한 경계, 데이터 모델과 완료 기준은 [설계](docs/architecture.md), [개발 계획](docs/roadmap.md)을 확인하세요.

## 기본 배포 주소와 Nginx 설정

기본 배포 도메인을 입력하면 `https://apps.example.com/<프로젝트 UUID>/` 형태의 주소를 생성합니다. 로컬에서는 **공용 환경 → Nginx → 기본 배포 도메인**에서 선택적으로 지정합니다. API와 대시보드에서 배포 예정 주소를 확인할 수 있습니다. URL이 표시되어도 실제로 배포된 것은 아닙니다.

Linux 배포 서버에서 사용할 Nginx 설정을 생성할 수 있습니다. 생성기는 stdout으로만 출력하고 서버 설정을 변경하지 않습니다.

```sh
npm run --silent nginx:config -- --bootstrap --domain apps.example.com > /tmp/dama-apps-bootstrap.conf
npm run --silent nginx:config -- deploy/routes.example.json > /tmp/dama-apps.conf
```

예시 UUID·포트·기존 인증서 경로를 실제 값으로 변경하고 사용하세요. 같은 프로젝트 UUID에 서비스 경로를 여러 개 등록할 수 있습니다. 앱은 UUID base path를 지원해야 합니다. DNS 수동 설정, Certbot 발급·갱신, Docker 포트 조회와 Nginx 적용 방법은 [도메인·HTTPS 운영](docs/domains-and-tls.md)에 정리했습니다. 이 절차는 운영자가 Nginx 설정과 인증서를 직접 적용할 때 사용합니다. 배포 워커를 연결하면 컨테이너 배포와 Nginx 전환을 처리합니다.

## 모노레포 사용

[서비스 설정과 배포 계획](docs/monorepo.md), [세 언어 예제](examples/monorepo/README.md)를 참고하세요. 별도 배포 워커에서 Docker 실행과 Nginx 전환을 지원합니다. Git 변경 감지와 웹훅은 후속 작업입니다.

## 오픈소스 공개 준비

아직 라이선스를 선택하거나 공개 저장소에 게시하지 않았습니다. 공개 전에 라이선스·기여 규칙·보안 제보 절차와 지원 범위를 정합니다. 현재 코드에 정식 지원을 암시하는 운영 보장은 없습니다.
