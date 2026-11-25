# Dama 설치 파일

Dama의 서버, 관리 화면과 설치 도구는 같은 저장소에서 배포한다. 설치판과 소스 실행판은 동일한 대시보드를 사용한다.

## 설치 파일 만들기

저장소 루트에서 Node.js와 npm으로 의존성을 준비한 뒤 빌드한다.

```sh
npm ci
npm test
npm run build:installers -- macos
npm run build:installers -- windows
```

출력 위치는 `dist/installers/`이며 설치 파일마다 SHA-256 파일을 생성한다. macOS 패키지는 현재 Node.js 실행 파일과 라이선스를 포함한다. Apple Silicon과 Intel 패키지는 각 아키텍처의 Node.js로 빌드한다. Node.js 위치를 바꾸려면 `MAC_NODE_BINARY`와 `MAC_NODE_LICENSE`를 지정한다. Windows Setup 빌드는 로컬 NSIS를 우선 사용하며, 없으면 임시 Docker 컨테이너에서 컴파일한다.

외부 배포 전 macOS 앱용 Developer ID Application과 설치 파일용 Developer ID Installer로 서명하고 공증한다. 빌드에서 `MAC_APP_SIGN_IDENTITY`, `MAC_INSTALLER_SIGN_IDENTITY`, `MAC_NOTARY_PROFILE`을 지정할 수 있다. Windows Setup을 공개할 때는 Windows용 코드 서명을 적용한다. 서명 후 SHA-256을 다시 계산한다.

## macOS

`.pkg`를 설치하면 `/Applications/Dama.app`과 시스템 LaunchDaemon이 등록된다. 서버는 설치에 사용한 로그인 계정의 권한으로 실행되며 macOS 부팅 시 시작한다. Dama 앱은 로컬 관리 화면 열기, 상태 확인, 서버 시작·중지, 데이터 폴더 열기와 제거를 제공한다. 시작과 중지는 다음 부팅의 자동 시작에도 적용된다. Docker Desktop의 시작은 사용자 로그인에 의존한다. Dama가 올린 Docker 컨테이너의 수명은 Docker가 관리한다.

관리 화면은 `http://127.0.0.1:3100/`이다. 이전에 저장소에서 실행한 로컬 개발 서버가 이 포트를 사용한다면 종료한 뒤 설치판을 시작한다. 기본 데이터 폴더는 `~/Library/Application Support/Dama/data`이며, 업데이트와 프로그램 제거 후에도 보존된다.

설치판으로 처음 옮길 때 기존 DB·PAT·Nginx 데이터를 같은 위치에서 사용하려면 첫 설치 전에 위 데이터 경로에 원래 폴더를 가리키는 심볼릭 링크를 만든다. 기존 서버를 종료한 후 실행한다.

```sh
mkdir -p "$HOME/Library/Application Support/Dama"
ln -s "/absolute/path/to/existing/dama/data" "$HOME/Library/Application Support/Dama/data"
```

이미 설치판의 데이터 폴더가 있다면 기존 데이터를 백업한 뒤 사용할 폴더를 선택한다. Nginx나 Forgejo가 사용 중인 데이터 경로는 Docker에서도 접근할 수 있어야 한다.

## Windows 서버

관리자 계정으로 `Setup.exe`를 실행하고 배포 도메인, 인증서 경로와 Windows 계정 암호를 입력한다. WSL을 처음 설치하는 장비는 재부팅 후 부팅 작업이 설치를 이어간다. 설치 파일에 들어 있는 Dama 빌드를 사용한다. 기존 Windows 서버 설치의 인증서·네트워크 요구 사항은 [Windows 설치 절차](windows-wsl-install.md)를 따른다.

시작 메뉴의 **Dama**에서 상태, 관리 화면, 시작·중지, 설치 복구에 접근한다. Windows의 설치된 앱 목록 또는 시작 메뉴의 **Uninstall Dama**에서 프로그램과 자동 시작 작업을 제거한다. WSL의 Dama 데이터는 보존한다. 이미 설치된 Windows에서 Setup을 다시 실행하면 부팅 작업을 복구한다. 기존 WSL의 서버 버전 교체는 별도의 업데이트 절차가 필요하다.
