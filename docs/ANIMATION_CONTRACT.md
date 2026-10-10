# Animation MVP implementation contract

Primary route `/` is animation home; `/studio/:roomId#invite=...` is animation room. Old fractal home remains `/fractal`, rooms `/room/:roomId` unchanged.

Shared types in `packages/shared/src/animation.ts`, exported by shared index. Settings: width even64..1280, height even64..720, frames1..240, fps24, samples1..32, bounces1..4. Default1280x720/120frames/8samples/3bounces. Quick320x180/24frames/2samples/2bounces; heavy1280x720/240frames/16samples/3bounces. Algorithm `raytrace-v1`. `FrameTask` is one complete frame, independently deterministic; progress is cumulative rows.

## HTTP protocol

Prefix `/api/animation/rooms`. Every route after join uses `Authorization: Bearer <participantToken>`, including assets (fetch to Blob in UI). JSON except binary upload. Success HTTP200 unless specified; errors `{code,message}` with4xx/5xx.

| Method / suffix | Body | Response |
| --- | --- | --- |
| POST root | `{}` |201 AnimationRoomCreated |
| POST `/:roomId/join` | `{inviteToken,hostToken?,name}` | AnimationJoinResult |
| GET `/:roomId/state` | none | AnimationSnapshot; refreshes heartbeat |
| POST `/:roomId/consent` | `{enabled:boolean}` | AnimationSnapshot |
| POST `/:roomId/start` | `{settings:AnimationSettings}` | AnimationSnapshot; host only |
| POST `/:roomId/cancel` | `{}` | AnimationSnapshot; host only |
| POST `/:roomId/task` | `{}` | AnimationTaskResult; consent required, maximum1lease |
| POST `/:roomId/progress` | `{jobId,taskId,attemptId,rows}` | `{ok:true}` |
| PUT `/:roomId/result?jobId=...&taskId=...&attemptId=...&computeMs=...` | `application/octet-stream`, exact rawRGBA width*height*4 | `{accepted:true}` |
| POST `/:roomId/task-error` | `{jobId,taskId,attemptId,message}` | `{ok:true}` |
| POST `/:roomId/leave` | `{}` | `{ok:true}` |
| GET `/:roomId/preview/:jobId/:frameIndex.png` | none | bounded PNG thumbnail |
| GET `/:roomId/video/:jobId.mp4` | none | MP4 (only completed) |

All assignment/result authorization includes participant+job+task+attempt; stale/duplicate/cancelled results must not count. Server samples `renderAnimationPixel` to verify data with RGB tolerance ±1 and exact alpha. Computation runs only after consent; stop/disconnect/cancel/completion destroys the coordinator and its CPU Workers and releases GPU resources. Join returns a new participant token. Frontend preserves token in sessionStorage to resume state polling where valid; on failed reconnect it rejoins without consent. Heartbeat approximately 1s, heartbeat timeout 20s, lease 15s. Only increasing row progress renews the lease; repeated heartbeats do not prove progress. Animation attempts default to 10min (`ANIMATION_MAX_ATTEMPT_MS=600000`), independently of the unchanged 120s fractal attempt cap. Animation job deadline is 30min, independently of the old fractal 10min. Failure and encode errors must show explicitly.

Frames stored as PPM on disk; thumbnails via pngjs; no full-frame broadcast/base64 or accumulation in RAM. Production dependencies include `ffmpeg-static` and `pngjs`, both externalized from the server bundle. Encoder resolves `process.env.FFMPEG_PATH || ffmpegStatic`, subprocess shell:false, fixed arguments, libx264 yuv420p faststart, bounded threads. Server encodes only browser-rendered frames. At most2active rendering/encoding jobs; retained artifacts share a1500MiB disk reservation. Bounded room participants, cleanup on replacement/cancel/TTL/shutdown; temp root server-unique. FFmpeg terminates on cancel/close. Encoding status is separate; final time includes render+encode.

## Compute interface

Every snapshot has a monotonically increasing per-room `revision`. The client ignores older snapshots so delayed polling cannot undo a start/cancel response.

`renderAnimationPixel(settings,frameIndex,x,y): [number,number,number,number]`

`renderAnimationFrame(task): Uint8ClampedArray`

`renderAnimationFrameAsync(task,{onProgress?,signal?,rowsPerChunk?,yieldControl?}): Promise<Uint8ClampedArray>`

`renderAnimationRowsAsync(task,startRow,rowCount,{onProgress?,signal?,rowsPerChunk?,yieldControl?,dutyCycle?,targetChunkMs?,onActiveTime?,now?,sleep?}): Promise<Uint8ClampedArray>`

Row strips use absolute pixel coordinates and deterministic seeds but return a compact `width * rowCount * 4` buffer. Progress is relative to the strip. The CPU scheduler targets approximately 8ms bursts, bounded to small row chunks; one expensive row may take longer. Each measured burst is followed by `ceil(activeMs * (1 / dutyCycle - 1))` idle time, including the last burst. Cancellation is checked before computation and after each yield. `prepareAnimationScene` and `renderAnimationScenePixel` expose reusable scene geometry and reference pixels for GPU corrections.

The CPU reference engine is identical on server and Workers. CPU strip assembly must exactly equal a complete CPU frame. GPU rendering uses the same scene parameters and seeded samples in WGSL; flagged floating-point boundary pixels are repaired by the CPU reference engine. GPU tests verify each RGB channel is within 1 of the CPU reference and alpha is exact. Both engines perform genuine reflection, shadow and antialias computation. The server only recalculates a small pixel sample.

## Browser resource contract

These settings apply to animation only. Legacy fractal computation remains one Worker per browser. Server requests still lease one complete frame per participant; resource percentages and device hints remain local and are not trusted server authorization or metrics.

```ts
interface ResourceLimits {
  cpuPercent: number;
  gpuPercent: number;
  ramPercent: number;
}
interface DeviceResources {
  logicalCores: number;
  deviceMemoryGiB: number | null;
  gpuAvailable: boolean;
}
```

Percentages are normalized to integer 0..100; UI steps are 5. Defaults are CPU 25%, GPU 0%, RAM 10%. The browser persists them in localStorage under `tabcloud:resource-limits:v1`. Changing any setting immediately stops computation and revokes consent; starting again requires explicit participation. Generation guards discard stale opt-in responses, and corrective revocations are awaited before participation is enabled again.

`planResources(settings, limits, device)` returns CPU Worker count/duty, GPU enablement/duty, RAM budget, planned bytes, frame bytes, chunk rows, and an actionable reason when rendering cannot proceed. `navigator.hardwareConcurrency` and `navigator.deviceMemory` are hints, not live OS utilization or free-memory measurements.

- CPU requested capacity is `logicalCores * cpuPercent / 100`. Initial concurrency is its ceiling, bounded by logical cores, 16 Workers, available row strips, and the RAM plan. Per-Worker duty is `min(1, requestedCapacity / actualWorkers)`. CPU 0 disables the CPU Worker pool. Fewer Workers due to RAM cannot increase total CPU capacity above the configured amount.
- RAM budget is `min(512 MiB, deviceMemoryHint * ramPercent / 100)`. If the hint is unavailable, the base is 512 MiB; thus the default budget is 51.2 MiB. Planning reserves three full-frame buffers for output/upload/preview headroom, 64 KiB fixed headroom, two compact CPU strip buffers and 8 MiB allowance per CPU Worker, and up to 32 bytes per GPU strip pixel plus 1 KiB. The pool never schedules a strip larger than `plan.chunkRows` (at most 8). Insufficient budgets reduce concurrency or block participation. Unused RAM is not filled; these bounds do not cap OS RSS, browser heaps or GPU driver allocations.
- GPU 0 does not initialize a render device or submit computation. UI capability probing only requests an adapter. GPU >0 uses one genuine WebGPU compute strip at a time, followed by `ceil(busyMs * (1 / gpuDuty - 1))` idle time, including after the final strip. `busyMs` includes submission, completion/readback and CPU precision repair; it is not a GPU hardware utilization sample.
- CPU 0 does not mean zero host CPU use: GPU submission, buffer handling and flagged-pixel ray tracing still require CPU. Local 720p checks observed roughly 8–16% corrected pixels; this depends on the scene, settings and adapter. Corrections are included in GPU processing time, not CPU Worker active time. More than 40% corrected pixels across a frame causes an explicit precision failure.
- GPU initialization failure can fall back only to the already configured CPU pool; CPU 0 requires an error. Runtime GPU failures discard partial output and stop participation. There is no automatic increase to CPU limits. Software adapters are explicitly labelled `WebGPU 소프트웨어` and do not establish physical GPU acceleration.

WebGPU requires HTTPS or localhost and a supported browser/driver/adapter. Ordinary HTTP LAN addresses use CPU mode. These are upper bounds for this renderer's concurrency, work-time ratio and buffers, not guarantees that system usage equals the selected percentage. Multiple tabs on one device have additive limits. Very low limits, slow adapters and background timer throttling can still miss the 15s progress lease and cause reassignment; repeated unchanged progress must not extend a lease.

## Local scheduling and Worker messages

`renderResourceFrame(task, limits, device, {onProgress?, signal?})` creates one full output buffer and a shared queue of row strips. Each CPU Worker or the GPU takes the next strip after completing its current work and required idle interval, so faster engines receive more strips without changing image quality. The GPU gets the first strip when enabled. CPU Workers are reused within a frame; all CPU Workers and the GPU device are cleaned up on completion, failure or cancellation.

The coordinator request is `{task, token, limits, device}`; `{type:'cancel', token}` aborts current work. Coordinator responses are:

```ts
type ResourceRenderStats = {
  cpuActiveMs: number;
  gpuActiveMs: number;
  completedRows: number;
  trackedBytes: number;
  engine: string;
};
type AnimationWorkerResponse =
  | {type: 'progress'; token: string; rows: number; stats: ResourceRenderStats}
  | {type: 'done'; token: string; pixels: ArrayBuffer; computeMs: number; stats: ResourceRenderStats}
  | {type: 'error'; token: string; message: string};
```

Progress aggregates merged rows and partial CPU strip progress monotonically. `trackedBytes` reserves explicitly managed output/CPU strip/GPU storage-readback-result buffers, excluding heaps and driver overhead. `cpuActiveMs` sums measured CPU Worker bursts; `gpuActiveMs` sums GPU processing wall time including CPU repair but excluding the configured idle waits. `computeMs` remains complete frame wall time including initialization, concurrency and duty waits. RGBA ownership is transferred to the UI for the existing binary upload protocol.

CPU child Worker requests are `{type:'render', task, token, startRow, rowCount, dutyCycle}` or `{type:'cancel', token}`. Progress reports strip-relative rows; done transfers the compact pixel buffer with `activeMs` and `elapsedMs`. The coordinator validates buffer size/timing and rejects stale tokens before merging.

Unit tests cover row partition parity, duty waits including final chunks, resource budget bounds, shared-queue assembly, cancellation and failures. E2E covers resource persistence and stop/re-consent races. `gpu.spec.ts` and `gpu-integration.spec.ts` launch full Chromium's new headless mode for actual WebGPU parity, cancellation, CPU/GPU rendering, server acceptance and MP4 output. In normal CI, a missing adapter skips GPU tests; `REQUIRE_WEBGPU=1` makes absence fail. The adapter name/software fallback flag is recorded; this option alone does not exclude software adapters. Full 720p measurements and final validation results are kept in `VALIDATION.md`.
