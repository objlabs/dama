# 배포 워커 실행

Dama의 서비스 화면에서 배포 계획을 열고 40자리 Git 커밋 SHA로 작업을 등록한다. 같은 SQLite 파일을 사용하는 워커가 등록 순서대로 작업을 가져온다. 실행은 서버당 한 작업으로 제한된다. 배포 결과와 활성 버전은 서비스 화면의 **배포 작업**에서 새로고침해 확인할 수 있다.

## 기존 Nginx 연결

아래 경로는 예시다. 사용자가 선택한 도메인(예시 `apps.example.com`)의 HTTPS 서버 블록에 Dama 전용 파일을 include한다. 다른 가상 호스트와 와일드카드 인증서 설정은 기존 Nginx에서 관리한다.

```nginx
# http 블록에 한 번 선언한다. 기존에 같은 변수가 있으면 그 선언을 사용한다.
map $http_upgrade $dama_connection_upgrade {
    default upgrade;
    '' close;
}

# apps.example.com의 기존 HTTPS server 블록 안에 추가한다.
include /etc/nginx/dama/routes.conf;
```

`routes.conf`는 처음에 빈 일반 파일로 만든다. 워커는 이 파일과 같은 디렉터리에 임시 파일을 생성한 뒤 이름을 바꿔 설정을 반영한다. 기존 수동 경로는 다른 include 또는 서버 블록에 둔다. 작업 디렉터리와 Nginx 설정은 운영자가 정하고, 워커가 Nginx 구문 검사와 reload를 실행할 권한을 갖게 한다. `nginx -t`로 초기 설정을 확인하고 reload한다.

Docker와 Nginx는 같은 호스트에서 실행한다. 워커는 Docker가 배정한 IPv4 루프백 포트로 상태를 확인하며, Nginx도 같은 포트로 프록시한다. 서비스는 컨테이너 내 `0.0.0.0`에서 `PORT`를 사용하고, `DAMA_BASE_PATH` 아래에서 상태 확인 경로에 2xx로 응답해야 한다.

## 실행

```sh
npm ci
npm run build
export DAMA_DB=/path/to/dama/data/dama.sqlite
export DAMA_NGINX_CONFIG=/etc/nginx/nginx.conf
export DAMA_NGINX_INCLUDE=/etc/nginx/dama/routes.conf
export DAMA_DEPLOYMENT_DOMAIN=apps.example.com
export DAMA_NGINX_PROBE=https://apps.example.com
npm run deploy:worker -- --watch
```

관리 서버와 같은 `DAMA_DB`를 지정한다. `--once`는 대기열의 첫 작업 하나를 실행하며, `--watch`는 Docker와 Nginx가 응답할 때까지 기다린 후 대기열을 계속 확인한다. VM 부팅 시 기존 배포를 복구하는 `--boot-watch` 모드는 [Linux VM 자동 시작·복구](windows-vm-startup.md)를 참고한다. `DAMA_NGINX_PROBE`는 워커에서 접근할 수 있는 Nginx 주소다. HTTPS 인증서는 시스템 신뢰 저장소로 검증한다. 로컬 테스트에는 `http://127.0.0.1:포트`를 사용할 수 있다.

Git 저장소는 등록한 HTTP(S) 주소에서 커밋 SHA를 직접 fetch할 수 있어야 한다. Dockerfile에 필요한 서비스 파일은 저장소에 포함한다. 현재 배포 작업은 대시보드에서 커밋을 직접 등록하며, GitHub 웹훅과 Git submodule 처리는 후속 범위다.

### 비공개 Git 저장소

프로젝트 추가의 **비공개 저장소 인증** 또는 프로젝트 카드의 **Git 인증**에서 HTTPS 복제 주소에 사용할 PAT를 등록한다. 주소가 `github.com` 또는 `gitlab.com`이면 제공자를 자동 선택하고, 자체 호스팅이면 직접 선택한다. GitHub에서는 해당 저장소의 `Contents: Read-only` 권한과 사용자 이름, GitLab에서는 `read_repository` 권한이 필요하다. **연결 확인**은 저장소를 읽을 수 있는지 검사한다.

워커는 저장된 PAT가 있으면 해당 HTTPS 저장소에만 사용한다. PAT를 지정하지 않은 프로젝트는 워커 계정의 일반 Git 인증을 쓴다. PAT는 SQLite에 암호화해 저장하고 키 파일은 같은 디렉터리의 `<DAMA_DB>.git-key`에 별도로 둔다. 데이터베이스를 옮기거나 복원할 때는 키도 안전하게 옮기고, 두 프로세스에서 같은 `DAMA_DB`와 파일 권한을 사용한다.

## 포트, 공유 DB, 이미지 승격

서비스 편집에서 웹앱(3000–3999) 또는 API(4000–4999)를 선택한다. 내부 포트는 Dockerfile과 앱에 맞춘다. 워커는 웹앱은 3999부터, API는 4999부터 번호를 낮추며 빈 포트를 찾는다. Docker가 바인드를 거절하면 다음 포트를 시도한다. Forgejo도 처음 설치할 때 웹앱과 같은 순서로 포트를 배정하고 다시 시작할 때는 저장된 포트를 재사용한다. 기존 활성 배포는 새 경로 검증 중 계속 동작하며, 전환 완료 후 이전 컨테이너를 정지해 포트를 회수한다. 이미지와 배포 기록은 보존한다.

### 환경별 PostgreSQL

[공용 DB Compose](../deploy/database/compose.yaml)는 환경마다 같은 Compose 프로젝트 이름과 데이터 볼륨을 재사용한다. 예를 들어 로컬 개발용 PostgreSQL을 시작하려면 아래 명령을 실행한다. 암호 파일은 모드 600으로 만들고 환경별로 분리한다.

```sh
npm run build
DAMA_POSTGRES_PASSWORD_FILE=/absolute/path/dev-postgres-password npm run db:shared -- dev
```

`test`, `release`도 같은 규격을 사용한다. 앱 컨테이너는 `dama-db-<환경>` 네트워크의 `postgres:5432`에 연결한다. 호스트 DB 클라이언트로도 접속해야 할 환경만 `--host`를 붙인다. 그러면 5999부터 5000까지 번호를 낮추며 빈 로컬 포트를 찾아 배정하고, 다음 실행에서는 그 포트를 재사용한다.

이미 운영 중인 PostgreSQL도 해당 환경의 Docker 네트워크에서 `postgres` 주소로 접근할 수 있게 연결하면 사용할 수 있다. 프로젝트마다 DB와 권한을 분리한다. 운영자는 DB와 계정을 먼저 만들고, 대시보드와 워커의 `DAMA_DB_CONNECTIONS`에 같은 목록 파일 경로를 지정한다.

```json
[
  { "id": "example-test", "environment": "test", "runtimeEnv": "secrets/example-test-app.env", "migrationEnv": "secrets/example-test-migrate.env" }
]
```

각 모드 600 파일에는 `DATABASE_URL=postgresql://사용자:인코딩한암호@postgres:5432/프로젝트DB` 한 줄을 넣는다. 두 계정은 동일 DB를 가리키고 앱 계정에는 앱 쿼리 권한, 마이그레이션 계정에는 스키마 변경 권한을 부여한다. Dama의 SQLite와 배포 계획에는 연결 이름만 저장된다.

### 공용 환경 관리

Dama의 **공용 환경**에서 `dev`, `test`, `release`를 시작하거나 중지하고, 각 프로젝트에 PostgreSQL DB, MinIO 버킷, Redis 사용자를 준비한다. 공용 환경은 기존 `dama-db-<환경>` Compose 프로젝트와 네트워크를 사용한다. PostgreSQL, MinIO, Redis는 각각 영구 볼륨을 사용하며, 앱을 배포하거나 공용 환경을 중지해도 볼륨은 유지한다. 새 환경은 호스트 포트를 열지 않는다.

프로젝트별 DB에는 앱 실행 계정과 스키마 변경 계정을 만든다. MinIO는 프로젝트 전용 버킷과 접근 키를 발급한다. Redis는 전용 사용자에 프로젝트별 키 접두사와 채널 패턴을 적용한다. 서비스 편집에서는 해당 프로젝트와 환경의 준비된 연결을 선택한다. 앱은 PostgreSQL의 `DATABASE_URL`, MinIO의 `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, Redis의 `REDIS_URL`과 `REDIS_KEY_PREFIX`를 사용할 수 있다. Redis 앱은 발급된 접두사를 키와 채널에 붙인다.

관리자 비밀 파일은 기본적으로 Dama 데이터베이스 옆 `shared-environments`에 만들고, 필요하면 `DAMA_SHARED_DIR`로 바꾼다. 프로젝트 자격 증명은 SQLite에 암호화되며 기존 `<DAMA_DB>.git-key` 파일을 사용한다. 백업에는 데이터 볼륨과 Dama의 암호화 키 및 비밀 파일도 포함한다. 대시보드는 로컬에서 실행하며 공용 환경 관리에는 해당 Docker 엔진을 제어할 권한이 필요하다.

### 마이그레이션과 테스트

마이그레이션 명령은 이미지에 포함된 실행 파일과 인자를 JSON 배열로 지정한다. 워커는 새 앱 컨테이너 시작 전에 같은 이미지에서 명령을 한 번 실행한다. 명령은 성공한 실제 적용 버전을 `DAMA_MIGRATION_VERSION=0014`처럼 한 줄로 출력한다. 버전은 이미지 ID와 함께 배포 이력에 남는다. 같은 Dama DB를 쓰는 워커는 한 작업씩 실행한다. 별도 프로세스에서도 마이그레이션을 실행하는 환경에서는 사용하는 마이그레이션 도구의 DB 잠금을 함께 사용한다.

test 검증 명령에는 빈 DB 초기화와 직전 버전 스키마에서의 업그레이드를 검사하는 프로젝트 테스트를 연결한다. 임시 테스트 DB는 공유 test 인스턴스에 만들고 테스트 종료 시 정리한다. release에는 구버전·신버전이 함께 사용할 수 있는 스키마 변경을 배포한다. 기존 컬럼 제거처럼 되돌리기 어려운 변경은 구버전 퇴역 이후 별도 마이그레이션으로 적용한다.

같은 이미지를 승격하려면 `test`와 `release` 서비스를 같은 프로젝트 안에 별도로 만들고 **test에서 검증한 동일 이미지로 release 배포**를 선택한다. 두 서비스는 같은 Dockerfile, 빌드 컨텍스트, 소스 경로를 사용하고 `PORT`, `DAMA_BASE_PATH` 등 환경 차이는 실행 시 적용한다. test 검증 명령과 상태 확인을 모두 통과한 작업을 release 배포 계획에서 선택한다. 워커는 기존 이미지 ID를 재사용한다.

개발용 [모노레포 Compose 예제](../examples/monorepo/compose.yaml)는 Node.js, Rust, Python API를 같은 실행 규격으로 띄운다.

## 전환과 복구

워커는 요청한 커밋을 확인하고 빌드한 이미지 ID로 새 컨테이너를 실행한다. 루프백 상태 확인에 성공하면 Nginx 설정을 검사하고 reload한다. Nginx 응답 헤더의 배포 ID와 상태 코드로 전환을 확인한 뒤 SQLite에 활성 버전을 기록한다. Nginx 전환이나 검증에 실패하면 이전 include를 되돌리고 reload한다. 실패한 작업은 같은 SHA로 다시 등록할 수 있다.

전환 뒤 이전 정상 버전의 컨테이너는 정지 상태로, 이미지는 기존 ID로 보존한다. 운영자가 더 이상 필요한 요청이나 버전이 없는 것을 확인한 뒤 정리한다. UI에서 이전 버전을 선택하는 롤백과 자동 보존 기간은 후속 범위다.

워커가 강제 종료되거나 Nginx 복원 확인에 실패하면 실행 중 상태를 유지해 다음 작업의 전환을 막는다. 해당 워커가 종료된 것을 확인한 뒤 같은 설정으로 아래 명령을 실행한다. SQLite에 기록된 활성 경로로 include를 다시 생성하고 Nginx 응답을 확인한다. 중단된 작업의 컨테이너는 점검용으로 보존한다.

```sh
npm run deploy:worker -- --recover
```
