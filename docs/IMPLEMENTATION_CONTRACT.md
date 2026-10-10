# MVP implementation contract

This document fixes the interfaces shared by the coordinator, browser, and tests.

- Workspace names: `@tabcloud/shared`, `@tabcloud/compute`, `@tabcloud/server`, `@tabcloud/web`.
- Workspace packages export TypeScript sources; Vite and tsx handle development, esbuild bundles the server for production.
- Protocol version `v: 1`; algorithm version `mandelbrot-v1`.
- `RenderSettings`: `{width,height,tileSize,maxIterations,centerX,centerY,span}`. Shared reference defaults 1024,1024,128,500,-0.5,0,3.5. UI new rooms default to demo preset 2048,2048,128,8000,-0.5,0,3.5; quick and heavy presets use 1024²/500 and 2048²/20000. Span is horizontal complex-plane width; vertical span preserves pixel aspect ratio.
- Limits: dimensions 64..2048; total pixels <= 4194304; tileSize one of 32,64,128; maxIterations 10..20000; centerX/Y -4..4; span 0.000001..8. At most 4096 tiles. All numeric inputs finite. Shared `renderSettingsSchema`, `DEFAULT_SETTINGS`, `LIMITS`.
- `TileTask`: `{jobId,taskId,x,y,width,height,settings,algorithmVersion}`. Pure compute exports `createTiles(jobId, settings): TileTask[]`, `renderPixel(settings,x,y): [number,number,number,number]`, `renderTile(task): Uint8ClampedArray`, `mergeTile(target,task,pixels): void`, `checksum(pixels): string`. Compute must define fixed integer coloring, pixel-center mapping, deterministic checksum, export an async/yielding render helper if needed by Worker progress.
- POST `/api/rooms`, empty JSON body -> 201 `{roomId,inviteToken,hostToken,expiresAt}`. Cryptographically random credentials. GET `/healthz` -> `{status:'ok'}`.
- Same-origin WebSocket `/ws`. Browser invites use `/room/{roomId}#invite={inviteToken}`; hostToken stays in sessionStorage `tabcloud:host:{roomId}` and never appears in the invite URL. Room creation UI saves it.

## Client messages (Zod-validated `clientMessageSchema`)

Every message includes `v:1` and `type`.

- `join-room`: `roomId`, `inviteToken`, optional `hostToken`, `name` (1..32 chars)
- `consent-compute`: `enabled: boolean`
- `request-task`: no extra fields (one active lease per participant)
- `start-job`: `settings: RenderSettings`
- `cancel-job`: `jobId`
- `task-result`: `jobId,taskId,attemptId,pixels` (base64 RGBA), `computeMs` (finite, nonnegative)
- `task-progress`: `jobId,taskId,attemptId,rows` (completed rows, strictly increasing for lease extension)
- `task-error`: `jobId,taskId,attemptId,message` (<=200 chars)
- `heartbeat`, `leave-room`: no extra fields

## Server messages (`ServerMessage` union)

Every message includes `v:1` and `type`.

- `room-snapshot`: `room: RoomSnapshot`, `selfId: string`, `role:'host'|'participant'`.
- `task-assigned`: `task:TileTask`, `attemptId`, `leaseUntil`.
- `task-accepted`: `jobId,taskId,attemptId`.
- `task-rejected`: `jobId,taskId,attemptId,reason`.
- `tile-completed`: `task:TileTask`, `pixels:string`, `participantId:string`.
- `job-cancelled`: `jobId`.
- `error`: `code:string,message:string`.
- `heartbeat-ack`: no extra fields.

`ParticipantSnapshot`: `{id,name,role,connected,consented,completedTasks,computeMs,activeTaskId:string|null}`.

`JobSnapshot`: `{id,status:'created'|'running'|'completed'|'cancelled'|'failed',settings,totalTasks,completedTasks,retries,startedAt:number|null,finishedAt:number|null,wallMs:number|null,computeMs,validationMs,roundTripMs,resultBytes,failureReason:string|null}`. `roundTripMs` sums server assignment-to-result time; it overlaps across clients and must not be described as wall-clock overhead. `computeMs` is client-reported. `validationMs` is server measured. `resultBytes` counts accepted decoded RGBA.

`RoomSnapshot`: `{id,expiresAt,hostConnected:boolean,participants:ParticipantSnapshot[],job:JobSnapshot|null,events:{at:number,message:string}[]}`. Events bounded. Snapshots broadcast after state changes. On join send snapshot then existing completed tiles, enabling observers/reconnection. Replay capped and backpressure handled. Client idempotently merges by jobId/taskId. For a new job clear canvas and received tile IDs.

## Scheduling / browser behavior

- Host may observe without consent. Only an explicit button enables a single Worker and requests work.
- Waiting clients request every ~500 ms while consented, connected and job running; accepted/rejected response triggers next request immediately. Server may record a waiting pull request to dispatch on queue changes.
- Browser render Worker processes row chunks, emits progress and yields so cancellation/progress is possible. Transfer result ArrayBuffer to UI, then encode bounded base64 for socket. Stop means terminate Worker immediately and send consent false. On socket loss/cancel/failure/unmount stop and clear consent. Reconnect with backoff, require renewed explicit consent.
- Heartbeat every 5 s; server timeout 20 s. Initial lease ~15 s; increasing worker progress extends lease, absolute attempt cap 120 s. Retry cap per tile 5. Job cap ~10 minutes, room TTL 1 hour configurable. Server disconnect/withdrawal requeues active lease, stale attempts cannot overwrite accepted results.
- Server validates result IDs, shape/base64 length, random sample pixels using shared renderPixel. Samples are bounded (e.g. 8/tile), validation separately timed. Sample check is not cryptographic proof.
- Jobs/results remain available until next job, room expiry or idle cleanup; cancel clears leases. Disconnect records bounded by participant history limit.
- E2E tests will use accessible labels/buttons plus `data-testid`: `invite-link`, `render-canvas`, `job-status`, `progress`, `participant-list`, `connection-status`, `solo-result`. Settings inputs accessible labels: 너비, 높이, 반복 횟수, 타일 크기, 중심 X, 중심 Y, 가로 범위. Main buttons: 방 만들기, 연산 참여, 연산 중단, 렌더 시작, 작업 취소, PNG 다운로드, 단독 실행 측정.
- PNG available only when server completed and all tile messages received. Solo benchmark one Worker, explicit click only, same settings, wall-clock includes canvas assembly; display image checksum comparison and honest measurement caveats.
