import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ANIMATION_LIMITS, ANIMATION_PRESETS, DEFAULT_ANIMATION_SETTINGS, animationSettingsSchema, type AnimationAssignment, type AnimationJoinResult, type AnimationRoomCreated, type AnimationSettings, type AnimationSnapshot, type AnimationTaskResult } from '@tabcloud/shared';
import type { AnimationWorkerResponse } from './animation.worker';
import { ApiConfigurationError, apiUrl } from './api-origin';

type Connection = 'connecting' | 'online' | 'error';
type RoomActions = { consent: (enabled: boolean) => Promise<void>; start: (settings: AnimationSettings) => Promise<void>; cancel: () => Promise<void> };
const noActions: RoomActions = { consent: async () => {}, start: async () => {}, cancel: async () => {} };
const statusNames = { rendering: '렌더링 중', encoding: '영상으로 묶는 중', completed: '영상 완성', cancelled: '작업 취소됨', failed: '작업 실패', idle: '준비됨' };
const seconds = (ms: number | null | undefined) => ms == null ? '—' : ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.floor(ms / 1000) % 60}초` : `${(ms / 1000).toFixed(1)}초`;
const sameSettings = (a: AnimationSettings, b: AnimationSettings) => Object.keys(DEFAULT_ANIMATION_SETTINGS).every((key) => a[key as keyof AnimationSettings] === b[key as keyof AnimationSettings]);
const participantKey = (roomId: string) => `tabcloud:animation:participant:${roomId}`;
const hostKey = (roomId: string) => `tabcloud:animation:host:${roomId}`;
class RequestError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message); } }

function Icon({ type }: { type: 'arrow' | 'copy' | 'play' | 'stop' | 'download' | 'film' }) {
  const paths = { arrow: 'M4 12h16m-6-6 6 6-6 6', copy: 'M8 8h12v12H8zM16 8V4H4v12h4', play: 'm8 5 11 7-11 7Z', stop: 'M6 6h12v12H6Z', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', film: 'M3 5h18v14H3zM7 5v14M17 5v14M3 10h4m-4 4h4m10-4h4m-4 4h4' };
  return <svg className="an-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[type]} /></svg>;
}
function Brand() { return <a className="an-brand" href="/" aria-label="TabCloud 홈"><span className="an-logo" aria-hidden="true"><i /><i /><i /><i /></span>TabCloud</a>; }
function SceneArt() { return <div className="an-art" aria-hidden="true"><div className="an-orb" /><div className="an-orb two" /><div className="an-orb three" /><span className="an-art-tag first"><i />Browser 01</span><span className="an-art-tag second"><i />Browser 02</span></div>; }
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
  async function createRoom() {
    setCreating(true); setError('');
    try {
      const room = await readResponse<AnimationRoomCreated>(await fetch(apiUrl('/api/animation/rooms'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }));
      sessionStorage.setItem(hostKey(room.roomId), room.hostToken);
      location.assign(`/studio/${encodeURIComponent(room.roomId)}#invite=${encodeURIComponent(room.inviteToken)}`);
    } catch (err) { setError(err instanceof Error ? err.message : '방을 만들지 못했어요.'); setCreating(false); }
  }
  function join(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const url = new URL(invite.trim(), location.origin);
      if (!/^\/(studio|room)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || !new URLSearchParams(url.hash.slice(1)).get('invite')) throw new Error();
      location.assign(`${url.pathname}${url.hash}`);
    } catch { setError('초대받은 링크 전체를 입력해 주세요.'); }
  }
  return <div className="an-app"><header className="an-header"><Brand /><a className="an-header-link" href="/fractal">프랙털 실험실 ↗</a></header>
    <main className="an-home"><div className="an-home-top"><div><span className="an-eyebrow">Edge rendering studio</span><h1>여러 기기의 힘으로<br /><span>하나의 영상을.</span></h1><p className="an-home-description">브라우저마다 프레임을 나눠 계산하고,<br />함께 3D 애니메이션을 완성해요.</p></div><SceneArt /></div>
      <div className="an-home-actions"><section className="an-home-card an-home-create"><h2>함께 렌더링하기</h2><p>방을 만들고 다른 기기를 초대해 보세요.</p><button className="an-button primary" onClick={() => void createRoom()} disabled={creating}>{creating ? '방 만드는 중…' : '방 만들기'}<Icon type="arrow" /></button></section>
        <form className="an-home-card" onSubmit={join}><h2>초대받았나요?</h2><p>초대 링크 하나로 바로 연결돼요.</p><div className="an-join-controls"><label className="an-sr-only" htmlFor="animation-join">초대 링크</label><input id="animation-join" className="an-input" placeholder="초대 링크 붙여넣기" value={invite} onChange={(event) => setInvite(event.target.value)} required /><button className="an-button secondary" type="submit">참여하기<Icon type="arrow" /></button></div></form></div>
      {error && <div className="an-notice error" role="alert">{error}</div>}<p className="an-home-footnote">설치 없이 · 로그인 없이 · 동의한 연산만</p>
    </main></div>;
}

function Studio({ roomId, inviteToken }: { roomId: string; inviteToken: string }) {
  const [room, setRoom] = useState<AnimationSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [consented, setConsented] = useState(false);
  const [activeFrame, setActiveFrame] = useState<number | null>(null);
  const [activeRows, setActiveRows] = useState(0);
  const [settings, setSettings] = useState<AnimationSettings>({ ...DEFAULT_ANIMATION_SETTINGS });
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
  const roomRef = useRef<AnimationSnapshot | null>(null);
  const tokenRef = useRef('');
  const actionsRef = useRef<RoomActions>(noActions);
  const inviteRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef('');
  const videoUrlRef = useRef('');
  const inviteLink = `${location.origin}/studio/${roomId}#invite=${encodeURIComponent(inviteToken)}`;
  const endpoint = `/api/animation/rooms/${encodeURIComponent(roomId)}`;

  useEffect(() => {
    let disposed = false;
    let token = sessionStorage.getItem(participantKey(roomId)) || '';
    let worker: Worker | null = null;
    let lease: AnimationAssignment | null = null;
    let consent = false;
    let requesting = false;
    let polling = false;
    let generation = 0;
    let uploadAbort: AbortController | null = null;
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
      if (!disposed) { setActiveFrame(null); setActiveRows(0); }
      if (resetConsent) { consent = false; if (!disposed) setConsented(false); }
    }
    function apply(snapshot: AnimationSnapshot) {
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
      if (snapshot.role !== 'host' && snapshot.job) setSettings(snapshot.job.settings);
      if (previousJob !== snapshot.job?.id) setSelectedFrame(null);
    }
    function disconnected(err: unknown) {
      if (disposed) return;
      destroyWorker(); setConnection('error');
      needsConsentReset = Boolean(token);
      setError(err instanceof RequestError || err instanceof ApiConfigurationError ? err.message : '연결이 끊겼어요. 다시 연결되면 연산 참여를 눌러 주세요.');
      if (err instanceof ApiConfigurationError) fatal = true;
      if (err instanceof RequestError && [401, 403].includes(err.status)) { if (!token) fatal = true; token = ''; tokenRef.current = ''; sessionStorage.removeItem(participantKey(roomId)); }
      if (err instanceof RequestError && err.status === 404) fatal = true;
    }
    async function requestTask() {
      if (disposed || pageHidden || !consent || !worker || lease || requesting || roomRef.current?.job?.status !== 'rendering') return;
      requesting = true;
      const current = generation;
      try {
        const result = await api<AnimationTaskResult>('/task', {});
        if (disposed || !consent || current !== generation || !worker) return;
        if (result.assignment) {
          if (result.assignment.task.jobId !== roomRef.current?.job?.id || roomRef.current.job.status !== 'rendering') return;
          lease = result.assignment; lastProgressAt = 0;
          setActiveFrame(lease.task.frameIndex); setActiveRows(0);
          worker.postMessage({ task: lease.task, token: lease.attemptId });
        }
      } catch (err) {
        if (current !== generation || disposed) return;
        if (err instanceof RequestError && err.code === 'CONSENT_REQUIRED') {
          destroyWorker();
          try { apply(await api<AnimationSnapshot>('/state')); } catch (refreshError) { disconnected(refreshError); }
        } else disconnected(err);
      }
      finally { if (current === generation) requesting = false; }
    }
    function createWorker() {
      const nextWorker = new Worker(new URL('./animation.worker.ts', import.meta.url), { type: 'module', name: 'TabCloud animation renderer' });
      worker = nextWorker;
      nextWorker.onmessage = async ({ data }: MessageEvent<AnimationWorkerResponse>) => {
        const assignment = lease;
        if (disposed || worker !== nextWorker || !consent || !assignment || data.token !== assignment.attemptId) return;
        const ids = { jobId: assignment.task.jobId, taskId: assignment.task.taskId, attemptId: assignment.attemptId };
        if (data.type === 'progress') {
          setActiveRows(data.rows);
          if (performance.now() - lastProgressAt >= 1000 || data.rows === assignment.task.settings.height) {
            lastProgressAt = performance.now();
            void api('/progress', { ...ids, rows: data.rows }).catch((err) => { if (lease === assignment && !(err instanceof RequestError && err.status === 409)) disconnected(err); });
          }
          return;
        }
        if (data.type === 'error') {
          void api('/task-error', { ...ids, message: data.message.slice(0, 200) }).catch(() => {});
          destroyWorker(); setError('이 기기의 연산이 중단됐어요. 다시 참여해 주세요.');
          void api('/consent', { enabled: false }).catch(() => {});
          return;
        }
        const current = generation;
        uploadAbort = new AbortController();
        try {
          const query = new URLSearchParams({ ...ids, computeMs: String(data.computeMs) });
          const signal = AbortSignal.any([uploadAbort.signal, AbortSignal.timeout(60_000)]);
          for (let retry = 0; ; retry += 1) {
            const response = await fetch(apiUrl(`${endpoint}/result?${query}`), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: data.pixels, signal });
            if (response.status !== 429 || retry >= 5) { await readResponse<{ accepted: true }>(response); break; }
            await response.body?.cancel();
            const delay = Math.min(1000, 250 * 2 ** retry) + Math.random() * 150;
            await new Promise<void>((resolve, reject) => {
              const interrupted = () => { clearTimeout(retryTimer); reject(new DOMException('Upload stopped', 'AbortError')); };
              const retryTimer = setTimeout(() => { signal.removeEventListener('abort', interrupted); resolve(); }, delay);
              if (signal.aborted) interrupted(); else signal.addEventListener('abort', interrupted, { once: true });
            });
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
        try { apply(await api<AnimationSnapshot>('/consent', { enabled: false })); } catch (err) { disconnected(err); }
        return;
      }
      if (typeof Worker === 'undefined') { setError('Web Worker를 지원하는 최신 브라우저에서 참여해 주세요.'); return; }
      try {
        destroyWorker();
        const current = generation;
        const snapshot = await api<AnimationSnapshot>('/consent', { enabled: true });
        if (disposed || pageHidden || current !== generation) { void api('/consent', { enabled: false }).catch(() => {}); return; }
        apply(snapshot);
        if (roomRef.current?.job && roomRef.current.job.status !== 'rendering') { void api('/consent', { enabled: false }).catch(() => {}); return; }
        createWorker(); consent = true; setConsented(true); void requestTask();
      } catch (err) { destroyWorker(); void api('/consent', { enabled: false }).catch(() => {}); disconnected(err); }
    }
    actionsRef.current = {
      consent: changeConsent,
      start: async (newSettings) => { setError(''); try { apply(await api<AnimationSnapshot>('/start', { settings: newSettings })); void requestTask(); } catch (err) { setError(err instanceof Error ? err.message : '작업을 시작하지 못했어요.'); } },
      cancel: async () => { destroyWorker(); setError(''); try { apply(await api<AnimationSnapshot>('/cancel', {})); } catch (err) { setError(err instanceof Error ? err.message : '작업을 취소하지 못했어요.'); } },
    };
    async function join() {
      let name = sessionStorage.getItem('tabcloud:name');
      if (!name) { name = `브라우저 ${Math.random().toString(36).slice(2, 6).toUpperCase()}`; sessionStorage.setItem('tabcloud:name', name); }
      const result = await readResponse<AnimationJoinResult>(await fetch(apiUrl(`${endpoint}/join`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteToken, hostToken: sessionStorage.getItem(hostKey(roomId)) || undefined, name }), signal: AbortSignal.timeout(10_000) }));
      if (disposed) { void fetch(apiUrl(`${endpoint}/leave`), { method: 'POST', headers: { Authorization: `Bearer ${result.participantToken}`, 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {}); return; }
      token = result.participantToken; tokenRef.current = token; sessionStorage.setItem(participantKey(roomId), token);
      apply(result.snapshot);
    }
    async function tick() {
      if (disposed || pageHidden || polling || fatal) return;
      polling = true;
      try {
        if (!token) { await join(); needsConsentReset = false; }
        else if (needsConsentReset) { apply(await api<AnimationSnapshot>('/consent', { enabled: false })); needsConsentReset = false; }
        else apply(await api<AnimationSnapshot>('/state'));
        if (!disposed) void requestTask();
      } catch (err) { disconnected(err); }
      finally { polling = false; if (!disposed && !fatal) timer = setTimeout(() => void tick(), 900); }
    }
    async function initialize() {
      await tick();
    }
    function leave() {
      pageHidden = true;
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
  const currentPreview = selectedFrame !== null && job?.frames.includes(selectedFrame) ? selectedFrame : job?.frames.at(-1);
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
  useEffect(() => () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current); }, []);

  async function copyInvite() {
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setShowInvite(true); requestAnimationFrame(() => { inviteRef.current?.focus(); inviteRef.current?.select(); }); }
  }
  async function perform(action: () => Promise<void>) { setActionPending(true); try { await action(); } finally { setActionPending(false); } }
  function start() {
    const result = animationSettingsSchema.safeParse(settings);
    if (!result.success) { setError('해상도는 범위 안의 짝수, 나머지 설정은 표시된 범위 안의 정수로 입력해 주세요.'); return; }
    void perform(() => actionsRef.current.start(result.data));
  }
  const host = room?.role === 'host';
  const busy = job?.status === 'rendering' || job?.status === 'encoding';
  const editable = host && !busy && !actionPending;
  const displaySettings = job && busy ? job.settings : settings;
  const resultSettings = job?.settings ?? settings;
  const frames = job?.totalFrames ?? settings.frames;
  const completed = job?.completedFrames ?? 0;
  const percent = frames ? completed / frames * 100 : 0;
  const connectedParticipants = room?.participants.filter((participant) => participant.connected) ?? [];
  const completedSet = new Set(job?.frames ?? []);
  const assignedSet = new Set(room?.participants.filter((participant) => participant.activeFrame !== null).map((participant) => participant.activeFrame) ?? []);
  const elapsed = job ? job.wallMs ?? Math.max(0, (job.finishedAt ?? clock) - job.startedAt) : null;
  const state = job?.status ?? 'idle';
  const settingsFields: { key: Exclude<keyof AnimationSettings, 'fps'>; label: string; min: number; max: number; step?: number }[] = [{ key: 'width', label: '너비', min: 64, max: ANIMATION_LIMITS.maxWidth, step: 2 }, { key: 'height', label: '높이', min: 64, max: ANIMATION_LIMITS.maxHeight, step: 2 }, { key: 'frames', label: '프레임 수', min: 1, max: ANIMATION_LIMITS.maxFrames }, { key: 'samples', label: '샘플 수', min: 1, max: ANIMATION_LIMITS.maxSamples }, { key: 'bounces', label: '반사 횟수', min: 1, max: ANIMATION_LIMITS.maxBounces }];

  return <div className="an-app"><header className="an-header"><Brand /><span className={`an-connection ${connection}`} data-testid="connection-status">{connection === 'online' ? '연결됨' : connection === 'error' ? '연결 확인 중' : '연결 중'}</span></header>
    <main className="an-studio"><div className="an-page-heading"><div><span className="an-room-label">우리의 렌더 스튜디오<span className="an-role">{host ? '호스트' : '참여자'}</span></span><h1>함께 만드는 3D 영상</h1></div><button className="an-button neutral small" onClick={() => void copyInvite()} aria-label="초대 링크 복사"><Icon type="copy" />{copied ? '복사했어요' : '초대 링크 복사'}</button></div>
      <input ref={inviteRef} className={showInvite ? 'an-input an-invite-fallback' : 'an-sr-only'} aria-label="초대 링크" data-testid="invite-link" value={inviteLink} readOnly tabIndex={showInvite ? 0 : -1} />
      {error && <div className="an-notice error" role="alert">{error}</div>}
      <div className="an-studio-grid"><div className="an-main-column"><section className="an-card"><div className="an-section-head"><h2>렌더 미리보기</h2><span className={`an-state ${state}`} data-testid="animation-status" data-status={state} role="status">{statusNames[state]}</span></div>
          <div className="an-preview" data-testid="animation-preview">{videoUrl ? <video data-testid="final-video" src={videoUrl} controls playsInline preload="auto" aria-label="완성된 3D 애니메이션" /> : previewUrl ? <><img src={previewUrl} alt={`${(currentPreview ?? 0) + 1}번째 완성 프레임`} /><span className="an-frame-label">FRAME {String((currentPreview ?? 0) + 1).padStart(3, '0')}</span></> : <div className="an-empty"><span className="an-empty-symbol"><Icon type="film" /></span><p>{state === 'rendering' ? <>첫 프레임을 계산하고 있어요.<br />완성되면 이곳에 나타나요.</> : <>프레임이 모이면<br />하나의 영상이 돼요.</>}</p></div>}</div>
          <div className="an-progress-section"><div className="an-progress-heading"><strong>{Math.floor(percent)}<span style={{ fontSize: 16, color: '#333d4b', marginLeft: 3 }}>%</span></strong><span>{completed.toLocaleString()} / {frames.toLocaleString()} 프레임</span></div><div className="an-progress-track" role="progressbar" aria-label="완료 프레임" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={frames} data-testid="frame-progress" data-completed={completed}><div className="an-progress-fill" style={{ width: `${percent}%` }} /></div>
            <dl className="an-render-stats"><div><dt>연결된 기기</dt><dd>{connectedParticipants.length}대</dd></div><div><dt>{state === 'completed' ? '전체 완료 시간' : '진행 시간'}</dt><dd>{seconds(elapsed)}</dd></div><div><dt>영상 길이</dt><dd>{(resultSettings.frames / resultSettings.fps).toFixed(1)}초 <span style={{ color: '#b0b8c1', fontSize: 10 }}>24fps</span></dd></div></dl></div>
          {job?.failureReason && <div className="an-job-error"><div className="an-notice error" role="alert">{job.failureReason}</div></div>}
          {videoError && <div className="an-job-error"><div className="an-notice error" role="alert">{videoError} <button className="an-button small neutral" onClick={() => setVideoRetry((value) => value + 1)}>다시 가져오기</button></div></div>}
          {state === 'completed' && <div className="an-result-actions">{videoUrl ? <a className="an-button secondary" href={videoUrl} download={`tabcloud-${roomId}.mp4`} role="button"><Icon type="download" />영상 다운로드</a> : <button className="an-button secondary" disabled>영상 다운로드</button>}</div>}
        </section>
        <section className="an-card"><div className="an-section-head"><h2>프레임 타임라인</h2><span className="an-timeline-count">{frames} FRAMES</span></div><div className="an-frame-grid" data-testid="frame-grid">{Array.from({ length: Number.isFinite(frames) ? Math.max(0, Math.min(frames, ANIMATION_LIMITS.maxFrames)) : 0 }, (_, index) => <button key={index} className={`an-frame ${completedSet.has(index) ? 'completed' : assignedSet.has(index) ? 'assigned' : ''} ${selectedFrame === index ? 'selected' : ''}`} disabled={!completedSet.has(index) || Boolean(videoUrl)} aria-label={`프레임 ${index + 1}: ${completedSet.has(index) ? '완료' : assignedSet.has(index) ? '계산 중' : '대기'}`} title={`프레임 ${index + 1}`} onClick={() => setSelectedFrame(index)} />)}</div><div className="an-timeline-legend"><span><i />대기</span><span><i className="assigned" />계산 중</span><span><i className="completed" />완료</span></div></section>
      </div><aside className="an-sidebar"><section className="an-card an-card-pad"><h2>영상 설정</h2><div className="an-presets">{ANIMATION_PRESETS.map((preset) => <button key={preset.id} className="an-preset" data-testid={`animation-preset-${preset.id}`} aria-pressed={sameSettings(settings, preset.settings)} disabled={!editable} onClick={() => setSettings({ ...preset.settings })}>{preset.name}</button>)}</div><p className="an-setting-label">{displaySettings.width.toLocaleString()} × {displaySettings.height.toLocaleString()} · {displaySettings.frames} 프레임 · {displaySettings.samples} 샘플</p>
          <details className="an-settings-details"><summary>직접 설정</summary><div className="an-settings-fields">{settingsFields.map((field) => <label key={field.key}>{field.label}<input className="an-input" type="number" min={field.min} max={field.max} step={field.step ?? 1} value={Number.isFinite(settings[field.key]) ? settings[field.key] : ''} disabled={!editable} onChange={(event) => setSettings((previous) => ({ ...previous, [field.key]: event.target.value === '' ? Number.NaN : Number(event.target.value) }))} /></label>)}<label>초당 프레임<input className="an-input" type="number" value={24} disabled /></label></div><p className="an-subtle-note">샘플 수가 높을수록 빛과 반사를 더 많이 계산해요.</p></details>
          <div className="an-start-action">{host ? busy ? <button className="an-button danger full" onClick={() => void perform(() => actionsRef.current.cancel())} disabled={actionPending || connection !== 'online'}><Icon type="stop" />작업 취소</button> : <button className="an-button primary full" onClick={start} disabled={actionPending || connection !== 'online'}><Icon type="play" />렌더 시작</button> : <p className="an-subtle-note">호스트가 렌더링을 시작할 수 있어요.</p>}</div>
        </section>
        <section className="an-card an-card-pad"><div className="an-consent-head"><h2>내 기기 참여</h2><span className={`an-worker-dot ${consented ? 'active' : ''}`} /></div><p className="an-consent-copy">참여하면 이 기기의 CPU를 사용해요.<br />발열·배터리 소모가 생길 수 있으며, 언제든 중단할 수 있어요.</p>{consented && <p className="an-active-work" data-testid="worker-state">{activeFrame === null ? '다음 프레임을 기다리고 있어요.' : `${activeFrame + 1}번 프레임 계산 중 · ${Math.floor(activeRows / (job?.settings.height ?? 1) * 100)}%`}</p>}<button className={`an-button full ${consented ? 'neutral' : 'secondary'}`} onClick={() => void perform(() => actionsRef.current.consent(!consented))} disabled={actionPending || connection !== 'online' || (!consented && Boolean(job && job.status !== 'rendering'))}><Icon type={consented ? 'stop' : 'play'} />{consented ? '연산 중단' : '연산 참여'}</button></section>
        <section className="an-card an-card-pad"><div className="an-participant-heading"><h2>함께하는 기기</h2><span>{connectedParticipants.length}</span></div><ul className="an-participants">{room?.participants.map((participant, index) => <li key={participant.id} className={`an-participant ${participant.connected ? '' : 'offline'}`} data-testid="participant" data-self={participant.id === room.selfId ? 'true' : 'false'} data-completed={participant.completedFrames} data-connected={participant.connected ? 'true' : 'false'}><span className="an-avatar">{String(index + 1).padStart(2, '0')}</span><div className="an-participant-name"><strong>{participant.name}{participant.id === room.selfId && <i>내 기기</i>}</strong><small>{!participant.connected ? '연결 끊김' : participant.activeFrame !== null ? '프레임 계산 중' : participant.consented ? '연산 대기 중' : '구경 중'}</small></div><span className="an-participant-contribution"><b>{participant.completedFrames}</b> 프레임</span></li>)}</ul></section>
        <details className="an-info-details"><summary>작업 정보</summary><p>브라우저마다 Worker 1개가 3D 장면의 프레임을 계산해요. 완성된 프레임은 서버에서 MP4로 묶어요. 이 인코딩 시간도 전체 완료 시간에 포함돼요.</p>{job && <p>프레임 렌더 {seconds(job.renderMs)} · 영상 인코딩 {seconds(job.encodeMs)}<br />기기 누적 연산 {seconds(job.computeMs)} · 재배정 {job.retries}회<br />프레임 전송 {(job.resultBytes / 1024 / 1024).toFixed(1)}MB{job.videoBytes > 0 && ` · MP4 ${(job.videoBytes / 1024 / 1024).toFixed(1)}MB`}</p>}<p>같은 PC의 여러 탭은 CPU를 공유해요. 기기를 추가했을 때의 성능은 실제로 다른 기기에서 비교해 주세요. 숨겨진 탭은 느려질 수 있어요.</p><p>방은 {room ? new Date(room.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '일정 시간 후'}에 만료되며 서버 재시작 시 삭제돼요.</p></details>
      </aside></div>
    </main></div>;
}

export default function AnimationApp() {
  const match = location.pathname.match(/^\/studio\/([a-zA-Z0-9_-]+)\/?$/);
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (match && !invite) return <div className="an-app"><header className="an-header"><Brand /></header><main className="an-card an-invalid"><h1>초대 링크를 확인해 주세요</h1><p>방에 참여하려면 초대받은 전체 링크가 필요해요.</p><a className="an-button primary" href="/">홈으로 돌아가기</a></main></div>;
  return match && invite ? <Studio roomId={match[1]} inviteToken={invite} /> : <Home />;
}
