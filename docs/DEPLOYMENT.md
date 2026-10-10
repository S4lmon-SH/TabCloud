# 실행과 배포

## 로컬 프로덕션 실행

Node.js 24 LTS 및 pnpm 9.15.9를 사용합니다. 실제 검증한 의존성 조합은 lockfile에 고정됩니다. React 19, Vite 6.4.4, Fastify 5, Zod 3, TypeScript 5, Vitest 3 조합을 채택했으며 메이저 버전 일괄 최신화보다 현재 빌드·테스트 호환성을 기준으로 삼았습니다.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

정적 웹·API·WebSocket을 한 Fastify 프로세스가 제공합니다. `/healthz`는 `{"status":"ok"}`를 반환합니다. `pnpm start`는 루트 `.env`를 읽으며, 파일이 없으면 기본값으로 실행합니다. 개발용 `pnpm dev`는 API와 Vite를 함께 시작하고 Vite가 같은 경로를 API 포트로 프록시합니다.

영상 모드는 의존성 설치 시 내려받은 `ffmpeg-static` 실행 파일을 사용합니다. 시스템 FFmpeg를 사용하려면 `FFMPEG_PATH`에 실행 파일 절대 경로를 지정하세요. 서버의 OS 임시 디렉터리에 프레임·영상을 저장하므로 쓰기 권한과 최소 1.5GiB 이상의 여유 공간을 확보합니다. 동시에 렌더링·인코딩하는 작업은 2개이며, 완료 결과도 저장 예산을 차지합니다. 방 상태는 인메모리이고 영상 파일도 임시 보관이므로 영속 저장소로 사용하지 않습니다. 자세한 처리 범위는 [영상 렌더팜 가이드](ANIMATION.md)에 있습니다.

## Docker / Compose

Docker Desktop에서는 Linux 컨테이너 엔진을 켜세요. Compose 2.24 이상을 사용합니다.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f tabcloud
```

`http://localhost:3001`로 접속합니다. 포트 변경은 루트 `.env`의 `PORT=4000`처럼 설정합니다. 외부 포트만 바뀌며 컨테이너 내부 포트는 3001로 유지됩니다. `.env`의 `PUBLIC_ORIGIN`을 실제 접속 origin과 일치시키세요. 여러 origin은 쉼표로 구분하며 경로나 끝의 `/`를 붙이지 않습니다. 다른 운영 제한도 `.env.example`에서 복사해 조절합니다.

```sh
docker compose down
```

볼륨에 결과를 저장하지 않습니다. 종료·재배포·재시작은 진행 중인 방과 결과를 없애므로 완료 이미지를 먼저 다운로드하세요. 컨테이너는 일반 `node` 사용자로 실행합니다. 기본 Compose 제한은 메모리 768MiB, CPU 2개이며 실제 서버 사양과 사용량에 맞춰 조정합니다. 서버가 고비용 전체 픽셀을 계산하는 구조는 아닙니다.

## HTTPS/WSS — 호스트 Caddy 예시

다음은 이미 보유한 도메인과 서버에서 운영자가 직접 실행할 예시입니다. 공개 도메인·클라우드 VM·유료 API는 프로젝트에서 생성하지 않습니다. 도메인 및 서버 비용은 공급자 요금에 따라 발생할 수 있습니다.

1. 도메인의 DNS를 서버에 연결합니다.
2. 외부에는 80/443만 공개하고 앱은 loopback에 바인딩합니다.
3. 실제 도메인으로 `PUBLIC_ORIGIN`을 설정하고 HTTPS 리버스 프록시를 사용합니다.

```sh
docker build -t tabcloud:mvp .
docker run -d --name tabcloud --restart unless-stopped --init \
  -p 127.0.0.1:3001:3001 --memory=768m --cpus=2 \
  -e PUBLIC_ORIGIN=https://tabcloud.example.com \
  tabcloud:mvp
```

위 명령은 POSIX shell 문법입니다. PowerShell에서는 한 줄로 실행하거나 줄 끝을 PowerShell의 줄 연속 문법으로 바꾸세요.

호스트에서 실행하는 Caddy의 `Caddyfile`:

```caddyfile
tabcloud.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
    header Strict-Transport-Security "max-age=31536000"
}
```

Caddy가 HTTPS와 WebSocket upgrade를 처리합니다([공식 reverse_proxy 문서](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)). 브라우저는 페이지가 HTTPS이면 자동으로 `wss://같은호스트/ws`를 사용합니다. 앱의 출처 검사에서는 요청 Host 또는 명시된 `PUBLIC_ORIGIN`만 허용합니다. 백엔드 포트를 외부에 직접 열지 말고 프록시 자체의 연결·IP별 요청 제한을 구성하세요. 앱은 기본적으로 전달된 IP 헤더를 신뢰하지 않습니다.

## 환경변수와 유지관리

전체 예시는 루트 `.env.example`, 실제 기본값과 검사 로직은 `apps/server/src/config.ts`에 있습니다. 타이머는 유효한 Node 타이머 범위 안이어야 하고 참가자 기록은 256명을 넘을 수 없습니다. `MAX_RETRIES=0`은 재시도를 끕니다. `STATIC_DIR`로 정적 웹 빌드 경로를 별도로 지정할 수 있습니다.

- 방 수명·빈 방 정리: `ROOM_TTL_MS`, `IDLE_ROOM_TTL_MS`
- 계산/연결 수명: `HEARTBEAT_TIMEOUT_MS`, `LEASE_MS`, `MAX_ATTEMPT_MS`, `MAX_JOB_MS`, `SWEEP_INTERVAL_MS`
- 참여자/접속 수: `MAX_ROOMS`, `MAX_PARTICIPANTS`, `MAX_PARTICIPANT_HISTORY`, `MAX_CONNECTIONS`
- 크기/속도 예산: `MAX_JOB_BYTES`, `MAX_TOTAL_RESULT_BYTES`, `MAX_BUFFERED_BYTES`, `MAX_MESSAGES_PER_SECOND`, `ROOM_CREATES_PER_MINUTE`

256명 프로토콜 한도는 작은 서버가 그 규모를 충분히 지원한다는 성능 보장이 아닙니다. 기본 24명 범위에서 계측하고 조정하세요. 결과 broadcast는 참여자 수와 이미지 크기에 따라 트래픽이 증가합니다. 저장 예산은 결과 데이터 중심의 예약치여서 프로세스 RSS는 그보다 클 수 있습니다.

GitHub Actions는 설치→정적 검사→단위/통합→빌드→Chromium E2E→Docker 빌드로 구성되어 있습니다. 저장소를 GitHub에 올린 후 실제 원격 실행 결과를 확인해야 합니다. 의존성 업데이트 시 lockfile과 전체 검증을 함께 갱신하세요.

## 문제 해결

- `docker ... pipe/dockerDesktopLinuxEngine` 연결 실패: Docker Desktop의 Linux 엔진을 시작합니다.
- `EADDRINUSE`: 기존 프로세스를 확인하거나 `PORT`를 바꿉니다. Vite 개발 포트 기본값은 5173입니다.
- 방 생성/WS 출처 거절: 프록시 Host 보존과 정확한 `PUBLIC_ORIGIN`을 확인합니다.
- 다른 기기에서 초대 링크 접속 실패: `localhost`를 공유하지 말고 LAN IP/실제 HTTPS 도메인으로 방을 만듭니다.
- 기존 링크에 만료/재시작 안내: 인메모리 데이터가 사라진 정상 제한입니다. 새 방을 만듭니다.
- lease가 반복 만료: 탭을 전면에 두고 타일 크기·반복 횟수를 줄입니다. 장시간 모든 픽셀이 집합 내부에 있는 확대 영역은 특히 계산량이 큽니다.
- 완성된 이미지는 보이지만 비교 비율이 없음: 현재 페이지에서 작업 시작을 측정하지 않았거나 재연결되었습니다. 새 작업으로 다시 비교합니다.
