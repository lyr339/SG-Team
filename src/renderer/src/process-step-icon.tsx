import type { ProcessStepKind } from './process-turn-view'

/**
 * 过程步骤字形：会话页过程流（`ProcessTurnCard`）与名册活动行（`SessionRailCard`）
 * 共用同一套 20×20 线性图标，同一种工具在两处长得一样。颜色取 currentColor，
 * 由调用方的 `--tool-hue` 决定；`message` 等没有专属字形的步骤落到末尾的通用火花。
 */
export function StepIcon({ kind }: { kind: ProcessStepKind }): React.JSX.Element {
  if (kind === 'thinking') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.3 15.7v-1.2c-2.1-.9-3.4-2.8-3.4-5.1A6.1 6.1 0 0 1 10 3.3a6.1 6.1 0 0 1 6.1 6.1c0 2.3-1.3 4.2-3.4 5.1v1.2M7.1 18h5.8M10 3.3V1.8M3.6 4.3 2.5 3.2M16.4 4.3l1.1-1.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45"/></svg>
  }
  if (kind === 'read') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M7.5 10h5M7.5 13h5" fill="none" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'edit' || kind === 'write') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 14.8.7-3.2 7.9-7.9a1.5 1.5 0 0 1 2.1 0l1.6 1.6a1.5 1.5 0 0 1 0 2.1l-7.9 7.9-3.2.7zM11.7 4.6l3.7 3.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'command') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="m5.5 8 2.2 2-2.2 2M9.7 12h4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'search') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="m12.4 12.4 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'browser') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M2.8 7h14.4M6 5.3h.1M8.3 5.3h.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/><path d="m8 10 2-1.2v4.4L8 12z" fill="currentColor"/></svg>
  }
  if (kind === 'question') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5A1.5 1.5 0 0 1 5 3h10a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 15 13h-5.2L6.5 16v-3H5a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4"/><path d="M8.3 6.9a1.8 1.8 0 0 1 3.5.5c0 1.1-1.8 1.3-1.8 2.4M10 11.6h.01" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'task') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M4.5 16.5a5.5 5.5 0 0 1 11 0M14 3.2l1.6 1.6M16.8 2.8v2.4h-2.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.7 3.2 6.8 5.5l-2.4.9v2.5l2.4.9.9 2.3h2.6l.9-2.3 2.4-.9V6.4l-2.4-.9-.9-2.3zM8.2 16.8h7.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35"/></svg>
}
