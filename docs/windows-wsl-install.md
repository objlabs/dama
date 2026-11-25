# Windows에서 WSL과 Dama 자동 설치

Windows 10 빌드 19041 이상 또는 Windows 11에서 Dama 소스를 내려받고, 해당 Windows 계정의 관리자 PowerShell을 저장소 루트에서 연다. CPU 가상화는 BIOS/UEFI에서 켜져 있어야 한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

설치 화면에서 배포용 DNS 이름, 인증서 폴더와 현재 Windows 계정의 암호를 입력한다. 계정 암호는 부팅 시 로그인 화면에서도 작업을 실행하기 위해 Windows 작업 스케줄러에 전달한다. Windows Hello PIN과 계정 암호는 구분된다. 설치 상태 JSON에는 암호를 저장하지 않는다. [Microsoft 작업 실행 계정 설명](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)

인증서 폴더에는 입력한 배포 도메인을 포함하는 인증서의 `fullchain.pem`과 `privkey.pem`이 있어야 한다. 경로를 미리 지정할 수도 있다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -DeploymentDomain apps.example.com -CertDirectory "C:\certificates\example.com"
```

설치 프로그램은 필요한 파일을 로컬에 복사하고 다음 작업을 진행한다.

1. Windows 버전·가상화·HTTP 포트 충돌을 확인하고 설치 파일과 인증서·자격 증명 폴더의 접근 권한을 제한한다.
2. 배포판을 소유할 Windows 계정으로 `AtStartup` 트리거와 `Password` 로그온 유형의 두 부팅 작업을 등록한다. `Dama-Install-Resume`은 설치를 이어가고 `Dama-WSL`은 설치 완료 후 서비스를 관리한다.
3. WSL과 Virtual Machine Platform 기능을 활성화한다. 재부팅이 필요하면 안내한다. 운영자가 Windows를 재부팅하면 부팅 작업이 로그인 전 설치를 이어간다.
4. WSL을 설치·업데이트하고 공식 Ubuntu 24.04 WSL 이미지의 SHA-256을 확인한 뒤 `Dama` 전용 WSL 2 배포판을 가져온다.
5. Ubuntu 패키지를 업데이트하고 systemd를 활성화한다. Docker Engine·Nginx·Node.js·Dama를 설치하고 빌드·테스트·HTTPS·워커 복구 상태를 확인한다.
6. `Dama-WSL` 작업을 실행한다. 작업은 Linux 서비스를 시작하고 WSL을 유지하며, WSL IP에 맞춰 Windows HTTP/HTTPS 포트 전달과 방화벽 규칙을 연결한다. 시작 실패를 재시도하고 실행 중 IP 변경도 반영한다.
7. 관리 화면과 Windows HTTPS 응답을 확인한다. 런타임 상태의 부팅 시각과 비대화형 세션 ID `0`을 확인한 뒤 설치 이어가기 작업을 해제한다.

PowerShell 구문 검사와 모의 실행에서 부팅 작업 등록, 암호 재입력 없는 설치 재개, 기존 포트 충돌 처리, 전달 실패 후 복구와 IP 변경 대응을 확인했다. 실제 Windows의 계정 정책, WSL 시작, 재부팅 및 외부 HTTPS 복구는 설치 장비에서 검증해야 한다.

## 접속과 포트

관리 화면은 Windows의 `http://127.0.0.1:3100`으로 연다. 배포 도메인을 `apps.example.com`으로 선택했다면 배포 주소는 `https://apps.example.com/<app_id>`이다. 공개 DNS와 공유기/NAT의 포트 전달은 Windows 서버 IP로 연결한다.

설치기는 Windows의 TCP 80·443을 WSL Nginx로 연결하고 `Dama-WSL-TCP-80`, `Dama-WSL-TCP-443` 방화벽 규칙을 만든다. 기존 Windows Nginx 등과 충돌하면 설치를 중단한다. 서버에 별도로 할당한 IPv4 주소를 쓰려면 `-ListenAddress 192.168.0.20`을 지정한다. 기본값은 `0.0.0.0`이다. [Microsoft WSL 네트워크 설명](https://learn.microsoft.com/en-us/windows/wsl/networking)

## 인증서 갱신

기존 인증서는 설치 전에 로컬 설치 폴더로 복사하고 Linux `/etc/ssl/dama`에 설치한다. 이후 win-acme에서 갱신한 인증서를 이 경로에 전달하고 Nginx를 리로드하는 작업은 연결해야 한다.

WSL에서 Route 53 DNS 검증으로 발급·갱신하려면 AWS `[default]` 프로필과 이메일을 지정한다. 설치 화면에서 Let's Encrypt 약관에 동의하면 재부팅 후에도 Certbot이 비대화형으로 발급을 진행한다. 자격 증명은 Linux `/root/.aws/credentials`에 권한 `0600`으로 복사한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Route53Email "admin@example.com" -AwsCredentialsFile "$env:USERPROFILE\.aws\credentials"
```

## 상태 확인과 복구

설치 상태와 로그는 `%LOCALAPPDATA%\Dama\setup`, WSL 디스크는 `%LOCALAPPDATA%\Dama\wsl`에 저장한다. `install.log`는 설치 진행을, `runtime.log`와 `linux-startup-errors.log`는 부팅 복구를 기록한다. `runtime-status.json`에는 준비 상태, 최근 확인 시각, Windows 부팅 시각과 세션 ID를 기록한다.

중간 실패 후 같은 계정의 관리자 PowerShell에서 저장된 설정으로 다시 실행할 수 있다. 이전 로그인 작업 방식의 설치를 갱신할 때는 새 저장소의 스크립트에 `-Resume`을 전달한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Resume
```

Windows 계정 암호를 바꾼 경우 부팅 작업의 암호를 갱신한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -RepairStartup
```

최종 확인은 Windows를 재부팅한 뒤 로그인 화면에 두고 다른 기기에서 배포 주소를 여는 것이다. 나중에 로그인하여 `runtime-status.json`의 `Ready`, `WindowsBootTime`, `SessionId`와 작업 스케줄러 실행 기록을 확인한다. 설치 파일·계정 정책·네트워크가 해당 서버에서 실제로 동작하는지 이 과정으로 확인한다.
