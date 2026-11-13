# 세 언어 모노레포 예제

`examples/monorepo` 자체를 저장소 루트로 사용하는 예제다. 실제 Dama 저장소 전체를 컨텍스트로 사용한다면 Dockerfile의 COPY/WORKDIR 경로도 수정해야 한다. 세 서버는 기본 경로·포트·상태 확인의 동작을 보여주는 최소 예제이며 프로덕션 프레임워크 템플릿이 아니다.

| 서비스 | 언어 | 소스 경로 | Dockerfile 경로 | 빌드 컨텍스트 | 내부 포트 | 접속 경로 이름 |
|---|---|---|---|---|---|---|
| web | TypeScript | apps/typescript-api | apps/typescript-api/Dockerfile | . | 3000 | 빈 값 |
| api | Python | apps/python-api | apps/python-api/Dockerfile | . | 8000 | api |
| tools | Rust | apps/rust-api | apps/rust-api/Dockerfile | . | 8080 | tools |

각 서비스의 상태 확인 경로는 `/health`다. Dama는 UUID와 접속 경로 이름을 붙인 실제 경로로 상태 확인을 계획한다. Dockerfile의 ARG/ENV와 서버 코드가 `DAMA_BASE_PATH`를 반영한다. Rust는 루트 Cargo workspace에서 빌드하고, TypeScript는 별도 npm 패키지를 빌드한다. 여러 언어의 빌드 시스템을 억지로 하나로 통합하지 않는다.

Dama의 서비스 화면에서 언어·빌드 설정을 등록하고 배포 계획을 열면 각 서비스의 Docker argv, 기본 주소와 포트 조회 절차를 볼 수 있다. 계획은 자동으로 실행되지 않는다. 실제 서버의 Nginx는 기존 와일드카드 인증서로 이 주소들을 제공할 수 있다.

이미지를 직접 빌드할 경우 이 디렉터리에서 실행한다.

```sh
docker build -f apps/python-api/Dockerfile --build-arg DAMA_BASE_PATH=/your-project-uuid/api -t dama-example-python .
docker build -f apps/rust-api/Dockerfile --build-arg DAMA_BASE_PATH=/your-project-uuid/tools -t dama-example-rust .
docker build -f apps/typescript-api/Dockerfile --build-arg DAMA_BASE_PATH=/your-project-uuid -t dama-example-typescript .
```

실서비스에서는 프레임워크에 맞는 서버·의존성·패키지 매니저·보안 업데이트를 적용하고 베이스 이미지 버전/digest를 관리한다. 비밀값을 이미지에 복사하거나 build arg로 넘기지 않는다. `.dockerignore`는 예제의 제외 패턴이며 실제 저장소 구조에 맞춰 보완한다.
