import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../../../domain/agent-launch'
import type { SessionWarmupRun } from '../../../domain/session-warmup'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import type { DetectedCursorWorkspace } from '../../../domain/cursor-workspace'
import type { TeamControlSnapshot } from '../../../domain/team-control'
import type { CreateIndependentSessionsInput, IndependentWorkspaceSelection } from '../../../shared/desktop-api'
import { BrandMark } from '../BrandMark'
import { cursorModelSelectionFromOption, cursorModelSelectionSummary, normalizeCursorModelSelection, sameCursorModelSelection } from '../cursor-model-selection'
import { describeSelectionSpread, majoritySelection, type RunBatchConfigProps } from './RunBatchConfig'
import { ReplaceRunSheet } from './ReplaceRunSheet'
import { RunHeader } from './RunHeader'
import type { RunGroupActions } from './RunGroupsPanel'
import { RunIndependentPanel, clampSessionCount } from './RunIndependentPanel'
import { RunSeats, type RunSeatRow } from './RunSeats'
import { RunSlot } from './RunSlot'
import {
  buildRunView,
  replaceRunConsequence,
  type ReplaceRunAction,
  type ReplaceRunConsequence
} from './run-view'

export interface RunPageProps {
  team: TeamControlSnapshot
  detectedWorkspace?: DetectedCursorWorkspace
  cursorModels: CursorModelOption[]
  agentLaunchPlan?: AgentLaunchPlan
  externalNotice?: string
  cdpAutoHealEnabled: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  onLaunchAgentSessions: (requests: AgentLaunchRequest[]) => Promise<AgentLaunchPlan>
  /** 会话预热探针状态与开关（批量发起前自动执行；也可单独手动触发）。 */
  sessionWarmupRun?: SessionWarmupRun
  sessionWarmupEnabled?: boolean
  onToggleSessionWarmup?: (enabled: boolean) => void
  onRunSessionWarmup?: () => Promise<void>
  onCreateIndependentSessions: (input: CreateIndependentSessionsInput) => Promise<AgentLaunchPlan>
  onChooseIndependentWorkspace: () => Promise<IndependentWorkspaceSelection | undefined>
  onEndActiveRun: () => Promise<void>
  onOpenSessions: () => void
  onPersistModelSelection?: (channelId: string, selection: CursorModelSelection) => Promise<TeamControlSnapshot>
  onEnableCursorCdp?: () => Promise<{ ok: boolean; message: string; suggestAutoHeal?: boolean }>
  onToggleCdpAutoHeal?: (enabled: boolean) => Promise<void>
  onCancelCdpAutoHealCountdown?: () => Promise<void>
  /** 会话池 · 协作组操作；不提供时运行页不显示协作组区。 */
  groupActions?: RunGroupActions
}

interface PendingSheet {
  consequence: ReplaceRunConsequence
  perform: () => void
}

/** 正在配置的新独立批次；`confirmed` = 进入配置前已经确认过替换当前运行，创建时不再二次守卫。 */
interface ComposeState {
  confirmed: boolean
}

const DEFAULT_INDEPENDENT_COUNT = 3

/**
 * 「运行」页：一个工程一个会话池（独立批次），协作在池内以组的形式建拆。
 * 头部（工程 / 状态 / 结束）→ 批次概况与协作组 → 共用席位区；
 * 所有破坏性动作走同一个 ReplaceRunSheet。没有运行时直接进入批次配置。
 */
export function RunPage({
  team,
  detectedWorkspace,
  cursorModels,
  agentLaunchPlan,
  externalNotice,
  cdpAutoHealEnabled,
  cdpAutoHealEvent,
  onLaunchAgentSessions,
  sessionWarmupRun,
  sessionWarmupEnabled = true,
  onToggleSessionWarmup,
  onRunSessionWarmup,
  onCreateIndependentSessions,
  onChooseIndependentWorkspace,
  onEndActiveRun,
  onOpenSessions,
  onPersistModelSelection,
  onEnableCursorCdp,
  onToggleCdpAutoHeal,
  onCancelCdpAutoHealCountdown,
  groupActions
}: RunPageProps): React.JSX.Element {
  const view = useMemo(() => buildRunView(team, detectedWorkspace), [team, detectedWorkspace])
  const [busy, setBusy] = useState('')
  const actionInFlight = useRef(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [sheet, setSheet] = useState<PendingSheet | null>(null)
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [count, setCount] = useState(DEFAULT_INDEPENDENT_COUNT)
  // `uniform`：批次「会话配置」里显式统一过的那份——配置批次时先统一再加数量，新增的席位也沿用它，而不是退回 Cursor 当前模型。
  const [draftSelections, setDraftSelections] = useState<{ runId?: string; byChannel: Record<string, CursorModelSelection>; uniform?: CursorModelSelection }>({ byChannel: {} })
  // 最近一次统一落地的时刻：席位列表据此泛一次光晕作确认。
  const [syncedAt, setSyncedAt] = useState<number>()
  const [chosenWorkspace, setChosenWorkspace] = useState<{ selection: IndependentWorkspaceSelection; detectedId?: string }>()

  const runId = view.run?.id
  useEffect(() => {
    // 运行身份变化（创建 / 替换）：丢弃针对旧运行的配置、确认与草稿。
    setCompose(null)
    setSheet(null)
    setDraftSelections({ runId, byChannel: {} })
  }, [runId])

  useEffect(() => {
    if (externalNotice) setNotice(externalNotice)
  }, [externalNotice])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6_000)
    return () => clearTimeout(timer)
  }, [notice])

  const run = async <Result,>(name: string, action: () => Promise<Result>): Promise<Result | undefined> => {
    // React 的 disabled 要到下一次提交才生效；同一拍重复点击也只执行一次。
    if (actionInFlight.current || agentLaunchPlan?.state === 'running') return undefined
    actionInFlight.current = true
    setBusy(name)
    setError('')
    setNotice('')
    try {
      return await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    } finally {
      actionInFlight.current = false
      setBusy('')
    }
  }

  /** 破坏性动作统一入口：仍有 live 席位才展开确认面，否则直接执行。 */
  const guard = (action: ReplaceRunAction, perform: () => void): void => {
    if (actionInFlight.current || agentLaunchPlan?.state === 'running') return
    const consequence = replaceRunConsequence(view, action)
    if (!consequence.needsConfirm) {
      perform()
      return
    }
    setSheet({ consequence, perform })
  }

  // ---------- 独立批次配置 ----------
  const composingIndependent = compose !== null || view.phase === 'none'
  const manualWorkspace = chosenWorkspace?.detectedId === detectedWorkspace?.id ? chosenWorkspace?.selection : undefined
  const targetWorkspace = manualWorkspace ?? detectedWorkspace ?? view.workspace
  const composeChannels = useMemo(() => Array.from({ length: count }, (_, index) => String(index + 1)), [count])

  const defaultSelection = cursorModelSelectionFromOption(cursorModels.find((model) => model.selected) ?? cursorModels[0])
  /**
   * 新批次的起点：上一次运行里多数席位的配置——连开几批同样配置时不必每批重选一遍。
   * 没有上一次运行（或它的模型已不在目录里）才退回 Cursor 当前选中的模型。
   */
  const inherited = useMemo(() => majoritySelection(view.seats.map((seat) => {
    const option = seat.modelSelection ? cursorModels.find((model) => model.modelId === seat.modelSelection?.modelId) : undefined
    return seat.modelSelection && option ? normalizeCursorModelSelection(seat.modelSelection, option) : undefined
  })), [cursorModels, view.seats])
  const selections = useMemo(() => {
    const current = draftSelections.runId === runId
    const drafts = current ? draftSelections.byChannel : {}
    const uniform = current ? draftSelections.uniform : undefined
    const channels = composingIndependent ? composeChannels : view.seats.map((seat) => seat.channelId)
    const fallback = (composingIndependent ? inherited : undefined) ?? defaultSelection
    return Object.fromEntries(channels.flatMap((channelId) => {
      const persisted = composingIndependent ? undefined : view.seats.find((seat) => seat.channelId === channelId)?.modelSelection
      const candidate = drafts[channelId] ?? persisted ?? uniform ?? fallback
      if (!candidate) return []
      const option = cursorModels.find((model) => model.modelId === candidate.modelId)
      if (option) return [[channelId, normalizeCursorModelSelection(candidate, option)] as const]
      // 目录还没加载时先什么都不显示；目录里确实没有这个模型，就原样留着，
      // 由摘要行点明「已不在目录」——不要悄悄换成默认模型再被一次「统一」写死。
      return cursorModels.length ? [[channelId, candidate] as const] : []
    }))
  }, [composeChannels, composingIndependent, cursorModels, defaultSelection, draftSelections, inherited, runId, view.seats])

  /**
   * 批次的统一配置基线：显式统一过的那份，否则是被多数席位共用的那份（配置中与运行中同一口径）。
   * 各席已分叉又没有多数，就没有基线（显示分布，提供「统一」）。与基线不同的席位是「单独配置」——
   * 于是「每席都被单独改过」不会再留下一个谁都没在用的基线。已结束的批次只作记录，不再谈配置。
   */
  const independentBatch = composingIndependent || view.phase !== 'completed'
  const batchModel = useMemo(() => {
    const channels = composingIndependent ? composeChannels : view.seats.map((seat) => seat.channelId)
    const explicit = draftSelections.runId === runId ? draftSelections.uniform : undefined
    const explicitOption = explicit ? cursorModels.find((model) => model.modelId === explicit.modelId) : undefined
    const current = channels.map((channelId) => selections[channelId])
    const uniform = explicit && explicitOption
      ? normalizeCursorModelSelection(explicit, explicitOption)
      : majoritySelection(current)
    const option = uniform ? cursorModels.find((model) => model.modelId === uniform.modelId) : undefined
    const overridden = uniform ? channels.filter((channelId) => !sameCursorModelSelection(selections[channelId], uniform)) : []
    // 配置中的基线如果只是沿用来的（Cursor 当前模型 / 上一次运行），行内说明它从哪来。
    const implicitFrom = explicit || !uniform || !composingIndependent ? undefined
      : sameCursorModelSelection(uniform, defaultSelection) ? 'cursor' as const
        : sameCursorModelSelection(uniform, inherited) ? 'previous' as const
          : undefined
    return {
      channels,
      uniform,
      implicitFrom,
      overridden,
      spread: uniform ? undefined : describeSelectionSpread(current),
      fallback: current[0],
      restoreHint: uniform ? `恢复为统一配置：${uniform.displayName} · ${cursorModelSelectionSummary(uniform, option)}` : undefined
    }
  }, [composeChannels, composingIndependent, cursorModels, defaultSelection, draftSelections, inherited, runId, selections, view.seats])
  const overriddenChannels = new Set(independentBatch ? batchModel.overridden : [])

  const seatRows: RunSeatRow[] = composingIndependent
    ? composeChannels.map((channelId) => ({ channelId, name: `会话 ${channelId}`, pending: true, overridden: overriddenChannels.has(channelId) }))
    : view.seats.map((seat) => ({
        channelId: seat.channelId,
        name: seat.name,
        // 池内入组席位显示「组 · 角色」；独立席位不显示角色。
        roleName: seat.solo ? undefined : seat.groupName ? `${seat.groupName} · ${seat.roleName}` : seat.roleName,
        state: seat.state,
        lastSeenAt: seat.lastSeenAt,
        pending: view.phase !== 'completed' && seat.pending,
        overridden: overriddenChannels.has(seat.channelId)
      }))
  const pendingRequests: AgentLaunchRequest[] = view.pendingSeats.map((seat) => ({
    channelId: seat.channelId,
    modelSelection: selections[seat.channelId]
  }))

  const reportPlan = (plan: AgentLaunchPlan, doneNotice: string): void => {
    if (plan.state === 'done') {
      setNotice(doneNotice)
    } else if (plan.items.some((item) => item.code === 'runtime_account_mismatch')) {
      setNotice('会话发起已暂停：请在弹窗中处理 Cursor 登录账号问题后自动继续。')
    } else if (plan.items.some((item) => item.code === 'membership_blocked')) {
      setNotice('会话发起已暂停：当前账号为 Free 档位，请先在「账号与 Cursor」执行「处理」，再于弹窗刷新档位继续。')
    } else if (plan.items.some((item) => item.code === 'warmup_failed')) {
      setError(`预热未通过，已中止批量发起（未消耗自动化配额）：${plan.items.find((item) => item.code === 'warmup_failed')?.message ?? ''}`)
    } else if (plan.items.some((item) => item.code === 'cdp_unavailable')) {
      setNotice('会话创建需要 Cursor 调试端口：点击「重启 Cursor 并启用会话创建」（一次性），完成后重试。')
    } else {
      setError(plan.items.find((item) => item.stage === 'failed')?.message || '部分会话未能创建；可重试，或在 Cursor 手动发起。')
    }
  }

  const createIndependentBatch = (): void => {
    if (!targetWorkspace) return
    const input: CreateIndependentSessionsInput = {
      workspacePath: targetWorkspace.path,
      sessions: composeChannels.map((channelId) => ({ modelSelection: selections[channelId] }))
    }
    const perform = (): void => {
      void run('create-independent', async () => {
        const plan = await onCreateIndependentSessions(input)
        reportPlan(plan, '独立会话已全部进入待命。')
        if (plan.state === 'done') onOpenSessions()
      })
    }
    const replacingLiveRun = Boolean(view.run) && view.phase !== 'completed' && !compose?.confirmed
    if (!replacingLiveRun) {
      perform()
      return
    }
    guard({ kind: 'new-batch', targetWorkspaceName: targetWorkspace.name }, perform)
  }

  const createPendingSessions = (): void => {
    void run('launch-sessions', async () => {
      const plan = await onLaunchAgentSessions(pendingRequests)
      reportPlan(plan, '独立会话已全部进入待命。')
    })
  }

  // ---------- 结束 / 新建 ----------
  /**
   * 进入新批次配置：数量接着上一个批次来，配合沿用来的会话配置，「和上一批一样再来一批」不用重设。
   * 归档的旧团队 run 不作为 run 暴露（`view.seats` 为空），它的角色席位数不会被沿用。
   */
  const beginCompose = (): void => {
    if (view.seats.length) setCount(clampSessionCount(view.seats.length))
    setCompose({ confirmed: true })
  }
  const endRun = (): void => {
    if (view.phase !== 'active') return
    guard({ kind: 'end' }, () => {
      void run('end-run', async () => {
        await onEndActiveRun()
        setCompose(null)
        setNotice('独立批次已结束；旧会话会在下一次轮询自行退出。')
      })
    })
  }
  const newBatch = (): void => {
    guard({ kind: 'new-batch', targetWorkspaceName: view.cursorWorkspaceChanged ? targetWorkspace?.name : undefined }, beginCompose)
  }
  const chooseIndependentWorkspace = (): void => {
    void run('choose-workspace', async () => {
      const selection = await onChooseIndependentWorkspace()
      if (selection) setChosenWorkspace({ selection, detectedId: detectedWorkspace?.id })
    })
  }

  const saveModel = async (channelId: string, selection: CursorModelSelection): Promise<void> => {
    // 已存在的席位先持久化再提交本地状态；失败时弹层保持打开并显示错误。
    if (!composingIndependent && onPersistModelSelection) await onPersistModelSelection(channelId, selection)
    setDraftSelections((current) => ({
      ...(current.runId === runId ? current : { byChannel: {} }),
      runId,
      byChannel: { ...(current.runId === runId ? current.byChannel : {}), [channelId]: structuredClone(selection) }
    }))
  }

  /**
   * 统一配置：同一份写到每个席位，并成为批次基线。已存在的席位逐个持久化——
   * 本就是这套配置的席位跳过（16 席常常只有一两席真需要写），中途失败即停，
   * 错误里带上已经落库几席，弹层留在原地。
   */
  const saveModelForAll = async (channelIds: string[], selection: CursorModelSelection): Promise<void> => {
    if (!composingIndependent && onPersistModelSelection) {
      const targets = channelIds.filter((channelId) => !sameCursorModelSelection(selections[channelId], selection))
      let applied = 0
      for (const channelId of targets) {
        try {
          await onPersistModelSelection(channelId, selection)
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason)
          throw new Error(`${detail}（${targets.length} 席里已应用 ${applied} 席，其余保持原配置）`)
        }
        applied += 1
      }
    }
    setDraftSelections((current) => ({
      runId,
      uniform: structuredClone(selection),
      byChannel: {
        ...(current.runId === runId ? current.byChannel : {}),
        ...Object.fromEntries(channelIds.map((channelId) => [channelId, structuredClone(selection)]))
      }
    }))
    setSyncedAt(Date.now())
  }

  /** 单独配置的席位恢复到批次基线：配置中只需丢掉草稿；运行中把基线写回该席位（失败走页面提示条）。 */
  const resetModelToUniform = async (channelId: string): Promise<void> => {
    const uniform = batchModel.uniform
    if (!uniform) return
    await run('reset-model', async () => {
      if (!composingIndependent && onPersistModelSelection) await onPersistModelSelection(channelId, uniform)
      setDraftSelections((current) => {
        const byChannel = { ...(current.runId === runId ? current.byChannel : {}) }
        if (composingIndependent) delete byChannel[channelId]
        else byChannel[channelId] = structuredClone(uniform)
        return { ...(current.runId === runId ? current : {}), runId, byChannel }
      })
    })
  }

  const batchModelConfig: RunBatchConfigProps | undefined = independentBatch ? {
    models: cursorModels,
    seatCount: batchModel.channels.length,
    uniform: batchModel.uniform,
    implicitFrom: batchModel.implicitFrom,
    overriddenCount: batchModel.overridden.length,
    // 运行中的席位已经各自开着会话：改配置不会换掉正在跑的那个 Composer。
    hint: composingIndependent ? undefined : '改动作用于下一次新建会话',
    spread: batchModel.spread,
    fallback: batchModel.fallback,
    disabled: agentLaunchPlan?.state === 'running',
    onSave: (selection) => saveModelForAll(batchModel.channels, selection)
  } : undefined

  const enableCdp = onEnableCursorCdp ? () => void run('enable-cdp', async () => {
    const result = await onEnableCursorCdp()
    if (result.ok) {
      setNotice(result.suggestAutoHeal
        ? `${result.message}。建议打开「自动保持」开关，此后 Cursor 重启不再丢失该设置。`
        : `${result.message}，Cursor 完全启动后再点创建。`)
    } else {
      setError(result.message)
    }
  }) : undefined
  const toggleAutoHeal = onToggleCdpAutoHeal ? (enabled: boolean) => void run('cdp-autoheal', async () => {
    await onToggleCdpAutoHeal(enabled)
    setNotice(enabled ? '自动保持已开启：此后检测到端口缺失会提示并自动处理。' : '自动保持已关闭。')
  }) : undefined

  const createLabel = composingIndependent
    ? `创建 ${count} 个独立会话`
    : `补齐会话（${view.pendingSeats.length}）`
  const relevantPlan = agentLaunchPlan && (composingIndependent || !view.run || agentLaunchPlan.startedAt >= view.run.createdAt)
    ? agentLaunchPlan
    : undefined
  const isBusy = Boolean(busy) || agentLaunchPlan?.state === 'running'
  const feedback = error || notice
  const feedbackStrip = feedback ? (
    <p className={`run-feedback${error ? ' is-error' : ''}`} role="status" aria-live="polite">
      <i aria-hidden="true" />
      <span>{feedback}</span>
      <button type="button" aria-label="关闭提示" onClick={() => { setError(''); setNotice('') }}>×</button>
    </p>
  ) : null

  const seats = (seatRows.length > 0 || composingIndependent) && (composingIndependent ? Boolean(targetWorkspace) : true) ? (
    <RunSeats
      rows={seatRows}
      cursorModels={cursorModels}
      selections={selections}
      plan={relevantPlan}
      busy={isBusy}
      createLabel={createLabel}
      createBlockedReason={!composingIndependent && view.evidencePending ? '正在确认离线会话的运行状态，确认完成后开放安全重建' : undefined}
      ended={!composingIndependent && view.phase === 'completed'}
      cdpAutoHealEnabled={cdpAutoHealEnabled}
      cdpAutoHealEvent={cdpAutoHealEvent}
      warmupRun={sessionWarmupRun}
      warmupEnabled={sessionWarmupEnabled}
      onToggleWarmup={onToggleSessionWarmup}
      onRunWarmup={onRunSessionWarmup ? () => void run('warmup', onRunSessionWarmup) : undefined}
      onCreate={composingIndependent ? createIndependentBatch : createPendingSessions}
      onModelSave={saveModel}
      onModelSaveAll={saveModelForAll}
      onModelReset={independentBatch && batchModel.uniform ? resetModelToUniform : undefined}
      restoreHint={batchModel.restoreHint}
      syncedAt={syncedAt}
      onEnableCdp={enableCdp}
      onToggleAutoHeal={toggleAutoHeal}
      onCancelCountdown={onCancelCdpAutoHealCountdown ? () => void onCancelCdpAutoHealCountdown() : undefined}
    />
  ) : null

  if (view.phase === 'none') {
    return (
      <div className="run-page">
        <div className="run-page__inner">
          <section className="run-start" aria-label="开始运行">
            <div className="run-start__intro">
              <span className="run-start__mark"><BrandMark /></span>
              <h1>开始一次运行</h1>
              <p>
                {detectedWorkspace
                  ? <>Cursor 当前打开的工程：<strong title={detectedWorkspace.path}>{detectedWorkspace.name}</strong></>
                  : '先在 Cursor 中打开一个工程，或在下方手动选择。'}
              </p>
              {view.archivedLegacyTeam ? (
                <p className="run-start__note">{view.state.label}：{view.state.hint}</p>
              ) : null}
            </div>
            <RunSlot>{feedbackStrip}</RunSlot>
          </section>
          <div className="run-body">
            <RunIndependentPanel
              view={view}
              composing
              targetWorkspace={targetWorkspace}
              count={count}
              busy={isBusy}
              onCountChange={setCount}
              onChooseWorkspace={chooseIndependentWorkspace}
              onNewBatch={newBatch}
              modelConfig={batchModelConfig}
            />
            {seats ?? <div className="run-empty">Cursor 工程识别完成后即可配置独立会话。</div>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="run-page">
      <div className="run-page__inner">
      <RunHeader
        view={view}
        busy={isBusy}
        busyAction={busy}
        onEnd={endRun}
        onOpenSessions={onOpenSessions}
      />

      <RunSlot>
        {compose ? (
          <div className="run-banner is-amber" role="status">
            <i aria-hidden="true" />
            <span>
              正在配置新的独立批次
              {view.phase === 'completed'
                ? '：在下方选好数量与模型后创建。'
                : '：创建后当前独立批次结束，旧会话在下一次轮询自行退出。'}
            </span>
            <button type="button" disabled={isBusy} onClick={() => setCompose(null)}>放弃</button>
          </div>
        ) : null}
      </RunSlot>

      <RunSlot>
        {sheet ? (
          <ReplaceRunSheet
            consequence={sheet.consequence}
            busy={isBusy}
            onCancel={() => setSheet(null)}
            onConfirm={() => { const { perform } = sheet; setSheet(null); perform() }}
          />
        ) : null}
      </RunSlot>

      <RunSlot>{feedbackStrip}</RunSlot>

      <div className="run-body" key={composingIndependent ? 'compose' : 'pool'}>
        {composingIndependent ? (
          <RunIndependentPanel
            view={view}
            composing
            targetWorkspace={targetWorkspace}
            count={count}
            busy={isBusy}
            onCountChange={setCount}
            onChooseWorkspace={chooseIndependentWorkspace}
            onNewBatch={newBatch}
            modelConfig={batchModelConfig}
          />
        ) : (
          <RunIndependentPanel
            view={view}
            composing={false}
            count={count}
            busy={isBusy}
            onCountChange={setCount}
            onChooseWorkspace={chooseIndependentWorkspace}
            onNewBatch={newBatch}
            groupActions={groupActions}
            modelConfig={batchModelConfig}
          />
        )}
        {seats}
      </div>
      </div>
    </div>
  )
}
