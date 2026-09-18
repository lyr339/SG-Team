import { SessionsIcon, StopIcon } from '../UiIcons'
import type { PoolView } from './pool-view'

interface PoolHeaderProps {
  view: PoolView
  busy: boolean
  /** 正在执行的动作名（页面级），用于在对应按钮上显示进行中文案。 */
  busyAction?: string
  onEnd: () => void
  onOpenSessions: () => void
}

function compactPoolName(poolName: string, workspaceName: string): string {
  const clean = poolName.trim()
  for (const separator of [' · ', ' / ', ' - ']) {
    const prefix = `${workspaceName.trim()}${separator}`
    if (clean.startsWith(prefix)) return clean.slice(prefix.length).trim() || clean
  }
  return clean
}

/**
 * 会话池头部：左侧是"这是什么、跑得怎样"（状态 / 工程名 / 池名 · 提示），
 * 右侧是宽度恒定的控件（打开会话、结束全部会话）。左侧吸收一切文字长度变化，
 * 右侧控件的位置与头部高度在任何状态下都不动。
 */
export function PoolHeader({ view, busy, busyAction, onEnd, onOpenSessions }: PoolHeaderProps): React.JSX.Element {
  const pool = view.pool
  const ended = view.phase === 'completed'
  const ending = busyAction === 'end-run'
  const workspaceName = view.workspace?.name ?? '未绑定工程'
  const poolName = pool ? compactPoolName(pool.name, workspaceName) : ''
  const subline = [poolName && poolName !== workspaceName ? poolName : '', view.state.hint ?? ''].filter(Boolean).join(' · ')

  return (
    <header className="run-header" aria-label="运行控制">
      <div className="run-header__identity">
        <div className="run-header__line">
          <span className="run-header__eyebrow">会话池</span>
          <span className={`run-state-chip is-${view.state.tone}`} title={view.state.hint}>
            <i aria-hidden="true" />{view.state.label}
          </span>
        </div>
        <h1 title={view.workspace?.path}>{workspaceName}</h1>
        <small title={subline}>{subline || '\u00a0'}</small>
      </div>

      <div className="run-header__controls">
        <div className="run-header__actions">
          <button type="button" className="run-header__ghost" disabled={busy} onClick={onOpenSessions}>
            <SessionsIcon />打开会话
          </button>
          <button
            type="button"
            className="run-header__ghost is-danger"
            disabled={busy || ended || !pool}
            aria-busy={ending}
            onClick={onEnd}
          >
            <StopIcon />{ending ? '结束中…' : '结束全部会话'}
          </button>
        </div>
      </div>
    </header>
  )
}
