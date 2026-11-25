# 모노레포와 세 언어 서비스

## 관리 흐름

프로젝트는 저장소·브랜치를 갖는 그룹이다. 각 프로젝트 아래에 Python, Rust, TypeScript 서비스를 여러 개 등록한다. 기존 v1 프로젝트 및 MCP 프로젝트 데이터는 그대로 유지하고 필요한 서비스를 명시적으로 추가한다. 앱 코드를 스캔해서 임의의 포트나 빌드 명령을 추정하지 않는다.

서비스 화면에서 서비스 추가, 설정 편집, 삭제와 배포 계획 JSON 확인·다운로드를 지원한다. 프로젝트 카드의 서비스 추가 버튼도 사용할 수 있다. 서비스별 필드는 다음과 같다.

| 필드 | 의미 |
|---|---|
| name / kind | 프로젝트 내 고유 이름, app 또는 mcp |
| language | python, rust, typescript |
| sourcePath | 저장소 루트 기준 소스 디렉터리 |
| dockerfile | 저장소 루트 기준 Dockerfile 파일 |
| buildContext | 저장소 루트 기준 Docker 빌드 컨텍스트 |
| containerPort | 앱이 컨테이너 내부에서 사용하는 포트 |
| routeSegment | 빈 값이면 프로젝트 루트, api면 프로젝트 UUID 아래 /api/ |
| healthPath | 서비스의 base path를 제외한 상태 확인 경로 |
| watchPaths | 저장소 루트 기준 변경 감지 glob 목록, 현재 저장만 지원 |

sourcePath는 표시와 향후 변경 감지의 기준이며 자동으로 Docker 작업 디렉터리를 바꾸지 않는다. Dockerfile과 컨텍스트는 항상 저장소 루트 기준이다. 앱의 WORKDIR·의존성 설치·빌드·실행 명령은 Dockerfile이 정한다. 실제 빌드 환경은 Docker가 지원하는 환경이며 언어 값이 런타임을 자동 설치하지 않는다.

빌드 컨텍스트를 `.`으로 지정하면 Python 로컬 패키지, Rust workspace, TypeScript workspace 등 공통 코드를 포함할 수 있다. 저장소의 `.dockerignore`로 비밀 파일·빌드 결과·의존성 디렉터리를 제외해야 한다. 기본 구현은 원격 저장소 URL의 HTTP(S) 등록만 지원하고 워커는 해당 HTTP(S) 주소와 실행 환경의 Git 인증을 사용해 체크아웃한다.

## 접속 경로

예를 들어 프로젝트 UUID가 `P`일 때:

- web: routeSegment를 비움 → `https://apps.example.com/P/`
- Python api: routeSegment=`api` → `https://apps.example.com/P/api/`
- Rust MCP: routeSegment=`tools` → `https://apps.example.com/P/tools/`

동일 프로젝트에서는 서비스 이름과 routeSegment가 각각 고유해야 한다. 내부 포트는 서비스 컨테이너별로 분리되므로 같아도 된다. 앱이 실제 UUID 경로에서 요청을 처리해야 하며 설정 변경 후 재빌드/재시작이 필요할 수 있다. 경로 보존·상태 확인 및 같은 origin의 제약은 [도메인·HTTPS](domains-and-tls.md)를 따른다.

Nginx 설정의 routes는 같은 projectId에 여러 routeSegment를 지정할 수 있다. 더 긴 명시적 서비스 접두사가 프로젝트 루트보다 우선한다. 새 설정은 전체 경로 목록을 담아야 한다. 기존 dev/ai 등의 server 블록은 별도 파일로 유지한다.

## 배포 계획

`GET /api/services/:id/deployment-plan`은 실행하지 않는 검토용 JSON을 반환한다. Docker build/run argv, `DAMA_BASE_PATH`와 `PORT`, 자동 할당 포트 조회 명령, UUID를 포함한 상태 확인 경로와 Nginx route 초안을 확인할 수 있다.

- build 시 저장소 루트에서 Dockerfile과 컨텍스트를 사용한다.
- run 시 `127.0.0.1::내부포트`로 호스트 포트를 자동 배정한다.
- Dockerfile이 build arg를 사용하고 앱이 해당 환경변수를 읽어야 실제로 적용된다.
- 계획의 commit과 upstreamPort는 미확정이며 실제 실행 전 커밋 SHA와 Docker가 할당한 포트를 넣어야 한다.
- 생성된 명령을 쉘 문자열로 조합하지 않고 argv 배열로 유지한다.
- 환경변수 비밀 참조, 볼륨, 리소스 제한, Git 웹훅과 운영자가 선택하는 롤백은 후속 범위다.
- 사용자별 환경 차이가 있으므로 먼저 예제로 빌드·접속을 확인한 뒤 실제 저장소 Dockerfile로 확장한다.

실제 명령은 [배포 워커](deployment-worker.md)가 실행한다. 웹 프로세스는 SQLite에 작업을 등록한다.

## MCP 제공 서비스

managed MCP를 등록할 때 projectId와 serviceId를 지정할 수 있다. 서비스는 해당 프로젝트에 속하고 kind=mcp여야 한다. MCP 등록에 사용 중인 서비스 삭제와 app 유형으로의 변경은 차단한다. 기존 kind=mcp 프로젝트만 참조하는 v1 방식도 계속 지원한다. MCP를 사용하는 Binding은 현재 프로젝트 단위이며 서비스별 도구 권한은 후속 작업이다.

## 인증서 재사용

Nginx manifest의 tls.certificate와 tls.privateKey에 기존 `*.example.com` 인증서 및 키의 경로를 지정한다. Dama는 파일을 읽거나 인증서를 발급하지 않고 설정에 경로만 출력한다. 갱신은 기존 win-acme/ACME 도구가 관리하며 갱신 후 Nginx를 검증·리로드해야 한다. 해당 인증서가 apps.example.com을 실제 포함하는지는 배포 서버에서 확인한다.

```json
{
  "domain": "apps.example.com",
  "tls": {
    "certificate": "/etc/nginx/ssl/example.com-chain.pem",
    "privateKey": "/etc/nginx/ssl/example.com-key.pem"
  },
  "routes": [
    { "projectId": "00000000-0000-4000-8000-000000000001", "routeSegment": "", "upstreamPort": 32780 },
    { "projectId": "00000000-0000-4000-8000-000000000001", "routeSegment": "api", "upstreamPort": 32781 }
  ]
}
```

위 경로는 예시다. Windows Nginx 설정의 인증서 경로는 `C:/...` 형식도 출력할 수 있지만, CLI 실행·리로드·경로 존재·권한은 Windows 환경에서 별도로 검증해야 한다.

## 데이터 보존

SQLite 스키마를 트랜잭션으로 마이그레이션한다. v2에서는 서비스와 MCP 제공 서비스 참조를 추가하고, v3에서는 빌드 대기열, v4에서는 실행 상태와 활성 배포를 추가한다. 기존 UUID·프로젝트·서비스·MCP·사용 연결·변경 이력을 유지한다. 기존 프로젝트에 임의의 기본 서비스를 자동 생성하지 않는다. 더 새로운 DB 버전은 변경하지 않고 앱 시작을 거절한다. 업그레이드 전 앱을 중지하고 SQLite의 일관된 백업을 보관한다.

실행 가능한 세 언어 예제는 [예제 모노레포](../examples/monorepo/README.md)에 있다.

## 이번 구현의 검증 결과

- API·마이그레이션·경로 생성 회귀 테스트 14개 통과.
- TypeScript 실제 컴파일, Rust offline cargo check 통과.
- 세 예제의 Docker 이미지 빌드 성공.
- 세 컨테이너를 동시에 내부 포트 3000으로 실행하고 서로 다른 루프백 호스트 포트 자동 할당 확인.
- 각 UUID 기본 경로의 홈·상태 확인은 200, 접두사 없는 /health는 404 확인.
- 임시 인증서를 사용한 공식 Nginx 컨테이너에서 생성 설정의 nginx -t 통과.
- 브라우저 서비스 등록·편집·계획 JSON 다운로드·새로고침 후 데이터 유지 확인.

이는 로컬 Docker 환경에서 최소 예제를 검증한 결과이며 사용자 운영 서버에 대한 배포 성공을 뜻하지 않는다. 공개 DNS, 기존 와일드카드 인증서, 실제 프레임워크의 정적 파일·로그인·MCP 스트리밍은 운영 환경에 맞춰 추가 검증해야 한다.

이미지 빌드 후 `python3 scripts/smoke-containers.py`로 컨테이너 검증을 재실행할 수 있다. 테스트는 자신이 만든 임시 컨테이너를 종료·삭제한다. 이미지 빌드 명령은 예제 README를 따른다. 해당 테스트용 태그는 dama-verify-python, dama-verify-rust, dama-verify-typescript다.
