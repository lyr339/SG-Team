import { useState } from 'react'
import { formatFullClock, formatRelativeClock } from '../format'
import { RunBatchConfig, type RunBatchConfigProps } from './RunBatchConfig'
import type { PoolView } from './pool-view'

export const INDEPENDENT_MIN_SESSIONS = 1
export const INDEPENDENT_MAX_SESSIONS = 16

export const clampSessionCount = (value: number): number =>
  Math.min(INDEPENDENT_MAX_SESSIONS, Math.max(INDEPENDENT_MIN_SESSIONS, value))

interface RunIndependentPanelProps {
  view: PoolView
  /** 正在配置新批次（无运行 / 新建批次）。 */
  composing: boolean
  /** 新批次的目标工程。 */
  targetWorkspace?: { name: string; path: string }
  count: number
  busy: boolean
  onCountChange: (count: number) => void
  onChooseWorkspace: () => void
  onNewBatch: () => void
  /** 批次的「会话配置」行（统一的模型与参数）；不提供时不显示（旧调用方）。 */
  modelConfig?: RunBatchConfigProps
}

/**
 * 会话池区。配置中：目标工程 + 会话数量 + 会话配置；运行中：批次概况 + 会话配置 + 新建批次。
 * 协作组在页面下方的卡片网格（`PoolPage`）；创建按钮在席位区底部。
 */
export function RunIndependentPanel({
  view,
  composing,
  targetWorkspace,
  count,
  busy,
  onCountChange,
  onChooseWorkspace,
  onNewBatch,
  modelConfig
}: RunIndependentPanelProps): React.JSX.Element {
  const waiting = view.seats.filter((seat) => seat.state === 'waiting').length
  const working = view.seats.filter((seat) => seat.state === 'working').length
  const ended = view.phase === 'completed'
  // 输入过程中的原始文本：清空、或「1」还没输完成「12」时，不能立刻被钳回去。
  const [typedCount, setTypedCount] = useState<string>()
  const stepCount = (delta: number): void => {
    setTypedCount(undefined)
    onCountChange(clampSessionCount(count + delta))
  }
  /** 直接输入的数量以离开输入框 / 回车为准：越界钳到边界，空值回到当前值。 */
  const commitCount = (raw: string): void => {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) onCountChange(clampSessionCount(parsed))
    setTypedCount(undefined)
  }

  if (composing) {
    return (
      <section className="run-panel run-panel--independent" aria-label="独立批次配置">
        <header className="run-section-head">
          <strong>新批次</strong>
          <span>每个会话先作为独立席位待命；运行中可随时选几个会话建组协作</span>
        </header>

        <div className="run-field">
          <span className="run-field__label">目标工程</span>
          <div className="run-field__value">
            <strong>{targetWorkspace?.name ?? '等待识别 Cursor 工程'}</strong>
            <code title={targetWorkspace?.path}>{targetWorkspace?.path ?? '请先在 Cursor 中打开一个工程'}</code>
          </div>
          <button type="button" className="run-link" disabled={busy} onClick={onChooseWorkspace}>选择工程</button>
        </div>

        {view.cursorWorkspaceChanged && view.pool && !ended ? (
          <p className="run-callout is-warning">
            Cursor 已切换工程：新批次将创建到「{targetWorkspace?.name}」，当前批次所在的「{view.workspace?.name}」会结束。
          </p>
        ) : null}

        <div className="run-field">
          <span className="run-field__label">会话数量</span>
          <div className="run-field__value"><small>{INDEPENDENT_MIN_SESSIONS}–{INDEPENDENT_MAX_SESSIONS} 个，可直接输入</small></div>
          <div className="run-stepper" role="group" aria-label="会话数量">
            <button type="button" aria-label="减少" disabled={busy || count <= INDEPENDENT_MIN_SESSIONS} onClick={() => stepCount(-1)}>−</button>
            <input
              type="number"
              aria-label="会话数量"
              min={INDEPENDENT_MIN_SESSIONS}
              max={INDEPENDENT_MAX_SESSIONS}
              step={1}
              disabled={busy}
              value={typedCount ?? count}
              onChange={(event) => {
                setTypedCount(event.target.value)
                const parsed = Number.parseInt(event.target.value, 10)
                if (parsed >= INDEPENDENT_MIN_SESSIONS && parsed <= INDEPENDENT_MAX_SESSIONS) onCountChange(parsed)
              }}
              onBlur={(event) => commitCount(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') commitCount(event.currentTarget.value) }}
            />
            <button type="button" aria-label="增加" disabled={busy || count >= INDEPENDENT_MAX_SESSIONS} onClick={() => stepCount(1)}>+</button>
          </div>
        </div>

        {modelConfig ? <RunBatchConfig {...modelConfig} disabled={busy || modelConfig.disabled} /> : null}
      </section>
    )
  }

  return (
    <section className="run-panel run-panel--independent" aria-label="独立批次">
      <header className="run-section-head">
        <strong>批次</strong>
        {view.pool ? (
          <span title={formatFullClock(ended ? view.pool.updatedAt : view.pool.createdAt)}>
            {ended ? '结束于' : '创建于'} {formatRelativeClock(ended ? view.pool.updatedAt : view.pool.createdAt)}
          </span>
        ) : null}
      </header>

      <div className="run-batch">
        <span className="run-batch__count"><b>{waiting + working}</b><small>/ {view.seats.length} 在岗</small></span>
        <dl className="run-batch__breakdown">
          <div><dt>待命</dt><dd>{waiting}</dd></div>
          <div><dt>执行中</dt><dd>{working}</dd></div>
          <div><dt>离线</dt><dd>{view.seats.filter((seat) => seat.state === 'offline').length}</dd></div>
          {view.seats.some((seat) => seat.state === 'unconfirmed') ? (
            <div><dt>待确认</dt><dd>{view.seats.filter((seat) => seat.state === 'unconfirmed').length}</dd></div>
          ) : null}
        </dl>
      </div>

      {/* 运行中的批次：改的是每个席位下一次新建 Composer 的配置；结束后席位只作记录，不再提供。 */}
      {modelConfig && !ended ? <RunBatchConfig {...modelConfig} disabled={busy || modelConfig.disabled} /> : null}

      {view.cursorWorkspaceChanged ? (
        <p className="run-callout is-warning">
          Cursor 当前打开的不是本批次的工程「{view.workspace?.name}」；补齐会话仍指向本批次工程，新工程请新建批次。
        </p>
      ) : null}

      <footer className="run-panel__actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onNewBatch}>
          {ended ? '新建批次' : '结束并新建批次'}
        </button>
        <small className="run-panel__hint">
          {ended ? '本批次已结束，可以直接开始新批次' : '新批次会替换当前批次；同一工程只保留一个活跃运行'}
        </small>
      </footer>
    </section>
  )
}
