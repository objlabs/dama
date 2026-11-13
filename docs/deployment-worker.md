# 배포 워커 실행

Dama의 서비스 화면에서 배포 계획을 열고 40자리 Git 커밋 SHA로 작업을 등록한다. 같은 SQLite 파일을 사용하는 워커가 등록 순서대로 작업을 가져온다. 실행은 서버당 한 작업으로 제한된다. 배포 결과와 활성 버전은 서비스 화면의 **배포 작업**에서 새로고침해 확인할 수 있다.

## 기존 Nginx 연결

아래 경로는 예시다. 현재 운영 중인 `apps.objlabs.team` HTTPS 서버 블록에 Dama 전용 파일을 include한다. 다른 가상 호스트와 와일드카드 인증서 설정은 기존 Nginx에서 관리한다.

```nginx
# http 블록에 한 번 선언한다. 기존에 같은 변수가 있으면 그 선언을 사용한다.
map $http_upgrade $dama_connection_upgrade {
    default upgrade;
    '' close;
}

# apps.objlabs.team의 기존 HTTPS server 블록 안에 추가한다.
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
export DAMA_NGINX_PROBE=https://apps.objlabs.team
npm run deploy:worker -- --watch
```

관리 서버와 같은 `DAMA_DB`를 지정한다. `--once`는 대기열의 첫 작업 하나를 실행하며, `--watch`는 Docker와 Nginx가 응답할 때까지 기다린 후 대기열을 계속 확인한다. VM 부팅 시 기존 배포를 복구하는 `--boot-watch` 모드는 [Linux VM 자동 시작·복구](windows-vm-startup.md)를 참고한다. `DAMA_NGINX_PROBE`는 워커에서 접근할 수 있는 Nginx 주소다. HTTPS 인증서는 시스템 신뢰 저장소로 검증한다. 로컬 테스트에는 `http://127.0.0.1:포트`를 사용할 수 있다.

Git 저장소는 등록한 HTTP(S) 주소에서 커밋 SHA를 직접 fetch할 수 있어야 한다. 워커 프로세스가 사용할 수 있는 Git 인증을 설정한다. Dockerfile에 필요한 서비스 파일은 저장소에 포함한다. 현재 배포 작업은 대시보드에서 커밋을 직접 등록하며, GitHub 웹훅과 Git submodule 처리는 후속 범위다.

## 전환과 복구

워커는 요청한 커밋을 확인하고 빌드한 이미지 ID로 새 컨테이너를 실행한다. 루프백 상태 확인에 성공하면 Nginx 설정을 검사하고 reload한다. Nginx 응답 헤더의 배포 ID와 상태 코드로 전환을 확인한 뒤 SQLite에 활성 버전을 기록한다. Nginx 전환이나 검증에 실패하면 이전 include를 되돌리고 reload한다. 실패한 작업은 같은 SHA로 다시 등록할 수 있다.

이전 정상 버전의 컨테이너와 이미지는 보존한다. 운영자가 더 이상 필요한 요청이나 버전이 없는 것을 확인한 뒤 정리한다. UI에서 이전 버전을 선택하는 롤백과 자동 보존 기간은 후속 범위다.

워커가 강제 종료되거나 Nginx 복원 확인에 실패하면 실행 중 상태를 유지해 다음 작업의 전환을 막는다. 해당 워커가 종료된 것을 확인한 뒤 같은 설정으로 아래 명령을 실행한다. SQLite에 기록된 활성 경로로 include를 다시 생성하고 Nginx 응답을 확인한다. 중단된 작업의 컨테이너는 점검용으로 보존한다.

```sh
npm run deploy:worker -- --recover
```
