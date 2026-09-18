import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AgentLaunchPlan } from '../../../domain/agent-launch'
import type { SessionWarmupRun } from '../../../domain/session-warmup'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import { cursorModelSelectionFromOption, cursorModelSelectionSummary } from '../cursor-model-selection'
import { formatRelativeTime } from '../format'
import { CursorModelConfigDialog } from '../lobby/CursorModelConfigDialog'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { SEAT_STATE_LABEL, type RunSeatState } from './run-view'

/** 统一配置落地后行内光晕的时长：最后一行的延迟 + 动画本身（见 run.css 的 run-seat-sync）。 */
const SYNC_PULSE_MS = 1_600

export interface RunSeatRow {
  channelId: string
  name: string
  /** 团队席位显示角色；独立席位不显示。 */
  roleName?: string
  /** 配置中的新席位没有运行态。 */
  state?: RunSeatState
  lastSeenAt?: number
  /** 本次创建的目标（未待命 / 待创建）。 */
  pending: boolean
  /** 与批次「会话配置」不同的席位：行内标「单独配置」，可就地恢复。 */
  overridden?: boolean
}

interface RunSeatsProps {
  rows: RunSeatRow[]
  cursorModels: CursorModelOption[]
  selections: Record<string, CursorModelSelection>
  plan?: AgentLaunchPlan
  busy: boolean
  /** 主按钮文案由页面按模式与阶段决定（批量创建 / 补齐 / 一键创建）。 */
  createLabel: string
  /** 非空时禁用创建并解释原因（例如仍在确认离线会话的运行状态）。 */
  createBlockedReason?: string
  /** 运行已结束：席位只作记录展示，不再提供创建。 */
  ended?: boolean
  cdpAutoHealEnabled: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  /** 会话预热探针：发起前自动执行的开关与最近一次结果；也可单独手动触发。 */
  warmupRun?: SessionWarmupRun
  warmupEnabled?: boolean
  onToggleWarmup?: (enabled: boolean) => void
  onRunWarmup?: () => void
  onCreate: () => void
  onModelSave: (channelId: string, selection: CursorModelSelection) => Promise<void> | void
  /** 一份配置写到多个席位（单席弹层「同时应用到其余席位」）；缺省时逐席位调用 onModelSave。 */
  onModelSaveAll?: (channelIds: string[], selection: CursorModelSelection) => Promise<void> | void
  /** 把「单独配置」的席位恢复为批次的统一配置；不提供时行内只标记、不提供恢复。 */
  onModelReset?: (channelId: string) => Promise<void> | void
  /** 恢复动作的说明（会恢复成哪一套配置），作为「单独配置」标的悬停提示。 */
  restoreHint?: string
  /** 页面上一次把统一配置铺到全部席位的时刻：变化时每一行泛一次光晕作确认。 */
  syncedAt?: number
  onEnableCdp?: () => void
  onToggleAutoHeal?: (enabled: boolean) => void
  onCancelCountdown?: () => void
}

/**
 * 席位区：一个列表——通道、名字 / 组内角色、模型、运行态。
 * 点击一行改该席位下一次创建会话用的模型，弹层里可顺带同步到其余席位；
 * 与批次统一配置不同的席位标「单独配置」，点 × 恢复；底部一个创建按钮只针对未待命席位。
 */
export function RunSeats({
  rows,
  cursorModels,
  selections,
  plan,
  busy,
  createLabel,
  createBlockedReason,
  ended = false,
  cdpAutoHealEnabled,
  cdpAutoHealEvent,
  warmupRun,
  warmupEnabled = true,
  onToggleWarmup,
  onRunWarmup,
  onCreate,
  onModelSave,
  onModelSaveAll,
  onModelReset,
  restoreHint,
  syncedAt,
  onEnableCdp,
  onToggleAutoHeal,
  onCancelCountdown
}: RunSeatsProps): React.JSX.Element {
  const launching = plan?.state === 'running'
  const needsCdp = !launching && Boolean(plan?.items.some((item) => item.code === 'cdp_unavailable'))
  const pendingCount = rows.filter((row) => row.pending).length
  const [countdownLeft, setCountdownLeft] = useState(0)
  const [editing, setEditing] = useState<string>()
  const [syncPulse, setSyncPulse] = useState(false)
  const seenSyncedAt = useRef(syncedAt)
  const configurable = !launching && cursorModels.length > 0
  // 两席起才谈得上「同步其余席位」；运行结束后席位只作记录，不再提供。
  const syncable = configurable && !ended && rows.length > 1
  const channelIds = rows.map((row) => row.channelId)
  const fallbackSelection = cursorModelSelectionFromOption(cursorModels.find((model) => model.selected) ?? cursorModels[0])

  useEffect(() => {
    if (!syncPulse) return
    const timer = setTimeout(() => setSyncPulse(false), SYNC_PULSE_MS)
    return () => clearTimeout(timer)
  }, [syncPulse])

  // 批次「会话配置」在页面层落地：这里只负责把确认光晕放出来（挂载时已有的时刻不算）。
  useEffect(() => {
    if (syncedAt === undefined || syncedAt === seenSyncedAt.current) return
    seenSyncedAt.current = syncedAt
    setSyncPulse(true)
  }, [syncedAt])

  /** 一份配置写到所有席位；成功后行内自上而下泛一次光晕作确认。 */
  const saveForAll = async (selection: CursorModelSelection): Promise<void> => {
    if (onModelSaveAll) {
      await onModelSaveAll(channelIds, selection)
    } else {
      for (const channelId of channelIds) await onModelSave(channelId, selection)
    }
    setSyncPulse(true)
  }

  useEffect(() => {
    if (cdpAutoHealEvent?.phase !== 'countdown') {
      setCountdownLeft(0)
      return
    }
    const update = (): void => setCountdownLeft(Math.max(0, Math.ceil((cdpAutoHealEvent.deadlineAt - Date.now()) / 1_000)))
    update()
    const timer = setInterval(update, 250)
    return () => clearInterval(timer)
  }, [cdpAutoHealEvent])

  const planByChannel = new Map(plan?.items.map((item) => [item.channelId, item] as const) ?? [])

  return (
    <section className="run-seats" aria-label="席位">
      <header className="run-section-head">
        <strong>席位</strong>
        <span>{ended ? `${rows.length} 席 · 运行已结束` : pendingCount ? `${pendingCount} / ${rows.length} 待创建会话` : rows.length ? '全部在岗' : '尚无席位'}</span>
      </header>

      <ul className="run-seats__list" aria-label="逐会话模型配置">
        {rows.map((row, index) => {
          const selection = selections[row.channelId]
          const option = cursorModels.find((model) => model.modelId === selection?.modelId)
          const progress = planByChannel.get(row.channelId)
          return (
            <li
              key={row.channelId}
              className={`run-seat${row.pending ? ' is-pending' : ''}${row.state ? ` is-${row.state}` : ''}${syncPulse ? ' is-synced' : ''}`}
              style={{ '--seat-index': Math.min(index, 8) } as CSSProperties}
            >
              <button
                type="button"
                aria-label={`配置 CH-${row.channelId} 会话`}
                className="run-seat__main"
                disabled={!configurable}
                onClick={() => setEditing(row.channelId)}
              >
                <b className="run-seat__channel">CH-{row.channelId}</b>
                <span className="run-seat__who">
                  <strong>{row.name}</strong>
                  {row.roleName && row.roleName !== row.name ? <small>{row.roleName}</small> : null}
                </span>
                <span className="run-seat__model">
                  <strong>{selection?.displayName ?? 'Cursor 当前模型'}</strong>
                  <small>{cursorModelSelectionSummary(selection, option)}</small>
                </span>
                <i aria-hidden="true">›</i>
              </button>
              {row.overridden ? (
                // 可撤销的标：这一席与批次统一配置不同；× 就地恢复。按钮不能嵌在行主按钮里，所以是行的兄弟节点。
                <em className="run-seat__override" title={restoreHint}>
                  <span>单独配置</span>
                  {onModelReset ? (
                    <button
                      type="button"
                      aria-label={`恢复 CH-${row.channelId} 为统一配置`}
                      disabled={!configurable || busy}
                      onClick={() => void onModelReset(row.channelId)}
                    >×</button>
                  ) : null}
                </em>
              ) : null}
              <span className="run-seat__state">
                {progress && (launching || progress.stage === 'failed') ? (
                  <em className={`run-seat__progress is-${progress.stage}`} title={progress.message}>{progress.message}</em>
                ) : row.state ? (
                  <em className={`run-seat__badge is-${row.state}`}>
                    <i aria-hidden="true" />{SEAT_STATE_LABEL[row.state]}
                    {row.state === 'unconfirmed' ? <small>尚无工具调用证据</small> : row.lastSeenAt ? <small>{formatRelativeTime(row.lastSeenAt)}</small> : null}
                  </em>
                ) : (
                  <em className="run-seat__badge is-new"><i aria-hidden="true" />待创建</em>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {plan?.state === 'failed' && !needsCdp ? (
        <p className="run-seats__hint">可重试失败的通道；也可以在 Cursor 中手动发起，拾光检测到待命后会自动接管。</p>
      ) : null}

      {needsCdp && onEnableCdp ? (
        <div className="run-seats__cdp is-required" role="alert">
          <span>会话创建需要 Cursor 开启调试端口（一次性设置）。</span>
          <button type="button" className="secondary-button" disabled={busy || launching} onClick={onEnableCdp}>重启 Cursor 并启用会话创建</button>
        </div>
      ) : null}
      {cdpAutoHealEvent?.phase === 'countdown' ? (
        <div className="run-seats__cdp is-countdown" role="alert">
          <span>检测到 Cursor 未启用会话创建端口，{countdownLeft} 秒后将自动重启并打开当前工作区。</span>
          <button type="button" className="secondary-button" onClick={onCancelCountdown}>取消本次自动重启</button>
        </div>
      ) : null}
      {cdpAutoHealEvent?.phase === 'restarting' ? (
        <div className="run-seats__cdp is-working" role="status">正在优雅重启 Cursor、打开工作区并启用会话创建端口…</div>
      ) : null}

      <footer className="run-seats__footer">
        <span className="run-seats__toggles">
          {onToggleAutoHeal ? (
            <ToggleSwitch checked={cdpAutoHealEnabled} disabled={busy} onChange={(enabled) => void onToggleAutoHeal(enabled)}>
              <span className="run-guard__copy">
                <strong>自动保持会话创建端口</strong>
                <small>检测到端口缺失时，倒计时后自动重启 Cursor 并启用</small>
              </span>
            </ToggleSwitch>
          ) : null}
          {onToggleWarmup ? (
            <ToggleSwitch checked={warmupEnabled} disabled={busy} onChange={(enabled) => void onToggleWarmup(enabled)}>
              <span className="run-guard__copy">
                <strong>发起前预热探路</strong>
                <small>先用最低成本模型验证账号能跑通响应，未通过则中止</small>
              </span>
            </ToggleSwitch>
          ) : null}
          {!onToggleAutoHeal && !onToggleWarmup ? <span /> : null}
        </span>
        <span className="run-seats__create">
          {warmupRun && warmupEnabled ? (
            <span
              className={`run-warmup-status is-${warmupRun.phase === 'done' ? (warmupRun.slow ? 'slow' : 'done') : warmupRun.phase === 'failed' ? 'failed' : 'running'}`}
              role={warmupRun.phase === 'failed' ? 'alert' : 'status'}
              aria-live="polite"
            >
              <i aria-hidden="true" />
              <span className="run-warmup-status__text" title={warmupRun.message}>{warmupRun.message}</span>
            </span>
          ) : null}
          {createBlockedReason ? <small>{createBlockedReason}</small> : null}
          {ended ? (
            <small>席位随新批次重新创建</small>
          ) : pendingCount === 0 && !launching ? (
            <small className="run-seats__settled">所有席位已在岗，无需创建会话</small>
          ) : (
            <>
              {onRunWarmup ? (
                <button
                  type="button"
                  className="secondary-button run-warmup-button"
                  disabled={busy || launching || Boolean(createBlockedReason) || warmupRun?.phase === 'creating' || warmupRun?.phase === 'waiting'}
                  title="单独预热一次：验证当前账号能跑通模型响应，不创建席位会话"
                  onClick={onRunWarmup}
                >{warmupRun?.phase === 'creating' || warmupRun?.phase === 'waiting' ? '预热中…' : '立即预热'}</button>
              ) : null}
              <button
                type="button"
                className="primary-button"
                disabled={busy || launching || Boolean(createBlockedReason)}
                onClick={onCreate}
              >{launching ? '创建中…' : createLabel}</button>
            </>
          )}
        </span>
      </footer>

      {editing ? (
        <CursorModelConfigDialog
          scope={{ kind: 'seat', channelId: editing, othersCount: syncable ? rows.length - 1 : 0 }}
          disabled={launching}
          models={cursorModels}
          selection={selections[editing] ?? fallbackSelection}
          onSave={(selection, { applyToAll }) => (applyToAll ? saveForAll(selection) : onModelSave(editing, selection))}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  )
}
