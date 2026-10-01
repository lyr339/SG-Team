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
 * 运行页标题：工程与状态同排，说明只保留一行；右侧操作不随状态计数变化而移动。
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
          <h1 title={view.workspace?.path}>{workspaceName}</h1>
          <span className={`run-state-chip is-${view.state.tone}`} title={view.state.hint}>
            {view.state.label}
          </span>
        </div>
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
