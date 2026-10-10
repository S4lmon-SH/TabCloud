import { useId, type CSSProperties } from 'react';
import type { DeviceResources, ResourceLimits, ResourcePlan } from './resource-budget';
import './resource-controls.css';

export interface ResourceStats {
  cpuActiveMs: number;
  gpuActiveMs: number;
  completedRows: number;
  trackedBytes: number;
  engine?: string;
}

export interface ResourceControlsProps {
  limits: ResourceLimits;
  onChange: (limits: ResourceLimits) => void;
  device: DeviceResources;
  plan: ResourcePlan;
  disabled?: boolean;
  stats?: ResourceStats;
}

const mebibytes = (bytes: number) => `${(Math.max(0, bytes) / 1_048_576).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} MiB`;
const activeTime = (milliseconds: number) => `${(Math.max(0, milliseconds) / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}초`;

export function ResourceControls({ limits, onChange, device, plan, disabled = false, stats }: ResourceControlsProps) {
  const id = useId();
  const controls: { key: keyof ResourceLimits; label: string; caption: string; unavailable?: boolean }[] = [
    { key: 'cpuPercent', label: 'CPU 렌더링 한도', caption: `${device.logicalCores}개 논리 코어 기준` },
    { key: 'ramPercent', label: 'RAM 작업 예산', caption: device.deviceMemoryGiB === null ? '용량 미확인 · 512 MiB 기준' : `브라우저 추정 ${device.deviceMemoryGiB} GiB 기준` },
    { key: 'gpuPercent', label: 'GPU 연산 한도', caption: device.gpuAvailable ? 'WebGPU로 병렬 연산' : '이 브라우저에서는 사용할 수 없어요', unavailable: !device.gpuAvailable },
  ];

  return <section className="an-resource-controls" aria-labelledby={`${id}-title`} data-testid="resource-controls">
    <div className="an-resource-heading"><h3 id={`${id}-title`}>내 기기 자원</h3><span>이 브라우저에만 적용</span></div>
    <div className="an-resource-sliders">
      {controls.map(({ key, label, caption, unavailable }) => {
        const value = unavailable ? 0 : limits[key];
        const inputId = `${id}-${key}`;
        return <div className={`an-resource-row${unavailable ? ' unavailable' : ''}`} key={key}>
          <div className="an-resource-label"><label htmlFor={inputId}>{label}</label><output htmlFor={inputId} data-testid={`resource-${key}-value`}>{value}<small>%</small></output></div>
          <input id={inputId} type="range" min={0} max={100} step={5} value={value} disabled={disabled || unavailable} aria-describedby={`${inputId}-caption`} aria-valuetext={value === 0 ? '사용 안 함' : `${value}%`} data-testid={`resource-${key}`} style={{ '--resource-progress': `${value}%` } as CSSProperties} onChange={(event) => onChange({ ...limits, [key]: Number(event.currentTarget.value) })} />
          <div className="an-resource-caption" id={`${inputId}-caption`}><span>{caption}</span><span>{value === 0 ? '사용 안 함' : '최대 100%'}</span></div>
        </div>;
      })}
    </div>
    <div className="an-resource-plan" data-testid="resource-plan">
      <div><span>동시 CPU 작업</span><strong data-testid="resource-cpu-workers">{plan.cpuWorkers}개</strong></div>
      <div><span>GPU 작업</span><strong data-testid="resource-gpu-enabled">{plan.gpuEnabled ? '사용' : '꺼짐'}</strong></div>
      <div><span>RAM 예산</span><strong data-testid="resource-ram-budget">{mebibytes(plan.ramBudgetBytes)}</strong></div>
    </div>
    {!plan.canRender && plan.reason && <p className="an-resource-blocked" role="status">{plan.reason}</p>}
    <details className="an-resource-details">
      <summary>자원 상세</summary>
      <dl>
        <div><dt>프레임 작업 메모리 계획</dt><dd>{mebibytes(plan.plannedBytes)}</dd></div>
        {stats && <>
          <div><dt>렌더 버퍼 예약</dt><dd data-testid="resource-tracked-memory">{mebibytes(stats.trackedBytes)}</dd></div>
          <div><dt>CPU Worker 연산 시간</dt><dd>{activeTime(stats.cpuActiveMs)}</dd></div>
          <div><dt>GPU 처리 시간</dt><dd>{activeTime(stats.gpuActiveMs)}</dd></div>
          {stats.engine && <div><dt>렌더링 엔진</dt><dd data-testid="resource-engine">{stats.engine}</dd></div>}
        </>}
      </dl>
      <p>RAM은 렌더링 버퍼 예산이며 최대 512 MiB예요. 브라우저와 드라이버의 전체 메모리는 포함하지 않아요. CPU 0%는 CPU Worker를 끄는 설정이에요. GPU 모드도 제어와 경계 픽셀 보정에는 CPU를 사용해요.</p>
    </details>
    <p className="an-resource-footnote">CPU·GPU는 연산 시간 비율, RAM은 추정 용량 기준 예산이에요. 시스템 사용률과 다를 수 있어요.</p>
  </section>;
}
