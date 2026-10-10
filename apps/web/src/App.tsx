import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { checksum, createTiles, mergeTile } from '@tabcloud/compute';
import { DEFAULT_SETTINGS, LIMITS, renderSettingsSchema, serverMessageSchema, type ClientMessage, type RenderSettings, type RoomSnapshot, type TileTask } from '@tabcloud/shared';
import type { WorkerResponse } from './worker.types';
import { DEFAULT_DEMO_SETTINGS, RENDER_PRESETS } from './render-presets';
import { apiUrl, websocketUrl } from './api-origin';

type Connection = 'connecting' | 'connected' | 'reconnecting' | 'error';
type Lease = { task: TileTask; attemptId: string; lastProgressAt: number };
type SoloResult = { checksum: string; wallMs: number; computeMs: number; settings: RenderSettings };
type SoloRun = { tasks: TileTask[]; index: number; pixels: Uint8ClampedArray; canvas: HTMLCanvasElement; started: number; computeMs: number; settings: RenderSettings };

const statusNames = { created: '준비됨', running: '렌더링 중', completed: '렌더 완료', cancelled: '작업 취소됨', failed: '작업 실패' };
const formatTime = (ms: number | null | undefined) => ms == null ? '—' : `${(ms / 1000).toFixed(1)}초`;
const sameSettings = (a: RenderSettings, b: RenderSettings) => Object.keys(DEFAULT_SETTINGS).every((key) => a[key as keyof RenderSettings] === b[key as keyof RenderSettings]);

function Logo() {
  return <a className="brand" href="/" aria-label="TabCloud 홈"><span className="brand-icon" aria-hidden="true"><i /><i /><i /><i /></span>TabCloud</a>;
}

function Icon({ type }: { type: 'arrow' | 'copy' | 'download' | 'play' | 'stop' }) {
  const paths = { arrow: 'M4 12h16m-6-6 6 6-6 6', copy: 'M8 8h12v12H8zM16 8V4H4v12h4', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', play: 'm8 5 11 7-11 7Z', stop: 'M6 6h12v12H6Z' };
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[type]} /></svg>;
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}

function Home() {
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  async function createRoom() {
    setCreating(true); setError('');
    try {
      const response = await fetch(apiUrl('/api/rooms'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(response.status === 429 ? '방 생성 요청이 많습니다. 잠시 후 다시 시도해 주세요.' : '서버에 연결할 수 없습니다. 서버 실행 상태를 확인해 주세요.');
      const room = await response.json() as { roomId: string; inviteToken: string; hostToken: string };
      sessionStorage.setItem(`tabcloud:host:${room.roomId}`, room.hostToken);
      window.location.assign(`/room/${encodeURIComponent(room.roomId)}#invite=${encodeURIComponent(room.inviteToken)}`);
    } catch (err) { setError(err instanceof Error ? err.message : '방을 만들지 못했습니다.'); setCreating(false); }
  }
  function joinRoom(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const url = new URL(invite.trim(), location.origin);
      if (!/^\/room\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || !new URLSearchParams(url.hash.slice(1)).get('invite')) throw new Error();
      window.location.assign(`${url.pathname}${url.hash}`);
    } catch { setError('초대받은 링크 전체를 입력해 주세요.'); }
  }
  return <div className="home-shell">
    <header className="topbar"><Logo /></header>
    <main className="home-main">
      <div className="home-symbol" aria-hidden="true"><span /><span /><span /><span /></div>
      <h1>브라우저를 모아<br /><span>함께 완성하는 프랙털</span></h1>
      <p className="hero-description">링크로 연결하고, 각자의 CPU로 함께 계산해요.</p>
      <div className="home-grid">
        <section className="home-create panel"><h2>새롭게 시작하기</h2><p>방을 만들고 함께할 사람을 초대해요.</p><button className="button primary large" onClick={createRoom} disabled={creating}>{creating ? '방 만드는 중…' : '방 만들기'}<Icon type="arrow" /></button></section>
        <form className="home-join panel" onSubmit={joinRoom}><h2>초대받았나요?</h2><label className="sr-only" htmlFor="join-link">초대 링크</label><input id="join-link" placeholder="초대 링크 붙여넣기" value={invite} onChange={(event) => setInvite(event.target.value)} required /><button className="button secondary large" type="submit">방 참여하기<Icon type="arrow" /></button></form>
      </div>
      {error && <Notice error>{error}</Notice>}
      <p className="home-note">설치 없이 · 로그인 없이 · 동의한 연산만</p>
    </main>
  </div>;
}

function Room({ roomId, inviteToken }: { roomId: string; inviteToken: string }) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [selfId, setSelfId] = useState('');
  const [role, setRole] = useState<'host' | 'participant'>('participant');
  const [connection, setConnection] = useState<Connection>('connecting');
  const [consented, setConsented] = useState(false);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<RenderSettings>({ ...DEFAULT_DEMO_SETTINGS });
  const [receivedTiles, setReceivedTiles] = useState(0);
  const [imageChecksum, setImageChecksum] = useState('');
  const [endToEndMs, setEndToEndMs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [showInviteLink, setShowInviteLink] = useState(false);
  const [soloProgress, setSoloProgress] = useState<number | null>(null);
  const [soloResult, setSoloResult] = useState<SoloResult | null>(null);
  const [clock, setClock] = useState(Date.now());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const consentRef = useRef(false);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const currentJobRef = useRef<string | null>(null);
  const leaseRef = useRef<Lease | null>(null);
  const pixelsRef = useRef<Uint8ClampedArray | null>(null);
  const tilesRef = useRef(new Set<string>());
  const soloRef = useRef<SoloRun | null>(null);
  const endToEndRef = useRef<{ jobId: string | null; started: number; scheduled: boolean } | null>(null);
  const sendRef = useRef<(message: ClientMessage) => void>(() => {});
  const requestRef = useRef(() => {});
  const consentActionRef = useRef<(enabled: boolean) => void>(() => {});
  const soloActionRef = useRef(() => {});
  const inviteLink = `${location.origin}/room/${roomId}#invite=${encodeURIComponent(inviteToken)}`;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let fatal = false;
    let requested = false;
    const hostToken = sessionStorage.getItem(`tabcloud:host:${roomId}`) ?? undefined;
    let name = sessionStorage.getItem('tabcloud:name');
    if (!name) { name = `브라우저 ${Math.random().toString(36).slice(2, 6).toUpperCase()}`; sessionStorage.setItem('tabcloud:name', name); }

    function send(message: ClientMessage) {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
    }
    sendRef.current = send;
    function stopWorker(resetConsent = true) {
      workerRef.current?.terminate(); workerRef.current = null;
      requested = false;
      leaseRef.current = null; soloRef.current = null;
      setActiveTask(null); setSoloProgress(null);
      if (resetConsent) { consentRef.current = false; setConsented(false); }
    }
    function requestTask() {
      if (consentRef.current && workerRef.current && !leaseRef.current && !requested && roomRef.current?.job?.status === 'running') {
        requested = true; send({ v: 1, type: 'request-task' });
      }
    }
    requestRef.current = requestTask;

    function createWorker() {
      const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name: 'TabCloud render' });
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (workerRef.current !== worker) return;
        const solo = soloRef.current;
        if (solo) {
          const task = solo.tasks[solo.index];
          if (data.token !== task.taskId) return;
          if (data.type === 'error') { setError(`단독 실행 오류: ${data.message}`); stopWorker(); return; }
          if (data.type !== 'done') return;
          const pixels = new Uint8ClampedArray(data.pixels);
          mergeTile(solo.pixels, task, pixels);
          solo.canvas.getContext('2d')!.putImageData(new ImageData(pixels, task.width, task.height), task.x, task.y);
          solo.computeMs += data.computeMs; solo.index += 1;
          setSoloProgress(solo.index / solo.tasks.length * 100);
          if (solo.index === solo.tasks.length) {
            const hash = checksum(solo.pixels);
            setSoloResult({ checksum: hash, wallMs: performance.now() - solo.started, computeMs: solo.computeMs, settings: solo.settings });
            stopWorker();
          } else { const next = solo.tasks[solo.index]; worker.postMessage({ task: next, token: next.taskId }); }
          return;
        }
        const lease = leaseRef.current;
        if (!consentRef.current || !lease || data.token !== lease.attemptId) return;
        const ids = { jobId: lease.task.jobId, taskId: lease.task.taskId, attemptId: lease.attemptId };
        if (data.type === 'progress' && (performance.now() - lease.lastProgressAt >= 1000 || data.rows === lease.task.height)) {
          lease.lastProgressAt = performance.now(); send({ v: 1, type: 'task-progress', ...ids, rows: data.rows });
        }
        if (data.type === 'error') { send({ v: 1, type: 'task-error', ...ids, message: data.message.slice(0, 200) }); leaseRef.current = null; setActiveTask(null); requestTask(); }
        if (data.type === 'done') {
          const bytes = new Uint8Array(data.pixels);
          let binary = '';
          for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
          send({ v: 1, type: 'task-result', ...ids, pixels: btoa(binary), computeMs: data.computeMs });
        }
      };
      worker.onerror = () => {
        setError('연산 Worker가 중단되었습니다. 브라우저 상태를 확인하고 다시 참여해 주세요.');
        send({ v: 1, type: 'consent-compute', enabled: false }); stopWorker();
      };
      workerRef.current = worker;
      return worker;
    }

    consentActionRef.current = (enabled) => {
      setError('');
      if (!enabled) { stopWorker(); send({ v: 1, type: 'consent-compute', enabled: false }); return; }
      if (socketRef.current?.readyState !== WebSocket.OPEN || !roomRef.current) return;
      if (typeof Worker === 'undefined') { setError('이 브라우저는 Web Worker를 지원하지 않아 연산에 참여할 수 없습니다.'); return; }
      try { stopWorker(); createWorker(); consentRef.current = true; setConsented(true); send({ v: 1, type: 'consent-compute', enabled: true }); requestTask(); }
      catch { setError('Web Worker를 시작할 수 없습니다. 최신 브라우저에서 다시 시도해 주세요.'); }
    };
    soloActionRef.current = () => {
      const job = roomRef.current?.job;
      if (!job || job.status !== 'completed') return;
      try {
        stopWorker(); send({ v: 1, type: 'consent-compute', enabled: false }); setError(''); setSoloResult(null);
        const started = performance.now();
        const canvas = document.createElement('canvas'); canvas.width = job.settings.width; canvas.height = job.settings.height;
        const tasks = createTiles('solo', job.settings);
        soloRef.current = { tasks, index: 0, pixels: new Uint8ClampedArray(job.settings.width * job.settings.height * 4), canvas, started, computeMs: 0, settings: { ...job.settings } };
        setSoloProgress(0); createWorker().postMessage({ task: tasks[0], token: tasks[0].taskId });
      } catch { stopWorker(); setError('단독 실행 Worker를 시작할 수 없습니다.'); }
    };

    function prepareCanvas(jobId: string, renderSettings: RenderSettings) {
      currentJobRef.current = jobId; tilesRef.current.clear();
      if (endToEndRef.current?.jobId === null) endToEndRef.current.jobId = jobId;
      else endToEndRef.current = null;
      setEndToEndMs(null);
      pixelsRef.current = new Uint8ClampedArray(renderSettings.width * renderSettings.height * 4);
      setReceivedTiles(0); setImageChecksum(''); setSoloResult(null); setSettings({ ...renderSettings });
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = renderSettings.width; canvas.height = renderSettings.height; canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); }
    }

    function finishMeasurement() {
      const measurement = endToEndRef.current;
      const job = roomRef.current?.job;
      if (!measurement || measurement.scheduled || measurement.jobId !== job?.id || job?.status !== 'completed' || tilesRef.current.size !== job.totalTasks) return;
      measurement.scheduled = true;
      requestAnimationFrame(() => {
        if (!disposed && endToEndRef.current === measurement) setEndToEndMs(performance.now() - measurement.started);
      });
    }

    function connect() {
      if (disposed || fatal) return;
      setConnection(reconnectAttempts ? 'reconnecting' : 'connecting');
      let socket: WebSocket;
      try { socket = new WebSocket(websocketUrl('/ws')); }
      catch (err) { fatal = true; setConnection('error'); setError(err instanceof Error ? err.message : '서버 주소 설정을 확인해 주세요.'); return; }
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed) return;
        send({ v: 1, type: 'join-room', roomId, inviteToken, hostToken, name: name! });
      };
      socket.onmessage = (event) => {
        if (disposed || socketRef.current !== socket) return;
        let raw: unknown;
        try { raw = JSON.parse(String(event.data)); } catch { setError('서버에서 올바르지 않은 응답을 받았습니다.'); return; }
        const parsed = serverMessageSchema.safeParse(raw);
        if (!parsed.success) { setError('서버 프로토콜 버전이 맞지 않습니다. 페이지를 새로고침해 주세요.'); return; }
        const message = parsed.data;
        if (message.type === 'room-snapshot') {
          const previous = roomRef.current?.job;
          roomRef.current = message.room; setRoom(message.room); setRole(message.role); setSelfId(message.selfId);
          setConnection('connected'); reconnectAttempts = 0;
          const job = message.room.job;
          if (job && currentJobRef.current !== job.id) { if (soloRef.current) stopWorker(); prepareCanvas(job.id, job.settings); }
          if (job && ['completed', 'cancelled', 'failed'].includes(job.status) && previous?.status === 'running') {
            stopWorker(); send({ v: 1, type: 'consent-compute', enabled: false });
          }
          if (job?.failureReason) setError(`작업 실패: ${job.failureReason}`);
          finishMeasurement();
          requestTask();
        }
        if (message.type === 'task-assigned') {
          if (!consentRef.current || !workerRef.current || soloRef.current) { send({ v: 1, type: 'consent-compute', enabled: false }); return; }
          if (leaseRef.current?.attemptId === message.attemptId) return;
          if (leaseRef.current) { workerRef.current.terminate(); createWorker(); }
          requested = false;
          leaseRef.current = { task: message.task, attemptId: message.attemptId, lastProgressAt: performance.now() }; setActiveTask(message.task.taskId);
          workerRef.current!.postMessage({ task: message.task, token: message.attemptId });
        }
        if (message.type === 'task-accepted' || message.type === 'task-rejected') {
          if (leaseRef.current?.attemptId === message.attemptId) {
            if (message.type === 'task-rejected' && workerRef.current) { workerRef.current.terminate(); createWorker(); }
            leaseRef.current = null; setActiveTask(null); requestTask();
          }
        }
        if (message.type === 'tile-completed') {
          const task = message.task;
          if (task.jobId !== currentJobRef.current || tilesRef.current.has(task.taskId) || !pixelsRef.current) return;
          try {
            const binary = atob(message.pixels);
            if (binary.length !== task.width * task.height * 4) throw new Error();
            const pixels = Uint8ClampedArray.from(binary, (char) => char.charCodeAt(0));
            mergeTile(pixelsRef.current, task, pixels);
            canvasRef.current?.getContext('2d')?.putImageData(new ImageData(pixels, task.width, task.height), task.x, task.y);
            tilesRef.current.add(task.taskId); setReceivedTiles(tilesRef.current.size);
            if (tilesRef.current.size === roomRef.current?.job?.totalTasks) setImageChecksum(checksum(pixelsRef.current));
            finishMeasurement();
          } catch { setError('일부 타일을 표시하지 못했습니다. 새로고침하면 완료된 타일을 다시 받을 수 있습니다.'); }
        }
        if (message.type === 'job-cancelled') stopWorker();
        if (message.type === 'error') {
          setError(message.message);
          if (['ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'INVALID_INVITE', 'INVALID_HOST_TOKEN', 'ROOM_FULL'].includes(message.code)) { fatal = true; setConnection('error'); stopWorker(); socket.close(); }
        }
      };
      socket.onclose = () => {
        if (disposed || socketRef.current !== socket) return;
        stopWorker();
        endToEndRef.current = null; setEndToEndMs(null);
        if (fatal) return;
        setConnection('reconnecting'); setError('연결이 끊겨 연산을 중단했습니다. 재연결 후 연산 참여를 다시 눌러 주세요.');
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(reconnectAttempts - 1, 4), 15000));
      };
      socket.onerror = () => { setError('서버 연결을 확인하고 있습니다. 서버가 재시작되었다면 새 방을 만들어 주세요.'); };
    }
    connect();
    const pullTimer = setInterval(() => { if (!leaseRef.current) requested = false; requestTask(); }, 500);
    const heartbeat = setInterval(() => send({ v: 1, type: 'heartbeat' }), 5000);
    const ticker = setInterval(() => setClock(Date.now()), 250);
    return () => {
      disposed = true; clearTimeout(reconnectTimer); clearInterval(pullTimer); clearInterval(heartbeat); clearInterval(ticker);
      send({ v: 1, type: 'leave-room' }); socketRef.current?.close(); stopWorker();
    };
  }, [roomId, inviteToken]);

  const job = room?.job;
  const running = job?.status === 'running';
  const complete = job?.status === 'completed' && receivedTiles === job.totalTasks;
  const participant = room?.participants.find((person) => person.id === selfId);
  const connectedPeople = room?.participants.filter((person) => person.connected) ?? [];
  const computingPeople = connectedPeople.filter((person) => person.consented);
  const progress = job ? job.completedTasks / job.totalTasks * 100 : 0;
  const elapsed = job?.wallMs ?? (running && job.startedAt ? Math.max(0, clock - job.startedAt) : null);
  const matchedSolo = soloResult && job && sameSettings(soloResult.settings, job.settings) ? soloResult : null;
  const settingsValid = renderSettingsSchema.safeParse(settings);
  const isHost = role === 'host';

  function updateSetting(key: keyof RenderSettings, value: string) { setSettings((current) => ({ ...current, [key]: value === '' ? Number.NaN : Number(value) })); }
  function startJob(event: FormEvent) {
    event.preventDefault();
    const result = renderSettingsSchema.safeParse(settings);
    if (!result.success) { setError(result.error.issues[0]?.message ?? '렌더 설정을 확인해 주세요.'); return; }
    setError(''); endToEndRef.current = { jobId: null, started: performance.now(), scheduled: false }; setEndToEndMs(null);
    sendRef.current({ v: 1, type: 'start-job', settings: result.data });
  }
  async function copyInvite() {
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch {
      setShowInviteLink(true);
      requestAnimationFrame(() => { const input = document.querySelector<HTMLInputElement>('[data-testid="invite-link"]'); input?.focus(); input?.select(); });
      setError('아래 초대 링크를 복사해 주세요.');
    }
  }
  function downloadPng() {
    if (!complete) return;
    canvasRef.current?.toBlob((blob) => { if (!blob) return; const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `tabcloud-${roomId.slice(0, 8)}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }, 'image/png');
  }

  return <div className="app-shell">
    <header className="topbar">
      <Logo />
      <span className="connection" data-testid="connection-status"><span className={`live-dot ${connection === 'connected' ? '' : 'offline'}`} />{connection === 'connected' ? '연결됨' : connection === 'error' ? '연결 오류' : connection === 'reconnecting' ? '재연결 중' : '연결 중'}</span>
    </header>
    <main className="room-main">
      <div className="page-heading">
        <div><span className="room-label">우리의 작업 공간 <span className="role-badge">{isHost ? '방장' : '참여자'}</span></span><h1>함께 만드는 프랙털</h1></div>
        <div className="invite-controls"><button className="button secondary" onClick={copyInvite}><Icon type="copy" />{copied ? '복사 완료' : '초대 링크 복사'}</button></div>
      </div>
      {error && <Notice error>{error}<button className="dismiss" onClick={() => setError('')} aria-label="안내 닫기">×</button></Notice>}
      <input className={showInviteLink ? 'invite-fallback' : 'sr-only'} aria-label="방 초대 링크" data-testid="invite-link" value={inviteLink} readOnly tabIndex={showInviteLink ? 0 : -1} onFocus={(event) => event.target.select()} />
      {room && !room.hostConnected && <Notice>방장 재연결을 기다리는 중이에요. 진행 중인 작업은 계속돼요.</Notice>}
      <div className="workspace-grid">
        <div className="center-column">
          <section className="panel canvas-panel">
            <div className="canvas-heading"><h2>프랙털 캔버스</h2><span className={`job-badge ${job?.status ?? 'idle'}`} data-testid="job-status" data-status={job?.status ?? 'idle'}><span className="live-dot" />{job ? statusNames[job.status] : '시작 대기'}</span></div>
            <div className="canvas-stage">
              <canvas ref={canvasRef} data-testid="render-canvas" aria-label="Mandelbrot 프랙털 렌더링 결과" width={DEFAULT_SETTINGS.width} height={DEFAULT_SETTINGS.height} />
              {receivedTiles === 0 && <div className="canvas-empty"><span className="empty-orbit" aria-hidden="true"><i /><i /><i /></span><strong>{running ? computingPeople.length ? '첫 조각을 계산하고 있어요' : '연산 참여를 기다리고 있어요' : '함께 채워볼까요?'}</strong><p>{running ? computingPeople.length ? '완성되는 조각을 실시간으로 보여드려요.' : '연산 참여를 누르면 계산이 시작돼요.' : isHost ? '연산에 참여하고 렌더를 시작해 주세요.' : '연산에 참여하면 방장이 시작할 때 함께 계산해요.'}</p></div>}
              {receivedTiles > 0 && <span className="canvas-resolution">{job?.settings.width} × {job?.settings.height}</span>}
            </div>
            <div className="progress-area"><div className="progress-label"><span>{complete ? '완성했어요' : running ? '프랙털을 완성하는 중' : '전체 진행률'}</span><strong>{progress.toFixed(0)}<small>%</small></strong></div><progress data-testid="progress" aria-label="전체 렌더 진행률" value={job?.completedTasks ?? 0} max={job?.totalTasks ?? 1} /></div>
            <div className="canvas-bottom"><div className="stats-grid" aria-label="실시간 연산 통계"><div><span>참여 중</span><strong>{computingPeople.length}<small>대</small></strong></div><div><span>{endToEndMs !== null ? '완성 시간' : '경과 시간'}</span><strong>{formatTime(endToEndMs ?? elapsed)}</strong></div><div><span>완료 타일</span><strong>{job?.completedTasks ?? 0}<small> / {job?.totalTasks ?? 0}</small></strong></div></div><button className="button secondary download-button" disabled={!complete} onClick={downloadPng}><Icon type="download" />PNG 다운로드</button></div>
          </section>
          <section className="panel benchmark-panel">
            <div className="section-heading"><h2>혼자 할 때와 비교해요</h2><button className="button secondary" disabled={!complete || soloProgress !== null || connection !== 'connected' || typeof Worker === 'undefined'} onClick={() => soloActionRef.current()}>{soloProgress !== null ? `단독 실행 ${soloProgress.toFixed(0)}%` : '단독 실행 측정'}</button></div>
            <p className="benchmark-consent">이 기기의 CPU로 다시 계산해요. 언제든 연산 중단을 누를 수 있어요.</p>
            {soloProgress !== null && <progress aria-label="단독 실행 진행률" value={soloProgress} max={100} />}
            <div className="benchmark-results" data-testid="solo-result"><div><span>함께</span><strong>{formatTime(endToEndMs)}</strong></div><div><span>혼자</span><strong>{matchedSolo ? formatTime(matchedSolo.wallMs) : '—'}</strong></div><div><span>단독 ÷ 분산 시간</span><strong className="accent">{matchedSolo && endToEndMs !== null && endToEndMs > 0 ? `${(matchedSolo.wallMs / endToEndMs).toFixed(2)}배` : '—'}</strong></div></div>
            {matchedSolo && imageChecksum && <p className={`consistency-state ${matchedSolo.checksum === imageChecksum ? 'accent' : 'inline-error'}`} data-testid="consistency-state">{matchedSolo.checksum === imageChecksum ? '단독 결과 일치 ✓' : '단독 결과 불일치'}</p>}
            <details className="measurement-details"><summary>측정 정보</summary><dl><div><dt>서버 작업 시간</dt><dd>{formatTime(job?.wallMs)}</dd></div><div><dt>참여 기기의 연산 시간 합계</dt><dd>{formatTime(job?.computeMs)}</dd></div><div><dt>서버 검증 시간</dt><dd>{formatTime(job?.validationMs)}</dd></div><div><dt>할당 → 결과 수신 시간 합계</dt><dd>{formatTime(job?.roundTripMs)}</dd></div><div><dt>승인된 이미지 데이터</dt><dd>{job ? `${(job.resultBytes / 1024).toFixed(1)} KiB` : '—'}</dd></div><div><dt>단독 Worker 연산 시간</dt><dd>{formatTime(matchedSolo?.computeMs)}</dd></div><div><dt>받은 타일 / 재시도</dt><dd>{receivedTiles} / {job?.retries ?? 0}</dd></div>{imageChecksum && <div><dt>이미지 체크섬</dt><dd><code data-testid="image-checksum">{imageChecksum}</code></dd></div>}</dl><p>분산 시간은 이 화면의 렌더 시작부터 마지막 타일을 표시한 다음 프레임까지 측정해요. 새로고침하거나 다른 브라우저로 참여하면 비교값은 표시하지 않아요. 단독 시간에는 Worker 시작, 계산, 화면 합성이 포함돼요. 할당부터 수신까지의 합계는 기기 간 시간이 겹치므로 통신 시간만을 뜻하지 않아요. 같은 기기의 여러 탭은 별도 기기를 대표하지 않으며, 분산 실행이 항상 빠르지는 않아요.</p></details>
          </section>
        </div>
        <aside className="control-column">
          <form className="panel settings-panel" onSubmit={startJob}>
            <div className="section-heading"><h2>렌더 설정</h2>{!isHost && <span className="muted">방장만 변경</span>}</div>
            <fieldset disabled={!isHost || running || soloProgress !== null}>
              <div className="preset-list" aria-label="연산 강도">{RENDER_PRESETS.map((preset) => <button className={`preset-button ${sameSettings(settings, preset.settings) ? 'selected' : ''}`} type="button" key={preset.id} data-testid={`preset-${preset.id}`} aria-pressed={sameSettings(settings, preset.settings)} onClick={() => setSettings({ ...preset.settings })}>{preset.name}</button>)}</div>
              <p className="preset-detail">{settingsValid.success ? `${settings.width.toLocaleString()} × ${settings.height.toLocaleString()} · ${settings.maxIterations.toLocaleString()}회` : '설정을 확인해 주세요'}</p>
              <details className="advanced-settings"><summary>직접 설정</summary><div className="field-grid"><label>너비<input aria-label="너비" type="number" min={LIMITS.minDimension} max={LIMITS.maxDimension} step="1" value={Number.isNaN(settings.width) ? '' : settings.width} onChange={(event) => updateSetting('width', event.target.value)} /></label><label>높이<input aria-label="높이" type="number" min={LIMITS.minDimension} max={LIMITS.maxDimension} step="1" value={Number.isNaN(settings.height) ? '' : settings.height} onChange={(event) => updateSetting('height', event.target.value)} /></label><label>반복 횟수<input aria-label="반복 횟수" type="number" min={LIMITS.minIterations} max={LIMITS.maxIterations} step="1" value={Number.isNaN(settings.maxIterations) ? '' : settings.maxIterations} onChange={(event) => updateSetting('maxIterations', event.target.value)} /></label><label>타일 크기<select aria-label="타일 크기" value={settings.tileSize} onChange={(event) => updateSetting('tileSize', event.target.value)}><option value="32">32 × 32</option><option value="64">64 × 64</option><option value="128">128 × 128</option></select></label><label>중심 X<input aria-label="중심 X" type="number" min="-4" max="4" step="any" value={Number.isNaN(settings.centerX) ? '' : settings.centerX} onChange={(event) => updateSetting('centerX', event.target.value)} /></label><label>중심 Y<input aria-label="중심 Y" type="number" min="-4" max="4" step="any" value={Number.isNaN(settings.centerY) ? '' : settings.centerY} onChange={(event) => updateSetting('centerY', event.target.value)} /></label><label className="wide-field">가로 범위<input aria-label="가로 범위" type="number" min="0.000001" max="8" step="any" value={Number.isNaN(settings.span) ? '' : settings.span} onChange={(event) => updateSetting('span', event.target.value)} /></label></div></details>
            </fieldset>
            {isHost && (running ? <button className="button danger full" type="button" onClick={() => sendRef.current({ v: 1, type: 'cancel-job', jobId: job.id })} disabled={connection !== 'connected'}><Icon type="stop" />작업 취소</button> : <button className="button primary full" type="submit" disabled={connection !== 'connected' || !settingsValid.success || soloProgress !== null}><Icon type="play" />렌더 시작</button>)}
          </form>
          <section className={`panel consent-panel ${consented ? 'is-contributing' : ''}`}>
            <div className="section-heading"><h2>내 브라우저</h2><span className={`worker-indicator ${consented ? 'active' : ''}`} /></div>
            <div className="my-status"><span>{soloProgress !== null ? '단독 측정 중' : consented ? activeTask ? '계산 중이에요' : '시작을 기다려요' : '지금은 구경 중'}</span><strong>{participant?.completedTasks ?? 0}<small> 타일</small></strong></div>
            <button className={`button full ${consented || soloProgress !== null ? 'secondary' : 'primary-outline'}`} onClick={() => consentActionRef.current(!(consented || soloProgress !== null))} disabled={connection !== 'connected' || typeof Worker === 'undefined'}>{consented || soloProgress !== null ? <><Icon type="stop" />연산 중단</> : <><Icon type="play" />연산 참여</>}</button>
            <p className="consent-description">참여하면 CPU를 사용해요.<br />발열·배터리 소모가 생길 수 있어요. 언제든 중단해요.</p>
            {typeof Worker === 'undefined' && <p className="inline-error">이 브라우저는 연산을 지원하지 않아요.</p>}
          </section>
          <section className="panel participants-panel"><div className="section-heading"><h2>함께하는 브라우저</h2><span className="count-badge">{connectedPeople.length}</span></div><div className="participant-list" data-testid="participant-list">{room?.participants.length ? room.participants.map((person, index) => <div className={`participant ${person.connected ? '' : 'disconnected'}`} key={person.id} data-testid="participant" data-completed={person.completedTasks} data-self={person.id === selfId} data-connected={person.connected}><span className={`avatar avatar-${index % 4}`} aria-hidden="true">{person.name.slice(-2)}</span><div className="participant-info"><strong>{person.name}{person.id === selfId && <small>나</small>}</strong><span>{person.role === 'host' ? '방장 · ' : ''}{!person.connected ? '연결 종료' : person.activeTaskId ? '계산 중' : person.consented ? '대기 중' : '구경 중'}</span></div><span className="participant-count">{person.completedTasks}<small> 타일</small></span></div>) : <p className="empty-list">연결하고 있어요.</p>}</div></section>
          <details className="activity-details"><summary>활동 기록</summary><ol className="event-list">{room?.events.length ? [...room.events].reverse().slice(0, 8).map((event, index) => <li key={`${event.at}-${index}`}><span className="event-dot" /><div><p>{event.message}</p><time>{new Date(event.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></div></li>) : <li className="empty-list">아직 활동이 없어요.</li>}</ol><p className="room-note">{room ? `${new Date(room.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 만료 · ` : ''}서버 재시작 시 방이 사라져요. 연산은 Worker 1개를 사용하며 숨겨진 탭은 느려질 수 있어요.</p></details>
        </aside>
      </div>
    </main>
  </div>;
}


export default function App() {
  const match = location.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)\/?$/);
  const inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (match && !inviteToken) return <div className="home-shell"><header className="topbar"><Logo /></header><main className="invalid-room panel"><h1>초대 링크를 확인해 주세요</h1><p>방에 참여하려면 전체 초대 링크가 필요해요.</p><a className="button primary" href="/">홈으로 돌아가기</a></main></div>;
  if (match && inviteToken) return <Room roomId={match[1]} inviteToken={inviteToken} />;
  return <Home />;
}
