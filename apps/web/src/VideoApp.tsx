import { useEffect, useRef, useState, type FormEvent } from 'react';
import { VIDEO_LIMITS, VIDEO_INPUT_EXTENSIONS, DEFAULT_VIDEO_PROCESSING, DEFAULT_VIDEO_OUTPUT, resolveVideoOutput, videoOutputSettingsSchema, videoProcessingSettingsSchema, type VideoAssignment, type VideoJoinResult, type VideoRoomCreated, type VideoProcessingSettings, type VideoOutputSettings, type VideoSnapshot, type VideoTaskResult } from '@tabcloud/shared';
import type { VideoWorkerRequest, VideoWorkerResponse } from './video.worker';
import { ApiConfigurationError, ApiReadinessError, apiUrl, waitForApiReady } from './api-origin';
import { ResourceControls } from './ResourceControls';
import { detectDeviceResources, normalizeResourceLimits, type ResourceLimits } from './resource-budget';

import { planVideoResources, type VideoRenderStats } from './video-renderer';
import { probeVideoGpu } from './video-gpu';
import { prepareVideoTransfer, waitForVideoTransferRetry } from './video-transfer';

const resourceStorageKey = 'tabcloud:video:resource-limits:v1';
function savedResourceLimits(): ResourceLimits {
  try { return normalizeResourceLimits(JSON.parse(localStorage.getItem(resourceStorageKey) || '{"cpuPercent":25,"gpuPercent":100,"ramPercent":10}')); }
  catch { return { cpuPercent: 25, gpuPercent: 100, ramPercent: 10 }; }
}

type Connection = 'connecting' | 'online' | 'error';
type RoomActions = { consent: (enabled: boolean) => Promise<void>; start: (settings: VideoProcessingSettings, output: VideoOutputSettings) => Promise<void>; cancel: () => Promise<void>; upload: (file: File) => Promise<void>; cancelUpload: () => Promise<void> };
const noActions: RoomActions = { consent: async () => {}, start: async () => {}, cancel: async () => {}, upload: async () => {}, cancelUpload: async () => {} };
const statusNames = { rendering: '영상 처리 중', encoding: '영상으로 묶는 중', completed: '영상 완성', cancelled: '작업 취소됨', failed: '작업 실패', idle: '준비됨' };
const phaseNames = { decoding: '다음 구간 준비 중', processing: '영상 처리 중', 'encoding-segment': '처리한 구간 저장 중', finalizing: '최종 영상 완성 중' };
const frameRate = (fps: number) => `${Number(fps.toFixed(2))}fps`;
const seconds = (ms: number | null | undefined) => ms == null ? '—' : ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.floor(ms / 1000) % 60}초` : `${(ms / 1000).toFixed(1)}초`;
const participantKey = (roomId: string) => `tabcloud:video:participant:${roomId}`;
const hostKey = (roomId: string) => `tabcloud:video:host:${roomId}`;
class RequestError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message); } }

function Icon({ type }: { type: 'arrow' | 'copy' | 'play' | 'stop' | 'download' | 'film' }) {
  const paths = { arrow: 'M4 12h16m-6-6 6 6-6 6', copy: 'M8 8h12v12H8zM16 8V4H4v12h4', play: 'm8 5 11 7-11 7Z', stop: 'M6 6h12v12H6Z', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', film: 'M3 5h18v14H3zM7 5v14M17 5v14M3 10h4m-4 4h4m10-4h4m-4 4h4' };
  return <svg className="an-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[type]} /></svg>;
}
function Brand() { return <a className="an-brand" href="/" aria-label="TabCloud 홈"><span className="an-logo" aria-hidden="true"><i /><i /><i /><i /></span>TabCloud</a>; }
async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; code?: string };
    throw new RequestError(body.message || (response.status === 404 ? '방이 만료되었거나 존재하지 않아요.' : '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'), response.status, body.code);
  }
  return response.json() as Promise<T>;
}

function Home() {
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const createAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const leave = () => { createAbortRef.current?.abort(); setCreating(false); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); createAbortRef.current?.abort(); };
  }, []);
  async function createRoom() {
    if (createAbortRef.current) return;
    const controller = new AbortController();
    createAbortRef.current = controller;
    setCreating(true); setError('');
    try {
      await waitForApiReady(controller.signal);
      controller.signal.throwIfAborted();
      const room = await readResponse<VideoRoomCreated>(await fetch(apiUrl('/api/video/rooms'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) }));
      controller.signal.throwIfAborted();
      sessionStorage.setItem(hostKey(room.roomId), room.hostToken);
      location.assign(`/video/${encodeURIComponent(room.roomId)}#invite=${encodeURIComponent(room.inviteToken)}`);
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '방을 만들지 못했어요.'); }
    finally { if (createAbortRef.current === controller) createAbortRef.current = null; if (!controller.signal.aborted) setCreating(false); }
  }
  function join(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const url = new URL(invite.trim(), location.origin);
      if (!/^\/(video|studio|room)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || !new URLSearchParams(url.hash.slice(1)).get('invite')) throw new Error();
      location.assign(`${url.pathname}${url.hash}`);
    } catch { setError('초대받은 링크 전체를 입력해 주세요.'); }
  }
  return <div className="an-app vd-app"><header className="an-header"><Brand /><a className="an-header-link" href="/animation">3D 렌더 실험실 ↗</a></header>
    <main className="vd-home"><div className="vd-home-heading"><span className="an-eyebrow">Distributed video studio</span><h1>내 영상, 더 선명하게.<br /><span>함께 연결한 GPU로.</span></h1><p>영상을 올리고 기기를 연결하세요.<br />노이즈 제거부터 색 보정까지, 나눠서 처리해요.</p></div>
      <div className="vd-workflow" aria-hidden="true"><span><Icon type="film" />영상 업로드</span><i>→</i><span className="vd-workflow-gpu">GPU + CPU</span><i>→</i><span><Icon type="download" />완성된 영상</span></div>
      <div className="an-home-actions"><section className="an-home-card"><h2>내 영상 작업하기</h2><p>최대 1080p · 60fps · 2분<br />MP4 · MOV · WebM · MKV · AVI 등, 256 MiB</p><button className="an-button primary" onClick={() => void createRoom()} disabled={creating}>{creating ? '방 만드는 중…' : '방 만들기'}<Icon type="arrow" /></button></section>
        <form className="an-home-card" onSubmit={join}><h2>기기 연결하기</h2><p>초대 링크로 연산에 참여해요.</p><div className="an-join-controls"><label className="an-sr-only" htmlFor="video-join">초대 링크</label><input id="video-join" className="an-input" placeholder="초대 링크 붙여넣기" value={invite} onChange={(event) => setInvite(event.target.value)} required /><button className="an-button secondary" type="submit">참여하기<Icon type="arrow" /></button></div></form></div>
      {error && <div className="an-notice error" role="alert">{error}</div>}
    </main></div>;
}

function Studio({ roomId, inviteToken }: { roomId: string; inviteToken: string }) {
  const [room, setRoom] = useState<VideoSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [consented, setConsented] = useState(false);
  const [activeFrame, setActiveFrame] = useState<number | null>(null);
  const [activeRows, setActiveRows] = useState(0);
  const [settings, setSettings] = useState<VideoProcessingSettings>({ ...DEFAULT_VIDEO_PROCESSING });
  const [output, setOutput] = useState<VideoOutputSettings>({ ...DEFAULT_VIDEO_OUTPUT });
  const outputRef = useRef(output);
  const [error, setError] = useState('');
  const [actionPending, setActionPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoError, setVideoError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [videoRetry, setVideoRetry] = useState(0);
  const [limits, setLimits] = useState(savedResourceLimits);
  const [device, setDevice] = useState(() => ({ ...detectDeviceResources(), gpuAvailable: false }));
  const [resourceStats, setResourceStats] = useState<VideoRenderStats>();
  const [gpuName, setGpuName] = useState('GPU 확인 중…');
  const [gpuChecking, setGpuChecking] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [view, setView] = useState<'original' | 'processed'>('original');
  const sourceUrlRef = useRef('');
  const sourcePreviewUrlRef = useRef('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [resourceNotice, setResourceNotice] = useState('');
  const [resourceApplying, setResourceApplying] = useState(false);
  const resourceRevocations = useRef(0);
  const limitsRef = useRef(limits);
  const deviceRef = useRef(device);
  const roomRef = useRef<VideoSnapshot | null>(null);
  const tokenRef = useRef('');
  const actionsRef = useRef<RoomActions>(noActions);
  const inviteRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef('');
  const videoUrlRef = useRef('');
  const inviteLink = `${location.origin}/video/${roomId}#invite=${encodeURIComponent(inviteToken)}`;
  const endpoint = `/api/video/rooms/${encodeURIComponent(roomId)}`;

  useEffect(() => {
    let disposed = false;
    // Adapter discovery does not create a GPU device or submit any computation.
    void (async () => {
      const result = await probeVideoGpu();
      if (!disposed) {
        const detected = { ...detectDeviceResources(), gpuAvailable: result.available };
        deviceRef.current = detected; setDevice(detected); setGpuChecking(false);
        setGpuName(result.available ? result.adapterName || '하드웨어 GPU' : result.reason || 'GPU를 사용할 수 없어요. Chrome·Edge에서 확인해 주세요.');
      }
    })();
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let token = sessionStorage.getItem(participantKey(roomId)) || '';
    let worker: Worker | null = null;
    let lease: VideoAssignment | null = null;
    let consent = false;
    let requesting = false;
    let polling = false;
    let generation = 0;
    let uploadAbort: AbortController | null = null;
    let sourceAbort: AbortController | null = null;
    let sourceUpload: XMLHttpRequest | null = null;
    let sourceGeneration = 0;
    let joinAbort: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fatal = false;
    let lastProgressAt = 0;
    let needsConsentReset = Boolean(token);
    let pageHidden = false;
    tokenRef.current = token;

    async function api<T>(suffix: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
      return readResponse<T>(await fetch(apiUrl(`${endpoint}${suffix}`), { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) }));
    }
    function destroyWorker(resetConsent = true) {
      generation += 1; worker?.terminate(); worker = null; lease = null; requesting = false;
      uploadAbort?.abort(); uploadAbort = null;
      sourceAbort?.abort(); sourceAbort = null;
      if (!disposed) { setActiveFrame(null); setActiveRows(0); setResourceStats((previous) => previous && ({ ...previous, trackedBytes: 0 })); }
      if (resetConsent) { consent = false; if (!disposed) setConsented(false); }
    }
    function apply(snapshot: VideoSnapshot) {
      if (disposed || pageHidden) return;
      if (roomRef.current?.id === snapshot.id && snapshot.revision <= roomRef.current.revision) return;
      const previousJob = roomRef.current?.job?.id;
      const stopForJob = (lease && (lease.task.jobId !== snapshot.job?.id || snapshot.job.status !== 'rendering')) || (snapshot.job && snapshot.job.status !== 'rendering');
      if (stopForJob && (worker || consent)) {
        const notify = consent;
        destroyWorker();
        if (notify) void api('/consent', { enabled: false }).catch(() => {});
      }
      roomRef.current = snapshot; setRoom(snapshot); setConnection('online');
      if (snapshot.role !== 'host' && snapshot.job) { setSettings(snapshot.job.settings); setOutput(snapshot.job.output); outputRef.current = snapshot.job.output; }
      if (previousJob !== snapshot.job?.id) setSelectedFrame(null);
    }
    function disconnected(err: unknown) {
      if (disposed || pageHidden) return;
      destroyWorker(); setConnection('error');
      needsConsentReset = Boolean(token);
      setError(err instanceof RequestError || err instanceof ApiConfigurationError || err instanceof ApiReadinessError ? err.message : fatal ? '방에 연결하지 못했어요. 잠시 후 새로고침해 주세요.' : '연결이 끊겼어요. 다시 연결되면 연산 참여를 눌러 주세요.');
      if (err instanceof ApiConfigurationError) fatal = true;
      if (err instanceof RequestError && [401, 403].includes(err.status)) { if (!token) fatal = true; token = ''; tokenRef.current = ''; sessionStorage.removeItem(participantKey(roomId)); }
      if (err instanceof RequestError && err.status === 404) fatal = true;
    }
    async function requestTask() {
      if (disposed || pageHidden || !consent || !worker || lease || requesting || roomRef.current?.job?.status !== 'rendering') return;
      requesting = true;
      const current = generation;
      try {
        const result = await api<VideoTaskResult>('/task', {});
        if (disposed || !consent || current !== generation || !worker) return;
        if (result.assignment) {
          if (result.assignment.task.jobId !== roomRef.current?.job?.id || roomRef.current.job.status !== 'rendering') return;
          lease = result.assignment; lastProgressAt = 0;
          const plan = planVideoResources(lease.task, limitsRef.current, deviceRef.current);
          if (!plan.canRender) {
            destroyWorker(); setError(plan.reason || '현재 자원 한도로는 렌더링할 수 없어요.');
            void api('/consent', { enabled: false }).catch(() => {});
            return;
          }
          setActiveFrame(lease.task.frameIndex); setActiveRows(0);
          const assignment = lease;
          sourceAbort = new AbortController();
          const query = new URLSearchParams({ taskId: assignment.task.taskId, attemptId: assignment.attemptId });
          const signal = AbortSignal.any([sourceAbort.signal, AbortSignal.timeout(45_000)]);
          let response: Response;
          for (let retry = 0; ; retry += 1) {
            response = await fetch(apiUrl(`${endpoint}/source/${encodeURIComponent(assignment.task.jobId)}/${assignment.task.frameIndex}.rgba?${query}`), { headers: { Authorization: `Bearer ${token}` }, signal });
            if (response.status !== 429 || retry >= 5) { if (!response.ok) await readResponse(response); break; }
            await response.body?.cancel();
            await waitForVideoTransferRetry(retry, signal);
            if (disposed || pageHidden || !consent || current !== generation || lease !== assignment) return;
          }
          const pixels = await response.arrayBuffer();
          if (disposed || pageHidden || !consent || current !== generation || !worker || lease !== assignment) return;
          sourceAbort = null;
          if (pixels.byteLength !== assignment.task.width * assignment.task.height * 4) throw new Error('원본 프레임 크기가 올바르지 않아요.');
          worker.postMessage({ type: 'render', task: assignment.task, pixels, token: assignment.attemptId, limits: limitsRef.current, device: deviceRef.current } satisfies VideoWorkerRequest, [pixels]);
        }
      } catch (err) {
        if (current !== generation || disposed) return;
        if (err instanceof RequestError && err.code === 'CONSENT_REQUIRED') {
          destroyWorker();
          try { apply(await api<VideoSnapshot>('/state')); } catch (refreshError) { disconnected(refreshError); }
        } else disconnected(err);
      }
      finally { if (current === generation) requesting = false; }
    }
    function createWorker() {
      const nextWorker = new Worker(new URL('./video.worker.ts', import.meta.url), { type: 'module', name: 'TabCloud video processor' });
      worker = nextWorker;
      nextWorker.onmessage = async ({ data }: MessageEvent<VideoWorkerResponse>) => {
        const assignment = lease;
        if (disposed || worker !== nextWorker || !consent || !assignment || data.token !== assignment.attemptId) return;
        const ids = { jobId: assignment.task.jobId, taskId: assignment.task.taskId, attemptId: assignment.attemptId };
        if (data.type === 'progress') {
          setActiveRows(data.rows);
          setResourceStats(data.stats);
          if (performance.now() - lastProgressAt >= 1000 || data.rows === assignment.task.height) {
            lastProgressAt = performance.now();
            void api('/progress', { ...ids, rows: data.rows }).catch((err) => { if (lease === assignment && !(err instanceof RequestError && err.status === 409)) disconnected(err); });
          }
          return;
        }
        if (data.type === 'error') {
          void api('/task-error', { ...ids, message: data.message.slice(0, 200) }).catch(() => {});
          destroyWorker(); setError(data.message.slice(0, 240) || '이 기기의 연산이 중단됐어요. 자원 설정을 확인해 주세요.');
          void api('/consent', { enabled: false }).catch(() => {});
          return;
        }
        const current = generation;
        setResourceStats(data.stats);
        uploadAbort = new AbortController();
        try {
          const query = new URLSearchParams({ ...ids, computeMs: String(data.computeMs), engine: data.stats.frameGpuRows > 0 ? data.stats.frameCpuRows > 0 ? 'mixed' : 'gpu' : 'cpu' });
          const signal = AbortSignal.any([uploadAbort.signal, AbortSignal.timeout(60_000)]);
          const transfer = await prepareVideoTransfer(data.pixels, signal);
          if (disposed || pageHidden || current !== generation || lease !== assignment) return;
          if (transfer.encoding) query.set('encoding', transfer.encoding);
          for (let retry = 0; ; retry += 1) {
            const response = await fetch(apiUrl(`${endpoint}/result?${query}`), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: transfer.body, signal });
            if (response.status !== 429 || retry >= 5) { await readResponse<{ accepted: true }>(response); break; }
            await response.body?.cancel();
            await waitForVideoTransferRetry(retry, signal);
            if (disposed || current !== generation || lease !== assignment) return;
          }
          if (disposed || current !== generation || lease !== assignment) return;
          lease = null; uploadAbort = null; setActiveFrame(null); setActiveRows(0);
          void requestTask();
        } catch (err) {
          if (disposed || current !== generation) return;
          if (err instanceof RequestError && err.status === 429) {
            await api('/task-error', { ...ids, message: 'Result upload remained busy after bounded retries.' }).catch(() => {});
            if (disposed || current !== generation) return;
            lease = null; uploadAbort = null; setActiveFrame(null); setActiveRows(0);
          } else if (err instanceof RequestError && err.status === 409) { lease = null; uploadAbort = null; setActiveFrame(null); void requestTask(); }
          else disconnected(err);
        }
      };
      nextWorker.onerror = () => {
        if (worker !== nextWorker || disposed) return;
        destroyWorker(); setError('연산 Worker를 실행하지 못했어요. 브라우저를 확인해 주세요.');
        void api('/consent', { enabled: false }).catch(() => {});
      };
    }
    async function changeConsent(enabled: boolean) {
      if (disposed || pageHidden || !token) return;
      setError('');
      if (!enabled) {
        destroyWorker();
        try { apply(await api<VideoSnapshot>('/consent', { enabled: false })); } catch (err) { disconnected(err); }
        return;
      }
      if (typeof Worker === 'undefined') { setError('Web Worker를 지원하는 최신 브라우저에서 참여해 주세요.'); return; }
      const currentJob = roomRef.current?.job;
      const currentSource = roomRef.current?.source;
      const dimensions = currentJob?.status === 'rendering' ? currentJob : currentSource?.status === 'ready' ? resolveVideoOutput(currentSource, outputRef.current) : { width: 1920, height: 1080 };
      const plan = planVideoResources(dimensions, limitsRef.current, deviceRef.current);
      if (!plan.canRender) { setError(plan.reason || '사용할 자원을 선택해 주세요.'); return; }
      try {
        destroyWorker();
        setResourceNotice('');
        const current = generation;
        const snapshot = await api<VideoSnapshot>('/consent', { enabled: true });
        if (disposed || pageHidden || current !== generation) { await api('/consent', { enabled: false }).catch(() => {}); return; }
        apply(snapshot);
        if (roomRef.current?.job && roomRef.current.job.status !== 'rendering') { await api('/consent', { enabled: false }).catch(() => {}); return; }
        createWorker(); consent = true; setConsented(true); void requestTask();
      } catch (err) { destroyWorker(); void api('/consent', { enabled: false }).catch(() => {}); disconnected(err); }
    }
    actionsRef.current = {
      consent: changeConsent,
      start: async (newSettings, newOutput) => { setError(''); setView('processed'); try { apply(await api<VideoSnapshot>('/start', { settings: newSettings, output: newOutput })); void requestTask(); } catch (err) { setError(err instanceof Error ? err.message : '작업을 시작하지 못했어요.'); } },
      cancel: async () => { destroyWorker(); setError(''); try { apply(await api<VideoSnapshot>('/cancel', {})); } catch (err) { setError(err instanceof Error ? err.message : '작업을 취소하지 못했어요.'); } },
      upload: async (file) => {
        sourceGeneration += 1; const current = sourceGeneration;
        sourceUpload?.abort(); destroyWorker();
        setUploading(true); setUploadProgress(0); setError(''); setView('original');
        try {
          await api('/consent', { enabled: false });
          if (disposed || pageHidden || current !== sourceGeneration) return;
          const snapshot = await new Promise<VideoSnapshot>((resolve, reject) => {
            const request = new XMLHttpRequest(); sourceUpload = request;
            request.open('PUT', apiUrl(`${endpoint}/upload`));
            request.setRequestHeader('Authorization', `Bearer ${token}`);
            request.setRequestHeader('Content-Type', 'application/octet-stream');
            request.timeout = 600_000;
            request.upload.onprogress = (event) => { if (event.lengthComputable && current === sourceGeneration && !disposed) setUploadProgress(Math.round(event.loaded / event.total * 100)); };
            request.onload = () => {
              let payload: VideoSnapshot & { message?: string };
              try { payload = JSON.parse(request.responseText) as typeof payload; } catch { reject(new Error('영상 업로드 응답을 읽지 못했어요.')); return; }
              if (request.status >= 200 && request.status < 300) resolve(payload);
              else reject(new RequestError(payload.message || '영상을 업로드하지 못했어요.', request.status));
            };
            request.onerror = () => reject(new Error('업로드 연결이 끊겼어요. 다시 시도해 주세요.'));
            request.ontimeout = () => reject(new Error('업로드 시간이 초과됐어요. 더 작은 영상으로 다시 시도해 주세요.'));
            request.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
            request.send(file);
          });
          if (!disposed && !pageHidden && current === sourceGeneration) apply(snapshot);
        } catch (err) { if (!disposed && current === sourceGeneration) { clearLocalSource(); setError(err instanceof Error ? err.message : '업로드하지 못했어요.'); } }
        finally { if (current === sourceGeneration) { sourceUpload = null; if (!disposed) setUploading(false); } }
      },
      cancelUpload: async () => {
        sourceGeneration += 1; sourceUpload?.abort(); sourceUpload = null; setUploading(false); setError(''); clearLocalSource();
        try { apply(await api<VideoSnapshot>('/cancel', {})); } catch (err) { setError(err instanceof Error ? err.message : '준비를 취소하지 못했어요.'); }
      },
    };
    async function join() {
      const controller = new AbortController();
      joinAbort = controller;
      try {
        await waitForApiReady(controller.signal);
        if (disposed || pageHidden || controller.signal.aborted) return;
        let name = sessionStorage.getItem('tabcloud:name');
        if (!name) { name = `브라우저 ${Math.random().toString(36).slice(2, 6).toUpperCase()}`; sessionStorage.setItem('tabcloud:name', name); }
        const result = await readResponse<VideoJoinResult>(await fetch(apiUrl(`${endpoint}/join`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteToken, hostToken: sessionStorage.getItem(hostKey(roomId)) || undefined, name }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) }));
        if (disposed || pageHidden || controller.signal.aborted) { void fetch(apiUrl(`${endpoint}/leave`), { method: 'POST', headers: { Authorization: `Bearer ${result.participantToken}`, 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {}); return; }
        token = result.participantToken; tokenRef.current = token; sessionStorage.setItem(participantKey(roomId), token);
        setError('');
        apply(result.snapshot);
      } catch (err) {
        // A failed POST may have joined on the server; don't create another participant automatically.
        if (!disposed && !pageHidden) fatal = true;
        throw err;
      } finally { if (joinAbort === controller) joinAbort = null; }
    }
    async function tick() {
      if (disposed || pageHidden || polling || fatal) return;
      polling = true;
      try {
        if (!token) { await join(); needsConsentReset = false; }
        else if (needsConsentReset) { apply(await api<VideoSnapshot>('/consent', { enabled: false })); needsConsentReset = false; }
        else apply(await api<VideoSnapshot>('/state'));
        if (!disposed) void requestTask();
      } catch (err) { disconnected(err); }
      finally { polling = false; if (!disposed && !fatal) timer = setTimeout(() => void tick(), 900); }
    }
    async function initialize() {
      await tick();
    }
    function leave() {
      pageHidden = true;
      joinAbort?.abort();
      sourceGeneration += 1; sourceUpload?.abort(); sourceUpload = null;
      destroyWorker();
      try {
        if (token) void fetch(apiUrl(`${endpoint}/leave`), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
      } catch { /* Invalid API configuration was already reported while connecting. */ }
    }
    function restore(event: PageTransitionEvent) {
      if (!event.persisted || disposed) return;
      pageHidden = false; token = ''; tokenRef.current = ''; sessionStorage.removeItem(participantKey(roomId));
      clearTimeout(timer); void tick();
    }
    function offline() { disconnected(new Error('Offline')); }
    const clockTimer = setInterval(() => setClock(Date.now()), 1000);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', restore);
    window.addEventListener('offline', offline);
    void initialize();
    return () => { disposed = true; clearTimeout(timer); clearInterval(clockTimer); window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', restore); window.removeEventListener('offline', offline); leave(); actionsRef.current = noActions; };
  }, [endpoint, inviteToken, roomId]);

  const job = room?.job;
  const jobId = job?.id;
  const currentPreview = selectedFrame !== null && (job?.frames.includes(selectedFrame) || selectedFrame < (job?.windowStart ?? 0)) ? selectedFrame : job?.frames.at(-1);
  useEffect(() => {
    setSelectedFrame(null); setPreviewUrl(''); setVideoUrl(''); setVideoError('');
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    previewUrlRef.current = ''; videoUrlRef.current = '';
  }, [jobId]);
  useEffect(() => {
    if (!jobId || currentPreview === undefined || !tokenRef.current) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(apiUrl(`${endpoint}/preview/${encodeURIComponent(jobId)}/${currentPreview}.png`), { headers: { Authorization: `Bearer ${tokenRef.current}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) return;
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url; setPreviewUrl(url);
      } catch { /* A newer frame or a disconnected room will refresh the preview. */ }
    })();
    return () => controller.abort();
  }, [currentPreview, endpoint, jobId]);
  useEffect(() => {
    if (!jobId || job?.status !== 'completed' || !tokenRef.current) return;
    const controller = new AbortController();
    setVideoError('');
    void (async () => {
      try {
        const response = await fetch(apiUrl(`${endpoint}/video/${encodeURIComponent(jobId)}.mp4`), { headers: { Authorization: `Bearer ${tokenRef.current}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
        if (!response.ok) throw new Error('영상을 가져오지 못했어요.');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = url; setVideoUrl(url);
      } catch (err) { if (!controller.signal.aborted) setVideoError(err instanceof Error ? err.message : '영상을 가져오지 못했어요.'); }
    })();
    return () => controller.abort();
  }, [endpoint, jobId, job?.status, videoRetry]);
  useEffect(() => () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current); if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current); if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current); }, []);

  const source = room?.source;
  useEffect(() => {
    if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current);
    sourcePreviewUrlRef.current = ''; setSourcePreviewUrl('');
    if (!source || source.status !== 'ready' || room?.role !== 'host' || !tokenRef.current) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(apiUrl(`${endpoint}/source-preview/${encodeURIComponent(source.id)}.png`), { headers: { Authorization: `Bearer ${tokenRef.current}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) return;
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current);
        sourcePreviewUrlRef.current = url; setSourcePreviewUrl(url);
      } catch { /* The uploaded local file remains available for preview. */ }
    })();
    return () => controller.abort();
  }, [endpoint, source?.id, source?.status, room?.role]);

  useEffect(() => {
    if (source?.failureReason) clearLocalSource();
  }, [source?.failureReason]);

  function clearLocalSource() {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = ''; setSourceUrl(''); setSourceName('');
  }

  function selectFile(file?: File) {
    if (!file || uploading || roomRef.current?.source?.status === 'preparing' || ['rendering', 'encoding'].includes(roomRef.current?.job?.status || '')) return;
    if (!(VIDEO_INPUT_EXTENSIONS as readonly string[]).includes(file.name.split('.').at(-1)?.toLowerCase() ?? '')) { setError('지원하는 영상 파일을 선택해 주세요. MP4, MOV, WebM, MKV, AVI 등을 사용할 수 있어요.'); return; }
    if (!file.size || file.size > VIDEO_LIMITS.maxUploadBytes) { setError('영상 크기는 0바이트 초과, 256 MiB 이하여야 해요.'); return; }
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = URL.createObjectURL(file); setSourceUrl(sourceUrlRef.current); setSourceName(file.name);
    void actionsRef.current.upload(file);
  }

  async function copyInvite() {
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setShowInvite(true); requestAnimationFrame(() => { inviteRef.current?.focus(); inviteRef.current?.select(); }); }
  }
  async function perform(action: () => Promise<void>) { setActionPending(true); try { await action(); } finally { setActionPending(false); } }
  function changeResourceLimits(next: ResourceLimits) {
    // Revoking consent synchronously terminates the coordinator and its child Workers.
    // Keep sliders available during a pending consent response; generation guards reject it.
    resourceRevocations.current += 1; setResourceApplying(true);
    void actionsRef.current.consent(false).finally(() => {
      resourceRevocations.current -= 1;
      if (resourceRevocations.current === 0) setResourceApplying(false);
    });
    const normalized = normalizeResourceLimits(next);
    limitsRef.current = normalized; setLimits(normalized);
    try { localStorage.setItem(resourceStorageKey, JSON.stringify(normalized)); } catch { /* In-memory settings still apply. */ }
    setResourceNotice('설정을 적용했어요. 연산 참여를 눌러 시작해 주세요.');
  }
  function changeOutput(next: VideoOutputSettings) {
    outputRef.current = next; setOutput(next);
    resourceRevocations.current += 1; setResourceApplying(true);
    void actionsRef.current.consent(false).finally(() => {
      resourceRevocations.current -= 1;
      if (resourceRevocations.current === 0) setResourceApplying(false);
    });
    setResourceNotice('출력 설정을 적용했어요. 연산 참여를 눌러 시작해 주세요.');
  }
  function start() {
    const result = videoProcessingSettingsSchema.safeParse(settings);
    const outputResult = videoOutputSettingsSchema.safeParse(output);
    if (!result.success) { setError('보정 값을 표시된 범위 안에서 선택해 주세요.'); return; }
    if (!outputResult.success) { setError('출력 설정을 확인해 주세요.'); return; }
    void perform(() => actionsRef.current.start(result.data, outputResult.data));
  }
  const host = room?.role === 'host';
  const busy = job?.status === 'rendering' || job?.status === 'encoding';
  const preparing = source?.status === 'preparing';
  const editable = host && !busy && !actionPending && !uploading && !preparing;
  const selectedOutput = source?.status === 'ready' ? resolveVideoOutput(source, output) : null;
  const dimensions = busy && job ? job : selectedOutput ?? { width: 1920, height: 1080 };
  const resourcePlan = planVideoResources(dimensions, limits, device);
  const frames = job?.totalFrames ?? (selectedOutput && source ? Math.min(VIDEO_LIMITS.maxFrames, Math.ceil(source.durationSeconds * selectedOutput.fps)) : source?.frames) ?? 0;
  const completed = job?.completedFrames ?? 0;
  const frameCountExact = job?.frameCountExact ?? false;
  const percent = job?.status === 'completed' ? 100 : frames ? Math.min(frameCountExact ? 100 : 99, completed / frames * 100) : 0;
  const connectedParticipants = room?.participants.filter((participant) => participant.connected) ?? [];
  const completedSet = new Set(job?.frames ?? []);
  const isFrameComplete = (index: number) => index < (job?.windowStart ?? 0) || completedSet.has(index);
  const assignedSet = new Set(room?.participants.filter((participant) => participant.activeFrame !== null).map((participant) => participant.activeFrame) ?? []);
  const elapsed = job ? job.wallMs ?? Math.max(0, (job.finishedAt ?? clock) - job.startedAt) : null;
  const state = job?.status ?? 'idle';
  const phaseLabel = busy && job ? phaseNames[job.phase] : statusNames[state];
  const timelineEnd = Math.min(frames, Math.max(120, job?.windowEnd ?? 0, completed));
  const timelineStart = Math.max(0, timelineEnd - 120);
  const self = room?.participants.find((participant) => participant.id === room.selfId);
  const filterFields: { key: keyof VideoProcessingSettings; label: string; min: number; max: number }[] = [
    { key: 'denoise', label: '노이즈 제거', min: 0, max: 100 },
    { key: 'sharpen', label: '선명도', min: 0, max: 100 },
    { key: 'brightness', label: '밝기', min: -50, max: 50 },
    { key: 'contrast', label: '대비', min: 50, max: 150 },
    { key: 'saturation', label: '채도', min: 0, max: 200 },
  ];

  return <div className="an-app vd-app"><header className="an-header"><Brand /><span className={`an-connection ${connection}`} data-testid="connection-status">{connection === 'online' ? '연결됨' : connection === 'error' ? '연결 확인 중' : '연결 중'}</span></header>
    <main className="an-studio"><div className="an-page-heading"><div><span className="an-room-label">영상 작업실<span className="an-role">{host ? '호스트' : '참여자'}</span></span><h1>영상은 선명하게, 작업은 함께.</h1></div><button className="an-button neutral small" onClick={() => void copyInvite()} aria-label="초대 링크 복사"><Icon type="copy" />{copied ? '복사했어요' : '초대 링크 복사'}</button></div>
      <input ref={inviteRef} className={showInvite ? 'an-input an-invite-fallback' : 'an-sr-only'} aria-label="초대 링크" data-testid="invite-link" value={inviteLink} readOnly tabIndex={showInvite ? 0 : -1} />
      {error && <div className="an-notice error" role="alert">{error}</div>}
      <div className="an-studio-grid"><div className="an-main-column">
        {host && <section className="an-card an-card-pad vd-source-card"><div className="an-section-head"><h2>원본 영상</h2><span className="an-state" data-testid="video-source-status" data-status={source?.status ?? 'empty'}>{uploading ? `${uploadProgress}% 업로드` : preparing ? '영상 확인 중' : source?.status === 'ready' ? '준비 완료' : source?.status === 'failed' ? '준비 실패' : '업로드 대기'}</span></div>
          <input ref={fileRef} type="file" className="an-sr-only" accept={VIDEO_INPUT_EXTENSIONS.map((extension) => `.${extension}`).join(',')} aria-label="영상 업로드" data-testid="video-upload" disabled={!editable || connection !== 'online'} onChange={(event) => { selectFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
          <button className={`vd-upload ${source?.status === 'ready' ? 'ready' : ''}`} onClick={() => fileRef.current?.click()} disabled={!editable || connection !== 'online'} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (editable) selectFile(event.dataTransfer.files[0]); }}><span className="vd-upload-icon"><Icon type="film" /></span><span><strong>{source?.status === 'ready' ? sourceName || '업로드한 영상' : uploading ? '영상을 업로드하고 있어요' : preparing ? '영상을 확인하고 있어요' : '영상을 선택하거나 여기로 끌어오세요'}</strong><small data-testid="video-source-info">{source?.status === 'ready' ? `${source.width} × ${source.height} · ${frameRate(source.originalFps ?? source.fps)} · ${source.durationSeconds.toFixed(1)}초 · ${source.hasAudio ? '원본 오디오 유지' : '오디오 없음'}` : 'MP4 · MOV · WebM · MKV · AVI 등 / 최대 256 MiB · 2분'}</small></span><span className="vd-upload-action">{source?.status === 'ready' ? '변경' : '선택'}</span></button>
          {uploading && <progress className="vd-upload-progress" aria-label="영상 업로드 진행률" value={uploadProgress} max={100} />}
          {(uploading || preparing) && <button className="an-button small neutral" disabled={actionPending} onClick={() => void perform(() => actionsRef.current.cancelUpload())}>업로드 취소</button>}
          {source?.failureReason && <div className="an-notice error" role="alert">{source.failureReason}</div>}
          <p className="an-subtle-note">초대한 기기로 영상 프레임을 나눠 보내요. 가로·세로 영상 모두 최대 1080p로 저장해요.</p>
        </section>}
        <section className="an-card"><div className="an-section-head"><div className="vd-preview-tabs" role="group" aria-label="영상 미리보기 선택">{host && <button aria-pressed={view === 'original'} onClick={() => setView('original')}>원본</button>}<button aria-pressed={view === 'processed' || !host} onClick={() => setView('processed')}>처리 결과</button></div><span className={`an-state ${state}`} data-testid="video-status" data-status={state} data-phase={job?.phase} role="status">{phaseLabel}</span></div>
          <div className="an-preview" data-testid="video-preview">{view === 'original' && host ? sourceUrl ? <video data-testid="source-video" src={sourceUrl} controls playsInline preload="metadata" aria-label="업로드한 원본 영상" onError={() => { setSourceUrl(''); }} /> : sourcePreviewUrl ? <img src={sourcePreviewUrl} alt="업로드한 원본 영상의 첫 프레임" /> : <div className="an-empty"><span className="an-empty-symbol"><Icon type="film" /></span><p>처리할 영상을 올려 주세요.</p></div> : videoUrl ? <video data-testid="final-video" src={videoUrl} controls playsInline preload="auto" aria-label="처리가 완료된 영상" /> : previewUrl ? <><img src={previewUrl} alt={`${(currentPreview ?? 0) + 1}번째 처리 프레임`} /><span className="an-frame-label">FRAME {String((currentPreview ?? 0) + 1).padStart(3, '0')}</span></> : <div className="an-empty"><span className="an-empty-symbol"><Icon type="film" /></span><p>{state === 'rendering' ? '프레임을 처리하고 있어요.' : '처리된 영상이 여기에 나타나요.'}</p></div>}</div>
          <div className="an-progress-section"><div className="an-progress-heading"><strong>{Math.floor(percent)}<span>%</span></strong><span>{completed.toLocaleString()} / {!frameCountExact && frames > 0 ? '약 ' : ''}{frames.toLocaleString()} 프레임</span></div><div className="an-progress-track" role="progressbar" aria-label="완료 프레임" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={Math.max(1, frames, completed)} data-testid="frame-progress" data-completed={completed}><div className="an-progress-fill" style={{ width: `${percent}%` }} /></div>
            <dl className="an-render-stats"><div><dt>연결된 기기</dt><dd>{connectedParticipants.length}대</dd></div><div><dt>처리 시간</dt><dd>{seconds(elapsed)}</dd></div><div><dt>GPU 처리 프레임</dt><dd data-testid="gpu-total-frames">{room?.participants.reduce((count, participant) => count + participant.gpuFrames, 0) ?? 0}개</dd></div></dl></div>
          {job?.failureReason && <div className="an-job-error"><div className="an-notice error" role="alert">{job.failureReason}</div></div>}
          {videoError && <div className="an-job-error"><div className="an-notice error" role="alert">{videoError} <button className="an-button small neutral" onClick={() => setVideoRetry((value) => value + 1)}>다시 가져오기</button></div></div>}
          {state === 'completed' && <div className="an-result-actions">{videoUrl ? <a className="an-button secondary" href={videoUrl} download={`tabcloud-${roomId}.mp4`} role="button"><Icon type="download" />영상 다운로드</a> : <button className="an-button secondary" disabled>영상 다운로드</button>}</div>}
        </section>
        {frames > 0 && <section className="an-card"><div className="an-section-head"><h2>프레임 타임라인</h2><span className="an-timeline-count">{timelineStart + 1}–{timelineEnd} / {frames.toLocaleString()}</span></div><div className="an-frame-grid" data-testid="frame-grid">{Array.from({ length: Math.max(0, timelineEnd - timelineStart) }, (_, offset) => { const index = timelineStart + offset; return <button key={index} className={`an-frame ${isFrameComplete(index) ? 'completed' : assignedSet.has(index) ? 'assigned' : ''} ${selectedFrame === index ? 'selected' : ''}`} disabled={!isFrameComplete(index) || Boolean(videoUrl)} aria-label={`프레임 ${index + 1}: ${isFrameComplete(index) ? '완료' : assignedSet.has(index) ? '계산 중' : '대기'}`} onClick={() => { setSelectedFrame(index); setView('processed'); }} />; })}</div></section>}
      </div><aside className="an-sidebar">
        <section className="an-card an-card-pad"><h2>출력 설정</h2><div className="vd-output-fields">
          <label><span>해상도</span><select className="an-input" aria-label="출력 해상도" value={output.resolution} disabled={!editable} onChange={(event) => changeOutput({ ...output, resolution: event.target.value as VideoOutputSettings['resolution'] })}><option value="1080p">1080p · Full HD</option><option value="720p">720p · HD</option></select></label>
          <label><span>프레임률</span><select className="an-input" aria-label="프레임률" value={output.fps} disabled={!editable} onChange={(event) => changeOutput({ ...output, fps: event.target.value === 'source' ? 'source' : Number(event.target.value) as 24 | 30 | 60 })}><option value="source">원본 유지 · 최대 60fps</option><option value="24">24fps</option><option value="30">30fps</option><option value="60">60fps</option></select></label>
          <label><span>화질</span><select className="an-input" aria-label="출력 화질" value={output.quality} disabled={!editable} onChange={(event) => changeOutput({ ...output, quality: event.target.value as VideoOutputSettings['quality'] })}><option value="high">높은 화질</option><option value="balanced">균형</option><option value="compact">작은 파일</option></select></label>
        </div>{selectedOutput && <p className="vd-output-summary" data-testid="video-output-summary">{selectedOutput.width} × {selectedOutput.height} · {frameRate(selectedOutput.fps)}<span>MP4 · 원본보다 확대하지 않아요</span></p>}
          <p className="an-subtle-note">높은 해상도와 프레임률은 처리 시간·전송량이 늘어나요.</p>
        </section>
        <section className="an-card an-card-pad"><h2>영상 보정</h2><div className="vd-filter-fields">{filterFields.map((field) => <label key={field.key}><span>{field.label}<output>{settings[field.key]}</output></span><input type="range" aria-label={field.label} min={field.min} max={field.max} step={1} value={settings[field.key]} disabled={!editable} onChange={(event) => setSettings((previous) => ({ ...previous, [field.key]: Number(event.target.value) }))} /></label>)}</div>
          <details className="an-settings-details"><summary>고급 설정</summary><label className="vd-radius">노이즈 제거 반경<input className="an-input" type="number" min={1} max={4} step={1} value={settings.denoiseRadius} disabled={!editable} onChange={(event) => setSettings((previous) => ({ ...previous, denoiseRadius: Number(event.target.value) }))} /></label><button className="an-button small neutral" disabled={!editable} onClick={() => setSettings({ ...DEFAULT_VIDEO_PROCESSING })}>기본값으로</button></details>
          <div className="an-start-action">{host ? busy ? <button className="an-button danger full" onClick={() => void perform(() => actionsRef.current.cancel())} disabled={actionPending || connection !== 'online'}><Icon type="stop" />작업 취소</button> : <button className="an-button primary full" onClick={start} disabled={!editable || source?.status !== 'ready' || connection !== 'online'}><Icon type="play" />처리 시작</button> : <p className="an-subtle-note">호스트가 영상 작업을 시작해요.</p>}</div>
        </section>
        <section className="an-card an-card-pad"><div className="an-consent-head"><h2>내 기기 참여</h2><span className={`an-worker-dot ${consented ? 'active' : ''}`} /></div>
          <div className={`vd-gpu-status ${device.gpuAvailable ? 'available' : ''}`} data-testid="video-gpu-status"><span>{resourceStats?.gpuHardware && activeFrame !== null && consented && limits.gpuPercent > 0 ? 'GPU 처리 중' : device.gpuAvailable ? limits.gpuPercent > 0 ? 'GPU 준비됨' : 'GPU 꺼짐' : gpuChecking ? 'GPU 확인 중' : 'GPU 사용 불가'}</span><strong>{resourceStats?.adapterName || gpuName}</strong>{!device.gpuAvailable && !gpuChecking && <small>Chrome·Edge의 하드웨어 가속을 켜고 HTTPS로 접속해 주세요.</small>}<small>{self?.gpuFrames ?? 0}프레임 처리 · {resourceStats?.gpuDispatches ?? 0}회 실행</small>{resourceStats?.gpuTimestampMs != null && <small>GPU 실측 {(resourceStats.gpuTimestampMs / 1000).toFixed(3)}초</small>}</div>
          <ResourceControls limits={limits} onChange={changeResourceLimits} device={device} plan={resourcePlan} stats={resourceStats} detailNote="RAM은 영상 버퍼 예산이며 최대 512 MiB예요. 브라우저·드라이버 전체 메모리는 포함하지 않아요. CPU 0%는 CPU 필터 Worker를 꺼요. 파일 전송과 GPU 제어는 CPU를 사용해요." />
          {resourceStats?.warning && <p className="an-subtle-note" role="status">{resourceStats.warning}</p>}{resourceNotice && <p className="an-subtle-note" role="status">{resourceNotice}</p>}
          {consented && <p className="an-active-work" data-testid="worker-state">{activeFrame === null ? '다음 프레임을 기다리고 있어요.' : `${activeFrame + 1}번 프레임 처리 중 · ${Math.floor(activeRows / (job?.height ?? 1) * 100)}%`}</p>}
          <p className="an-subtle-note vd-consent-note">참여하면 선택한 한도로 연산해요. 발열·배터리 소모가 생길 수 있어요.</p><button className={`an-button full ${consented ? 'neutral' : 'secondary'}`} onClick={() => void perform(() => actionsRef.current.consent(!consented))} disabled={actionPending || resourceApplying || uploading || preparing || connection !== 'online' || (!consented && (!resourcePlan.canRender || Boolean(job && job.status !== 'rendering')))}><Icon type={consented ? 'stop' : 'play'} />{consented ? '연산 중단' : '연산 참여'}</button>
        </section>
        <section className="an-card an-card-pad"><div className="an-participant-heading"><h2>함께하는 기기</h2><span>{connectedParticipants.length}</span></div><ul className="an-participants">{room?.participants.map((participant, index) => <li key={participant.id} className={`an-participant ${participant.connected ? '' : 'offline'}`} data-testid="participant" data-self={participant.id === room.selfId ? 'true' : 'false'} data-completed={participant.completedFrames} data-connected={participant.connected ? 'true' : 'false'}><span className="an-avatar">{String(index + 1).padStart(2, '0')}</span><div className="an-participant-name"><strong>{participant.name}{participant.id === room.selfId && <i>내 기기</i>}</strong><small>{!participant.connected ? '연결 끊김' : participant.activeFrame !== null ? '프레임 처리 중' : participant.consented ? '연산 대기 중' : '구경 중'} · GPU {participant.gpuFrames}</small></div><span className="an-participant-contribution"><b>{participant.completedFrames}</b> 프레임</span></li>)}</ul></section>
        <details className="an-info-details"><summary>작업 정보</summary><p>참여한 기기가 프레임을 받아 GPU·CPU로 보정해요. 완료한 기기가 다음 프레임을 가져가요. 서버는 영상 분리와 MP4 인코딩을 담당해요.</p>{job && <p>프레임 처리 {seconds(job.renderMs)} · 인코딩 {seconds(job.encodeMs)}<br />처리 데이터 {(job.resultBytes / 1024 / 1024).toFixed(1)} MB · 재배정 {job.retries}회</p>}<p>여러 탭의 자원 한도는 합산돼요. 방과 영상은 만료되거나 서버가 재시작되면 삭제돼요.</p></details>
      </aside></div>
    </main></div>;
}

export default function VideoApp() {
  const match = location.pathname.match(/^\/video\/([a-zA-Z0-9_-]+)\/?$/);
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (match && !invite) return <div className="an-app"><header className="an-header"><Brand /></header><main className="an-card an-invalid"><h1>초대 링크를 확인해 주세요</h1><p>초대받은 전체 링크로 참여해 주세요.</p><a className="an-button primary" href="/">홈으로 돌아가기</a></main></div>;
  return match && invite ? <Studio roomId={match[1]} inviteToken={invite} /> : <Home />;
}
