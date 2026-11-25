# 기본 주소와 HTTPS 운영

## 확정한 주소

사용자가 기본 배포 도메인으로 `apps.example.com`을 선택하면 접속 주소는 `https://apps.example.com/<프로젝트 UUID>/` 형태다. 로컬 관리 화면은 도메인 없이도 열린다. `*` 서브도메인을 만들지 않는다. 끝 슬래시 없는 접속은 쿼리를 보존하여 슬래시 있는 주소로 308 리다이렉트한다. 이 주소는 배포마다 바뀌지 않는다. 관리 API는 basePath와 defaultUrl을 반환하고 대시보드에서 배포 예정 주소로 표시한다.

현재 Project는 기존 코드의 배포 단위다. 모노레포의 Project/Service 분리 후에는 프로젝트 UUID 아래 서비스별 경로 또는 서비스별 도메인을 명시적으로 매핑해야 한다. 여러 서비스를 같은 UUID 경로의 루트에 중복 배정하지 않는다. 서비스별 routeSegment와 Project 참조를 구현했다. 상세는 [모노레포 설계](monorepo.md)를 따른다.

## 기존 서버 인증서 재사용

이미 `*.example.com` 인증서가 있다면 `apps.example.com`에서 사용할 수 있다. 새 인증서를 중복 발급하지 않고 Nginx manifest의 `tls.certificate`·`tls.privateKey`에 실제 경로를 지정하는 방식을 우선한다. 아래 Certbot 절차는 새 Linux 환경을 위한 선택지다. [모노레포 운영](monorepo.md)의 예시를 참고한다.

## DNS와 인증서

DNS는 사용자가 수동으로 `apps.example.com`의 A 레코드를 배포 서버의 공인 IPv4로 설정한다. IPv6를 실제 제공하는 경우에만 AAAA도 설정한다. 이 접속 형태에는 `*.apps.example.com` 인증서가 필요하지 않고 `apps.example.com` 개별 인증서로 충분하다.

Linux Nginx에서는 Certbot의 ACME HTTP-01 webroot 검증을 기본 운영 방식으로 사용한다. 검증을 위해 외부에서 포트 80과 `/.well-known/acme-challenge/`에 접속 가능해야 한다. HTTPS 서비스는 포트 443을 사용한다. DNS API와 수동 TXT 등록은 필요하지 않다.

Windows에서 쓰던 win-acme도 같은 ACME 방식이다. Windows 운영을 계속한다면 win-acme의 PEM 파일 저장과 갱신 후 Nginx 검증·리로드를 유지한다. 이번 설정 생성기는 Linux Nginx 경로를 출력하며 Windows 자동 실행은 아직 지원하지 않는다. 기존 Windows 인증서를 재사용하려면 올바른 도메인을 포함하는지 확인하고 인증서 경로를 조정해야 한다. 키 파일을 저장소에 넣지 않는다.

## 앱의 UUID 경로 지원

이 구성은 UUID 접두사를 **유지하여** 앱으로 전달한다. 예를 들어 `/<UUID>/login`을 같은 경로로 업스트림에 보낸다. `X-Forwarded-Prefix`도 설정하지만 헤더만으로 앱을 자동 수정할 수는 없다.

앱은 빌드/실행 설정에서 base path, 정적 리소스 URL, 클라이언트 라우터, WebSocket/MCP 주소와 로그인 콜백 경로를 맞춰야 한다. Next.js라면 basePath를 해당 UUID 경로로 설정하고 빌드한다. `/assets`나 `/api`처럼 루트에 고정된 요청을 사용하는 앱을 범용 프록시만으로 자동 호환시키지 않는다. 지원하지 않는 앱은 커스텀 서브도메인을 사용한다. MCP 역시 실제 MCP 경로가 UUID 접두사 아래에 있어야 한다.

동일 호스트의 여러 앱은 브라우저에서 같은 origin이다. UUID 경로는 보안 격리나 접근 인증이 아니다. 서로 신뢰하지 않는 앱, 별도 보안 경계가 필요한 서비스는 도메인으로 분리한다. 쿠키 Path도 서비스 경로로 제한한다.

## Linux 수동 배포 절차

아래 명령은 운영자가 배포 서버에서 직접 설정하는 절차다. Docker 빌드부터 Nginx 전환까지 실행하는 방식은 [배포 워커](deployment-worker.md)를 참고한다. 기존 Dama 관리 화면은 로컬 개발용이므로 이 호스트에 프록시하지 않는다.

1. DNS를 설정하고 서버에 Docker, Nginx, Certbot을 준비한다. 기존 설정을 백업한다. `/var/www/dama-acme` 디렉터리를 만들고 Nginx와 Certbot이 필요한 접근 권한을 갖도록 한다.
2. 인증서가 없는 상태에서 사용할 HTTP 전용 설정을 생성한다.

```sh
npm run --silent nginx:config -- --bootstrap --domain apps.example.com > /tmp/dama-apps-bootstrap.conf
```

출력은 Nginx `http {}` 안에서 읽는 설정이다. 배포판의 활성 include 디렉터리에 설치하되 같은 hostname을 처리하는 기존 server 블록과 충돌하지 않게 한다. **`nginx -t` 성공 후** reload한다. 실패하면 이전 설정을 복원한다.

3. 서버에서 개별 도메인 인증서를 발급한다. 이메일과 약관 등은 운영자가 Certbot 안내에 따라 입력한다.

```sh
sudo certbot certonly --webroot -w /var/www/dama-acme -d apps.example.com
```

먼저 ACME staging 환경으로 검증 흐름을 확인하는 것이 좋다. staging 인증서는 공개 브라우저 접속용이 아니므로 이후 production 인증서로 바꾼다.

4. UUID 경로에 맞춰 빌드한 앱 이미지를 루프백의 Docker 자동 할당 포트로 실행한다. 아래는 컨테이너 내부 포트가 3000인 경우다. 실제 이미지 이름으로 바꾼다.

```sh
docker run -d --name dama-app-example --restart unless-stopped -p 127.0.0.1::3000 your-image:tag
docker port dama-app-example 3000/tcp
```

`docker port` 결과의 호스트 포트가 Nginx upstreamPort다. `127.0.0.1` 공개이므로 외부에서 컨테이너에 직접 접속하지 않는다. 컨테이너 내부 앱은 컨테이너 네트워크에서 요청을 받을 수 있도록 listen해야 한다. 볼륨과 환경변수는 앱에 맞게 추가한다. 재생성 시 할당 포트가 바뀔 수 있으므로 매번 조회하고 반영한다.

5. `deploy/routes.example.json`을 복사해 실제 Dama 프로젝트 UUID와 실제 호스트 포트를 입력한다. `domain`에 실제 호스트 이름을 입력한다. `routes`의 모든 항목이 이 호스트의 전체 경로 목록이다. 한 항목만 남기면 나머지 경로가 출력에서 사라진다.

```sh
npm run --silent nginx:config -- /path/to/routes.json > /tmp/dama-apps.conf
```

기존 bootstrap 설정을 이 설정으로 교체한 뒤 `nginx -t`와 reload를 수행한다. manifest에서 기존 인증서 경로를 지정하지 않으면 `/etc/letsencrypt/live/apps.example.com/`을 사용한다. 예시 manifest에는 기존 인증서 재사용 경로가 들어 있으므로 실제 경로로 바꿔야 한다. Certbot의 실제 저장 경로가 다르면 설정을 조정해야 한다. 현재 생성기는 인증서 파일 존재·만료나 앱 상태를 검증하지 않는다.

6. `https://apps.example.com/<실제 UUID>/`와 정적 파일, 로그인 콜백, WebSocket/MCP 스트리밍을 확인한다. 기존 앱에 영향을 주지 않도록 컨테이너 직접 상태 확인 후 트래픽을 연결한다.

## 갱신

VM에서는 **매일 오전 4시(한국 시간)**에 Certbot이 갱신 시점을 확인한다. 만료가 가까워져 갱신 대상이 된 인증서를 발급하며, VM이 꺼져 예약을 놓친 경우에는 다음 부팅 시 확인한다. 갱신에 성공하면 deploy hook이 `nginx -t`를 실행하고, 검사를 통과하면 Nginx를 리로드한다. [Certbot 갱신 방식](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates) · [systemd 타이머](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

적용 전에 `sudo certbot certificates`로 VM의 Certbot이 대상 인증서를 관리하는지 확인하고, Nginx의 인증서 경로를 해당 목록에 표시된 `fullchain.pem`과 `privkey.pem`으로 연결한다. `*.example.com`은 Route 53 DNS-01 플러그인과 타이머 실행 계정의 AWS 권한이 필요하다. [Route 53 플러그인](https://certbot-dns-route53.readthedocs.io/en/stable/)

아래는 Debian/Ubuntu 패키지가 제공하는 `certbot.timer`를 사용하는 설치 예시다. `systemctl cat certbot.timer`로 대상 타이머를 확인하고, Dama 저장소 루트에서 실행한다. 기존 일정은 이 타이머의 drop-in으로 조정한다.

```sh
sudo install -d -m 0755 /etc/systemd/system/certbot.timer.d /etc/letsencrypt/renewal-hooks/deploy
sudo install -m 0644 deploy/systemd/certbot-daily.conf /etc/systemd/system/certbot.timer.d/90-dama-daily.conf
sudo install -m 0755 deploy/systemd/reload-nginx-after-renewal.sh /etc/letsencrypt/renewal-hooks/deploy/90-dama-reload-nginx
sudo systemctl daemon-reload
sudo certbot renew --dry-run
```

갱신 검증이 성공하면 타이머를 활성화하고 다음 실행 시각을 확인한다.

```sh
sudo systemctl enable certbot.timer
sudo systemctl restart certbot.timer
systemctl list-timers --all certbot.timer
```

Snap 등 다른 설치 방식은 해당 패키지의 타이머를 확인한다. 이미 등록된 Certbot 스케줄러와 Nginx 갱신 훅이 있다면 중복 실행되지 않도록 정리한다. 현재 인증서로 Nginx 리로드까지 시험하려면 `sudo certbot renew --dry-run --run-deploy-hooks`를 실행한다. 운영 로그는 `sudo journalctl -u certbot.service`에서 확인한다. [Certbot 검증 옵션](https://eff-certbot.readthedocs.io/en/stable/man/certbot.html)

## 현재 검증 범위

주소 생성, UUID·포트 입력 검증, 중복 경로 차단, HTTP bootstrap, 쿼리 보존 리다이렉트와 HTTPS 설정 출력을 자동 테스트한다. 현재는 임시 인증서와 공식 Nginx 컨테이너로 생성된 서비스 설정의 nginx -t를 통과했다. 공개 DNS/ACME 및 기존 운영 서버의 Nginx 검증은 아직 수행하지 않았다.

## 공식 자료

- ACME 검증 방식: https://letsencrypt.org/docs/challenge-types/
- Certbot 운영과 갱신: https://eff-certbot.readthedocs.io/en/stable/using.html
- win-acme와 PEM 저장: https://www.win-acme.com/manual/advanced-use/
- Nginx 프록시와 URI 처리: https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass

## 공용 환경의 Nginx 관리

맥의 Docker Desktop에서는 시작할 때 HTTP와 HTTPS 포트를 3999부터 배정하고, 기본값으로 루프백 주소에 연다. 도메인에는 `localhost` 또는 로컬 DNS와 hosts 파일에서 이 Mac의 루프백 주소로 해석되는 내부 이름을 입력한다. 연결 대상은 이 Mac에서 실행하는 앱의 포트 또는 Forgejo다. 도메인과 초안을 저장하고, 설정을 검증한 뒤 적용한다. Nginx 중지와 재시작에는 연결된 도메인이 표시된다.

공유기에서 외부 접속을 전달하려면 **공용 환경 → Nginx → 접속 범위**에서 공유기가 접근할 Mac의 LAN IPv4 주소를 선택하고 적용한다. 설정 변경 후 Nginx에는 기존 포트와 사이트가 그대로 연결되며, 화면에 표시된 LAN 주소와 포트를 공유기에 입력한다. 외부 사용자가 입력할 이름은 Nginx의 도메인, DNS, TLS 인증서와 일치해야 한다. 사설 CA를 사용하는 경우 외부 접속 기기에도 CA 공개 인증서를 설치한다.

로컬명과 내부 DNS에 HTTPS가 필요하면 도메인에서 **사설 CA**를 선택하고 **사설 인증서 발급**을 누른 뒤 설정을 적용한다. **사설 CA 인증서 내려받기**로 받은 공개 인증서를 각 클라이언트의 신뢰 저장소에 설치한다. 사설 CA 키와 사이트 키는 로컬 디스크 또는 서버에 보관하며 화면에서 내려받을 수 있는 파일은 CA 공개 인증서다. 사설 인증서가 만료되기 전에 같은 화면에서 다시 발급할 수 있다.

Linux 운영 서버에서는 새 Dama 빌드와 기존 systemd Nginx를 연동한다. 신규 설치는 VM 설치 스크립트가 연동을 준비한다. 기존 VM에는 새 빌드 배치와 함께 `sudo bash scripts/install-linux-vm.sh --nginx-admin-only`를 실행한다. 설치 때 별도의 인증서 디렉터리를 사용했다면 같은 `--cert-dir` 값을 넘긴다. 도메인을 배포된 서비스에 연결하면 서비스의 기존 UUID 경로를 따라 현재 활성 배포에 접속한다. 기존 운영 인증서로 연결할 때는 인증서의 만료와 도메인 일치를 검사한다.

Let’s Encrypt HTTP-01은 도메인을 먼저 HTTP 초안으로 적용한다. 이후 인증서 유형을 Let’s Encrypt로 저장하고 테스트 발급으로 DNS와 운영 서버의 HTTP 연결을 확인한 뒤 실제 발급 및 설정 적용을 실행한다. Route 53 DNS-01은 Certbot의 Route 53 플러그인과 서버 계정의 DNS 권한을 사용한다. GUI의 갱신은 기존 Certbot 발급 방식을 사용하며, 자동 갱신은 Certbot 타이머가 처리한다.
