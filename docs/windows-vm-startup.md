# Windows 재부팅 후 Dama 자동 복구

Windows 부팅 시 Linux VM을 시작하고 VM 안에서 Docker Engine, Dama 관리 화면, Nginx, Dama 배포 워커를 순서대로 올린다. 로그인이나 터미널 접속 없이 시작하도록 Hyper-V 자동 시작과 Linux systemd를 사용한다.

```text
Windows 부팅
  → Linux VM 자동 시작
    → Docker Engine과 기존 앱 컨테이너 시작
      → Dama 관리 화면 시작
        → Nginx 시작
          → 워커가 활성 배포를 확인·복구하고 대기열 처리
```

## Windows 호스트

Hyper-V가 설치된 Windows에 Linux VM을 만들고 VM 이름과 네트워크 주소를 확인한다. 처음에는 VM을 수동으로 시작해 설치와 동작 확인을 진행한다.

```powershell
Get-VM -Name "Dama-Linux" | Select-Object Name, State, AutomaticStartAction, AutomaticStopAction
```

VM에 고정된 LAN 주소를 배정하고 기존 HTTPS 트래픽을 VM의 Nginx로 연결한다. 기존 DNS와 와일드카드 인증서를 재사용하는 경우 VM에서 인증서 파일과 갱신 작업을 준비한다. Windows의 기존 Docker Desktop과 VM의 Docker Engine은 이미지·컨테이너·볼륨이 따로 저장된다. 기존 앱을 옮길 때는 저장소에서 다시 배포하거나 이미지를 이전하고, 앱 데이터 볼륨은 별도로 백업·복원한다. 기존 Dama DB의 활성 컨테이너는 VM에 실제로 존재하는 경우에만 자동 복구할 수 있다. 기존 활성 컨테이너를 이전하지 않는 신규 설치에서는 새 Dama DB에 서비스를 등록하고 배포한다. 새 프로젝트에 부여되는 UUID가 달라지므로 기존 주소가 필요하면 별도 도메인이나 Nginx 경로를 이전 계획에 포함한다.

## Linux VM 설치

Ubuntu 또는 Debian VM에 Dama 소스를 가져온 뒤 저장소 루트에서 설치 스크립트를 실행한다. win-acme 등에서 받은 기존 인증서를 사용하려면 VM의 한 디렉터리에 `fullchain.pem`과 `privkey.pem`을 준비한다.

```sh
sudo bash scripts/install-linux-vm.sh --cert-dir /etc/ssl/dama
```

VM에서 Certbot이 `/etc/letsencrypt/live/objlabs.team` 인증서를 관리하고 있으면 일일 갱신까지 함께 등록한다.

```sh
sudo bash scripts/install-linux-vm.sh --certbot-renewal
```

VM으로 발급과 갱신을 옮기려면 root 계정에 Route 53 DNS 검증 권한을 설정하고 아래 명령을 사용한다. Certbot이 요청하는 경우 운영자가 약관에 동의한다.

```sh
sudo bash scripts/install-linux-vm.sh --route53 admin@example.com
```

설치 스크립트는 누락된 패키지를 설치하고 Dama 전용 Node.js 26.13.1을 준비한다. 빌드·테스트와 서비스 설정 검증을 거쳐 관리 화면, HTTPS, 워커가 응답하면 부팅 자동 시작을 등록한다. `apps.objlabs.team`의 별도 Nginx 서버 블록을 만들며, 같은 호스트에 기존 설정이 있으면 설치를 중단한다. 공개 DNS와 Hyper-V 설정은 각 호스트에서 적용한다.

### 수동 설치 및 검증

예시는 Ubuntu 또는 Debian 계열 VM과 시스템 사용자 `dama`를 기준으로 한다. Docker Engine, Nginx, Git, Node.js 22.11 이상, sudo, flock을 준비한다. `/opt/dama`에 Dama 소스를 배치하고 의존성을 설치한다. `npm test`에는 빌드가 포함된다. 경로나 실행 파일 위치가 다르면 unit과 sudoers 예시를 함께 수정한다.

```sh
cd /opt/dama
npm ci && npm test
```

시스템 사용자 `dama`가 없다면 `sudo useradd --system --user-group --home-dir /var/lib/dama --shell /usr/sbin/nologin dama`로 만든다. 기존 HTTPS 서버 블록의 Dama include와 인증서는 [배포 워커 실행](deployment-worker.md)에 따라 연결한다. 워커가 파일을 교체할 수 있도록 `/etc/nginx/dama`와 그 안의 `routes.conf`를 `dama` 사용자에게 쓰기 가능하게 설정한다. Nginx 본체 설정, 인증서·키와 helper는 관리자 소유로 유지한다. `DAMA_NGINX_PROBE`가 VM에서 직접 Nginx로 연결되도록 설정한다. 예를 들어 VM의 hosts 파일에서 `apps.objlabs.team`을 `127.0.0.1`로 연결하면 공개 DNS 설정을 유지하면서 VM 내부에서 HTTPS 검증을 수행할 수 있다.

`/opt/dama`에서 실행 파일과 서비스 설정을 설치한다. 기존 `/etc/dama/dama.env`를 사용하는 경우 해당 설정을 확인하고 예시 환경 파일 복사 명령을 건너뛴다.

```sh
sudo install -d -m 0755 /etc/dama /usr/local/libexec/dama /etc/systemd/system/nginx.service.d
sudo install -m 0644 deploy/systemd/dama.env.example /etc/dama/dama.env
sudo install -m 0755 deploy/systemd/nginx /usr/local/libexec/dama/nginx
sudo visudo -cf deploy/systemd/dama-nginx.sudoers
sudo install -m 0440 deploy/systemd/dama-nginx.sudoers /etc/sudoers.d/dama-nginx
sudo install -m 0644 deploy/systemd/dama.service deploy/systemd/dama-worker.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/nginx-after-dama.conf /etc/systemd/system/nginx.service.d/after-dama.conf
sudo systemctl daemon-reload
```

관리 화면과 워커는 같은 SQLite 파일을 사용하며 Docker 그룹은 워커 unit에 추가한다. 워커는 지정된 Nginx 검사와 리로드 명령을 sudo helper로 실행한다. Dama는 같은 DB에 워커 하나를 운영하는 구성을 전제로 한다. 수동 워커나 복구 명령을 함께 사용하려면 먼저 `dama-worker.service`를 중지한다.

## 실행 전 검증

빌드와 테스트를 통과한 뒤 서비스 계정으로 실행될 Node와 SQLite를 확인한다. `/usr/bin/node`는 예시 unit의 경로다. 다른 Node 경로를 설정했다면 검증 명령에도 같은 경로를 사용한다. Docker Engine을 먼저 시작하고 워커의 Docker 접근 권한과 Nginx 설정을 검사한다.

```sh
sudo systemd-analyze verify /etc/systemd/system/dama.service /etc/systemd/system/dama-worker.service
sudo -u dama /usr/bin/node --version
sudo -u dama /usr/bin/node --experimental-sqlite -e 'const db = new (require("node:sqlite").DatabaseSync)(":memory:"); db.close()'
sudo systemctl start docker.service
sudo -u dama -g docker docker info --format '{{.ServerVersion}}'
sudo -u dama /usr/local/libexec/dama/nginx -c /etc/nginx/nginx.conf -t
```

## 수동 시작과 동작 확인

검증이 끝나면 관리 화면과 Nginx를 시작한다. 이미 실행 중인 Nginx에 설정을 추가했다면 `nginx -t`가 성공한 상태에서 `sudo systemctl reload nginx.service`로 반영한다.

```sh
sudo systemctl start dama.service nginx.service
curl --fail --show-error http://127.0.0.1:3100/api/health
sudo systemctl start dama-worker.service
sudo journalctl -u dama-worker.service -b -n 30 --no-pager
```

관리 API가 `ok: true`를 반환하고 워커 로그에 `기존 배포 확인 완료`가 표시되는지 확인한다. 관리 화면은 VM의 `127.0.0.1:3100`에서 듣고 Windows에서는 SSH 포트 포워딩으로 접속할 수 있다. 운영 트래픽을 전환하기 전에 테스트 앱을 하나 배포하고 Nginx 경유 주소에서 응답을 확인한다.

## 인증서 자동 갱신

VM에서 Certbot의 일일 갱신 확인과 Nginx 리로드 훅을 적용한다. 패키지 타이머는 매일 오전 4시(한국 시간)에 실행하며, VM이 꺼져 놓친 확인은 다음 부팅 시 수행한다. [인증서 갱신 설정](domains-and-tls.md#갱신)

## 재부팅 확인

수동 시작과 인증서 갱신 검증이 끝나면 Linux 서비스의 부팅 자동 시작을 등록한다. 이후 Windows 관리자 PowerShell에서 VM 자동 시작을 설정한다.

```sh
sudo systemctl enable docker.service dama.service nginx.service dama-worker.service
```

```powershell
Set-VM -Name "Dama-Linux" -AutomaticStartAction Start -AutomaticStopAction ShutDown
Get-VM -Name "Dama-Linux" | Select-Object Name, AutomaticStartAction, AutomaticStopAction
```

Docker Engine이 기존 `unless-stopped` 컨테이너를 시작한다. `--boot-watch` 워커는 Docker와 Nginx가 응답할 때까지 대기하고, SQLite의 활성 배포를 Docker에서 조회한다. 컨테이너 라벨과 이미지 ID를 확인하고 실제 포트와 앱의 상태 확인 응답을 검증한다. 포트가 바뀌었거나 배포 중 재부팅됐다면 마지막 활성 배포로 Nginx 경로를 갱신한다. Nginx를 통해 상태와 배포 ID를 확인한 후에 대기 중인 작업을 처리한다.

활성 컨테이너가 삭제됐거나 수동 중지 상태라면 워커가 복구를 재시도하고 원인을 로그에 남긴다. 기존 컨테이너나 이미지를 자동으로 새로 빌드하지 않는다. 이 경우 Docker 상태를 복구한 뒤 워커의 다음 시작에서 확인한다.

```sh
systemctl status docker.service dama.service nginx.service dama-worker.service
journalctl -u dama-worker.service -b
```

Windows를 재부팅한 뒤 로그인 화면에 둔 상태에서 다른 기기로 배포 주소와 상태 확인 경로를 확인한다. VM 자동 시작, 인증서 경로, 네트워크 및 Windows 업데이트 후 복구는 설치할 장비에서 확인한다.

- [Hyper-V Set-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/set-vm)
- [Docker Engine 부팅 시작](https://docs.docker.com/engine/install/linux-postinstall/)
