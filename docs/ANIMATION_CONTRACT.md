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

All assignment/result authorization includes participant+job+task+attempt; stale/duplicate/cancelled results must not count. Server samples renderAnimationPixel to verify data. Worker runs only after consent; stop/disconnect/cancel/completion destroys Worker and no further work. Join returns a new participant token. Frontend should preserve token in sessionStorage to resume state polling where valid; on failed reconnect rejoin without consent. Heartbeat~1s, heartbeat timeout fromconfig20s, lease15s, progressrefresh, perattempt cap120s. Animation job deadline30min (independent from oldfractal10min). Failure and encode errors must show explicitly.

Frames stored as PPM on disk; thumbnails via pngjs; no full-frame broadcast/base64 or accumulation in RAM. Production dependencies include `ffmpeg-static` and `pngjs`, both externalized from the server bundle. Encoder resolves `process.env.FFMPEG_PATH || ffmpegStatic`, subprocess shell:false, fixed arguments, libx264 yuv420p faststart, bounded threads. Server encodes only browser-rendered frames. At most2active rendering/encoding jobs; retained artifacts share a1500MiB disk reservation. Bounded room participants, cleanup on replacement/cancel/TTL/shutdown; temp root server-unique. FFmpeg terminates on cancel/close. Encoding status is separate; final time includes render+encode.

## Compute interface

Every snapshot has a monotonically increasing per-room `revision`. The client ignores older snapshots so delayed polling cannot undo a start/cancel response.

`renderAnimationPixel(settings,frameIndex,x,y): [number,number,number,number]`

`renderAnimationFrame(task): Uint8ClampedArray`

`renderAnimationFrameAsync(task,{onProgress?,signal?,rowsPerChunk?,yieldControl?}): Promise<Uint8ClampedArray>`

Same deterministic engine onserver andWorker; seeded samples, genuine reflection/shadow/antialias computation. Server only recalculates a small pixel sample. Tests use64x64fewframes forbounded compute; separate720pactualsmoke.
