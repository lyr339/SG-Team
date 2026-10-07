import { TeamMemoryInspectionDialog } from './notifications/TeamMemoryInspectionDialog'
import type { TeamMemoryInspection,TeamMemoryInspectionRequest } from '../../domain/team-memory-inspection'
import { memoryInspectionMatches } from '../../domain/team-memory-inspection'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QuestionActions } from './QuestionCard'
import type {
  CreateIndependentSessionsInput,
  DesktopSnapshot
} from '../../shared/desktop-api'
import { emptyTaskPoolSnapshot, newestTaskPoolSnapshot } from '../../domain/task-pool'
import type { NotificationScope, NotificationTarget } from '../../domain/notification'
import { notificationTargetAvailable } from './notifications/notification-navigation'
import { replyBodyDigest } from './notifications/reply-body-digest'
import { replyBodyMaterial } from '../../domain/reply-body-proof'
import { nativeAssistantEntry } from '../../domain/native-assistant-entry'
import { cssEscape, requestReveal } from './inspector/reveal-bus'
import { groupContextView } from './team/group-context-view'
import { submitGroupTask } from './team/group-task-submit'
import { GroupCollaborationDialog } from './team/GroupCollaborationDialog'
import { collaborationMapFacts, groupCommunicationSummaries } from './team/collaboration-map-view'
import type { CursorUsageSnapshot } from '../../domain/cursor-usage'
import { emptyTeamControlSnapshot, type TeamMemberView, type TeamRunStatus } from '../../domain/team-control'
import { emptyTeamCollaborationSnapshot } from '../../domain/team-collaboration'
import { DesktopShell, type AppModule } from './DesktopShell'
import { SessionOverview } from './SessionOverview'
import { SessionWorkspace } from './SessionWorkspace'
import { SessionSidebar, type RailSelectionActions } from './SessionSidebar'
import type { RailGroupSource } from './session-rail-view'
import { WorkspaceInspector } from './WorkspaceInspector'
import { PoolPage } from './run/PoolPage'
import { GroupComposer, type GroupComposerMode } from './run/GroupComposer'
import { nextGroupName, ungroupedSeatsOf } from './run/pool-view'
import { SettingsPage } from './settings/SettingsPage'
import type { SettingsPageProps } from './settings/settings-view'
import type { SettingsNoticeMessage } from './settings/SettingsNotice'
import { TransferMembershipDialog } from './team/TransferMembershipDialog'
import { SessionHandoffDialog } from './SessionHandoffDialog'
import { resolveHandoffEntry } from './handoff-entry'
import type { MembershipTransferOptions, MembershipTransferOutcome } from '../../domain/team-handoff'
import type { CursorAccountMetadata, CursorRuntimeAccountMatch } from '../../domain/cursor-account'
import type { CursorMembershipStatus } from '../../domain/cursor-membership'
import type { CursorUpdatePreferences } from '../../domain/cursor-update'
import type { CursorSwitchPumpStatus } from '../../domain/cursor-switch-pump'
import type { NotificationReference } from '../../domain/notification-reference'
import { pageOperationDisplay } from './notifications/page-operation-display'
import type { CursorStorageCleanupResult, CursorStorageScan } from '../../domain/cursor-storage-cleanup'
import type {
  ProcessingCredentialStatus,
  ProcessingProgressEvent,
  ProcessingProviderId
} from '../../domain/processing-provider'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../../domain/agent-launch'
import type { SessionWarmupRun } from '../../domain/session-warmup'
import type { AccountAutomationRun, AccountAutomationSettings } from '../../domain/account-automation'
import type { CdpAutoHealEvent } from '../../domain/cursor-cdp'
import type { MessageAttachment } from '../../domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../../domain/workspace-review'
import { requestReviewFocus, type ReviewFocusRequest } from './inspector/review-focus-bus'
import { buildTurnFilesView, sameTurnFilesView, type TurnFilesView } from './turn-files-view'
import { mergeDesktopSnapshot, snapshotGaps } from './snapshot-sharing'
import { userFacingErrorMessage } from './error-message'
import { resolveRuntimeLaunchGate } from './lobby/runtime-account-gate'
import { RuntimeAccountGuardDialog } from './lobby/RuntimeAccountGuardDialog'
import { resolveMembershipLaunchGate } from './lobby/membership-gate'
import { MembershipGuardDialog } from './lobby/MembershipGuardDialog'
import type { CursorWorkspaceDetection } from '../../domain/cursor-workspace'
import {
  applyAppearancePreferences,
  isDiscreteAppearanceChange,
  persistAppearancePreferences,
  readAppearancePreferences,
  type AppearancePreferences
} from './appearance-preferences'

const EMPTY_SNAPSHOT: DesktopSnapshot = {
  connection: {
    state: 'connected',
    endpoint: 'shiguang://local-channel-runtime',
    attempt: 0,
    lastError: ''
  },
  sessions: [],
  conversations: {},
  protocolIssues: [],
  // 必须为 0：任何真实快照（含主进程启动早于渲染器的初始快照）都应通过 updatedAt 守卫。
  updatedAt: 0
}

const LAST_SESSION_STORAGE_KEY = 'shiguang.lastSessionChannel.v1'

function readLastSessionChannel(): string | undefined {
  try {
    const channelId = localStorage.getItem(LAST_SESSION_STORAGE_KEY)?.trim()
    return channelId && /^\d+$/.test(channelId) ? channelId : undefined
  } catch {
    return undefined
  }
}

function persistLastSessionChannel(channelId: string): void {
  try {
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, channelId)
  } catch { /* 本次运行内仍保留当前会话。 */ }
}

const SESSION_WARMUP_STORAGE_KEY = 'shiguang.session-warmup.v1'

/** 「发起前预热」开关：默认开启；渲染层本地持久化（与账号自动化设置解耦，批量/独立发起都生效）。 */
function readSessionWarmupEnabled(): boolean {
  try {
    return localStorage.getItem(SESSION_WARMUP_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

function persistSessionWarmupEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SESSION_WARMUP_STORAGE_KEY, enabled ? '1' : '0')
  } catch { /* 本次运行内仍保留当前选择。 */ }
}

function cursorWorkspaceFingerprint(detection?: CursorWorkspaceDetection): string {
  if (!detection) return ''
  return JSON.stringify({
    state: detection.state,
    workspace: detection.workspace && {
      id: detection.workspace.id,
      name: detection.workspace.name,
      path: detection.workspace.path,
      cursorWorkspaceId: detection.workspace.cursorWorkspaceId
    },
    candidates: detection.candidates.map((candidate) => candidate.id),
    detail: detection.detail
  })
}

// 会话对象指纹与快照结构共享：见 snapshot-sharing.ts（独立模块，含单测）。
export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)
  const [taskPool, setTaskPool] = useState(emptyTaskPoolSnapshot())
  /** Cursor 会话用量（composerId → 累积 token/费用估算；主进程推送）。 */
  const [cursorUsage, setCursorUsage] = useState<CursorUsageSnapshot>({})
  const [teamControl, setTeamControl] = useState(emptyTeamControlSnapshot())
  const [collaboration, setCollaboration] = useState(emptyTeamCollaborationSnapshot())
  // URL hash 深链接优先；日常启动默认直达会话工作区。`lobby` / `config` 是运行页的旧别名。
  const [activeModule, setActiveModule] = useState<AppModule>(() => {
    const [module] = window.location.hash.slice(1).split(':')
    if (module === 'run' || module === 'lobby' || module === 'config') return 'run'
    return module === 'account' ? 'account' : 'sessions'
  })
  const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>(() => {
    const [module, channel] = window.location.hash.slice(1).split(':')
    return module === 'sessions' && channel ? channel : readLastSessionChannel()
  })
  const [sessionListRequested, setSessionListRequested] = useState(false)
  const [teamNotice, setTeamNotice] = useState('')
  const [handoffOptions, setHandoffOptions] = useState<MembershipTransferOptions>()
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [cursorAccounts, setCursorAccounts] = useState<CursorAccountMetadata[]>([])
  const [cursorAccountBusy, setCursorAccountBusy] = useState(false)
  const [cursorAccountNotice, setCursorAccountNotice] = useState<SettingsNoticeMessage>()
  const reportCursorAccountError = useCallback((title: string, reason: unknown, section: 'accounts' | 'import' = 'accounts', notification?: import('../../domain/notification-reference').NotificationReference): void => {
    setCursorAccountNotice({ tone: 'error', title, detail: userFacingErrorMessage(reason), section, ...(notification ? { notification } : {}) })
  }, [])
  // 升级 Pro 结账结果反馈（待扫码/复核通过/失败原因）；按账号粒度置忙在组件内。
  const [proUpgradeFeedback, setProUpgradeFeedback] = useState<{ ok: boolean; message: string; pending?: boolean; notification?: NotificationReference } | null>(null)
  const [cursorUpdatePreferences, setCursorUpdatePreferences] = useState<CursorUpdatePreferences>()
  const [cursorUpdateBusy, setCursorUpdateBusy] = useState(false)
  const [cursorUpdateError, setCursorUpdateError] = useState('')
  // 切号补丁（无感换号依赖）：状态卡只读检测 + 一键安装/卸载
  const [switchPumpStatus, setSwitchPumpStatus] = useState<CursorSwitchPumpStatus>()
  const [switchPumpBusy, setSwitchPumpBusy] = useState(false)
  const [switchPumpFeedback, setSwitchPumpFeedback] = useState<{ ok: boolean; message: string; pending?: boolean; notification?: NotificationReference }>()
  const switchPumpReadSequence = useRef(0)
  const refreshSwitchPumpStatus = useCallback(async (): Promise<void> => {
    const sequence = ++switchPumpReadSequence.current
    const status = await window.sgDesktop.getCursorSwitchPumpStatus()
    if (sequence === switchPumpReadSequence.current) setSwitchPumpStatus(status)
  }, [])
  // 存储清理：盘点结果只来自主进程；清理结果自带清理后的新盘点
  const [storageScan, setStorageScan] = useState<CursorStorageScan>()
  const [storageScanBusy, setStorageScanBusy] = useState(false)
  const [storageScanError, setStorageScanError] = useState('')
  const [storageCleanupBusy, setStorageCleanupBusy] = useState(false)
  const [storageCleanupResult, setStorageCleanupResult] = useState<CursorStorageCleanupResult>()
  const [processingStatuses, setProcessingStatuses] = useState<Record<ProcessingProviderId, ProcessingCredentialStatus>>({
    aozai: { providerId: 'aozai', label: '奥仔', unit: 'points', saved: false },
    henxin: { providerId: 'henxin', label: '痕心', unit: 'uses', saved: false }
  })
  const [processingBusy, setProcessingBusy] = useState(false)
  const [processingError, setProcessingError] = useState<{ providerId: ProcessingProviderId; message: string } | null>(null)
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgressEvent | null>(null)
  const [processingFeedback, setProcessingFeedback] = useState<{ providerId: ProcessingProviderId; ok: boolean; message: string; originSection?: 'accounts' | 'aozai'; notification?: import('../../domain/notification-reference').NotificationReference } | null>(null)
  const [agentLaunchPlan, setAgentLaunchPlan] = useState<AgentLaunchPlan | undefined>(undefined)
  // 会话预热探针：批量发起前用最低成本模型验证账号能真实跑通响应（绝不触发账号自动化）。
  const [sessionWarmupRun, setSessionWarmupRun] = useState<SessionWarmupRun | undefined>(undefined)
  const [sessionWarmupEnabled, setSessionWarmupEnabled] = useState<boolean>(() => readSessionWarmupEnabled())
  const [accountAutomationSettings, setAccountAutomationSettings] = useState<AccountAutomationSettings>({ enabled: false, delaySec: 30, postProcessDelaySec: 30, processingProvider: 'aozai' })
  const [accountAutomationRun, setAccountAutomationRun] = useState<AccountAutomationRun | undefined>(undefined)
  // 指纹浏览器窗口列表（账号自动化链的浏览器宿主；用户按当次网络选「代理/直连」窗口。
  // 提供方恒 RoxyBrowser，与平台无关）
  const [bitProfiles, setBitProfiles] = useState<Array<{ id: string; name: string; seq?: number }>>([])
  const [bitProfilesMessage, setBitProfilesMessage] = useState('')
  // Roxy API Key 状态（双平台展示掩码——提供方恒 Roxy）
  const [roxyApiKeyStatus, setRoxyApiKeyStatus] = useState<{ saved: boolean; maskedKey?: string }>({ saved: false })
  const [cursorWorkspace, setCursorWorkspace] = useState<CursorWorkspaceDetection>()
  const [teamControlLoaded, setTeamControlLoaded] = useState(false)
  // 输入框草稿与附件按通道保存：切换 Agent 不丢失，回来可直接继续编辑/发送。
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({})
  const [composerAttachments, setComposerAttachments] = useState<Record<string, MessageAttachment[]>>({})
  // CDP 自动保持（auto-heal）：开关状态 + 看门事件（倒计时提示）。
  const [cdpAutoHealEnabled, setCdpAutoHealEnabled] = useState(false)
  const [cdpAutoHealEvent, setCdpAutoHealEvent] = useState<CdpAutoHealEvent>()
  const [appearance, setAppearance] = useState<AppearancePreferences>(() => readAppearancePreferences())
  const activeRunRef = useRef<{ id?: string; status?: TeamRunStatus }>({})
  const activeWorkspace = teamControl.workspaces.find((workspace) => workspace.id === teamControl.activeWorkspaceId)
  const activeProjectName = activeWorkspace?.name ?? cursorWorkspace?.workspace?.name
  const memberChannelIds = teamControl.members
    .map((member) => member.binding?.channelId ?? member.slot.channelId)
    .filter((channelId): channelId is string => Boolean(channelId))

  useEffect(() => {
    applyAppearancePreferences(appearance)
    persistAppearancePreferences(appearance)
  }, [appearance])

  /**
   * 外观更新单入口。离散换肤（主题色 / 深浅模式）用 View Transition 做全站交叉淡化：
   * transition 快照之间同步写 :root 变量（effect 里的再写同值幂等），
   * React 驱动的 swatch 选中环等 UI 在淡化中随下一帧落地。
   * 透明度滑杆连续拖动不拍快照（见 isDiscreteAppearanceChange）。
   */
  const changeAppearance = useCallback((patch: Partial<AppearancePreferences>): void => {
    const next = { ...appearance, ...patch }
    setAppearance(next)
    if (!isDiscreteAppearanceChange(patch)) return
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || typeof document.startViewTransition !== 'function') return
    document.startViewTransition(() => applyAppearancePreferences(next))
  }, [appearance])

  // Windows 标题栏覆盖层是系统原生绘制，读不到 CSS 主题：每次主题生效时推送
  // 实际深浅色；system 模式跟随系统切换实时更新（CSS 侧 light-dark() 自动，
  // 覆盖层必须经 JS 同步）。macOS 无覆盖层，主进程侧静默忽略。
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncChromeColorMode = (): void => {
      const dark = appearance.colorMode === 'dark'
        || (appearance.colorMode === 'system' && media.matches)
      void window.sgDesktop.setWindowChromeColorMode(dark ? 'dark' : 'light').catch(() => {})
    }
    syncChromeColorMode()
    if (appearance.colorMode !== 'system') return
    media.addEventListener('change', syncChromeColorMode)
    return () => media.removeEventListener('change', syncChromeColorMode)
  }, [appearance.colorMode])

  // 快照来自两个来源（主进程推送 + 操作后的手动拉取），到达顺序不保证；
  // 非时间线部分按 updatedAt 单调守卫丢弃迟到的旧快照，时间线按每通道版本合并
  //（推送会省略本地已持有的通道），细则见 snapshot-sharing.ts。
  const acceptSnapshot = useCallback((incoming: DesktopSnapshot) => {
    setSnapshot((previous) => mergeDesktopSnapshot(previous, incoming))
  }, [])
  // 推送瘦身与拉取回包竞态的窗口期：版本表里有、本地没有内容的段落，补拉一次完整快照。
  // 同一组缺口只补一次；正常运行下不会触发。
  const repairedSnapshotGap = useRef('')
  useEffect(() => {
    const gaps = snapshotGaps(snapshot)
    if (!gaps.length) return
    const key = gaps.join('|')
    if (repairedSnapshotGap.current === key) return
    repairedSnapshotGap.current = key
    void window.sgDesktop.getSnapshot().then(acceptSnapshot).catch(() => {})
  }, [snapshot, acceptSnapshot])
  const acceptTaskPool = useCallback((incoming: ReturnType<typeof emptyTaskPoolSnapshot>) => {
    setTaskPool((previous) => newestTaskPoolSnapshot(previous, incoming))
  }, [])
  const acceptTeamControl = useCallback((incoming: ReturnType<typeof emptyTeamControlSnapshot>) => {
    setTeamControl((previous) => {
      if (incoming.revision < previous.revision) return previous
      activeRunRef.current = {
        id: incoming.activeRun?.id,
        status: incoming.activeRun?.status
      }
      return incoming
    })
  }, [])
  const acceptCollaboration = useCallback((incoming: ReturnType<typeof emptyTeamCollaborationSnapshot>) => {
    setCollaboration((previous) => {
      const activeRun = activeRunRef.current
      if (!activeRun.id || !['launching', 'running', 'attention', 'paused', 'completed'].includes(activeRun.status ?? '')) {
        return previous.runId === activeRun.id && previous.messageOrder.length === 0
          ? previous
          : emptyTeamCollaborationSnapshot(activeRun.id)
      }
      if (activeRun.id && incoming.runId !== activeRun.id) {
        return previous.runId === activeRun.id ? previous : emptyTeamCollaborationSnapshot(activeRun.id)
      }
      if (!activeRun.id && incoming.runId) {
        return previous.runId === undefined ? previous : emptyTeamCollaborationSnapshot()
      }
      return previous.runId !== incoming.runId || incoming.revision >= previous.revision ? incoming : previous
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.sgDesktop.onSnapshot(acceptSnapshot)
    const unsubscribeTasks = window.sgDesktop.onTaskPoolSnapshot(acceptTaskPool)
    const unsubscribeTeamControl = window.sgDesktop.onTeamControlSnapshot(acceptTeamControl)
    const unsubscribeCollaboration = window.sgDesktop.onTeamCollaborationSnapshot(acceptCollaboration)
    const unsubscribeUsage = window.sgDesktop.onCursorUsageSnapshot(setCursorUsage)
    void window.sgDesktop.getSnapshot().then(acceptSnapshot)
    void window.sgDesktop.getTaskPoolSnapshot().then(acceptTaskPool)
    void window.sgDesktop.getTeamControlSnapshot().then((incoming) => {
      acceptTeamControl(incoming)
      setTeamControlLoaded(true)
    })
    void window.sgDesktop.getTeamCollaborationSnapshot().then(acceptCollaboration)
    void window.sgDesktop.getCursorUsageSnapshot().then(setCursorUsage)
    return () => {
      unsubscribe()
      unsubscribeTasks()
      unsubscribeTeamControl()
      unsubscribeCollaboration()
      unsubscribeUsage()
    }
  }, [acceptCollaboration, acceptSnapshot, acceptTaskPool, acceptTeamControl])

  // ── Cursor 运行态账号核对（发起闸门 + 被动状态行共用数据源） ──
  const [runtimeMatch, setRuntimeMatch] = useState<CursorRuntimeAccountMatch | undefined>()
  const refreshRuntimeMatch = useCallback(async (): Promise<CursorRuntimeAccountMatch | undefined> => {
    try {
      const match = await window.sgDesktop.verifyCursorRuntimeAccount()
      setRuntimeMatch(match)
      return match
    } catch {
      // vault 解密失败等主进程异常：指示行降级为不显示，不阻塞发起流程
      return undefined
    }
  }, [])

  // ── Cursor 会员档位（在线权威源；发起闸门 + 手动刷新 + 账号/奥仔变更后重查） ──
  const [membershipStatus, setMembershipStatus] = useState<CursorMembershipStatus | undefined>()
  const [accountMemberships, setAccountMemberships] = useState<Record<string, CursorMembershipStatus>>({})
  const refreshMembership = useCallback(async (): Promise<CursorMembershipStatus> => {
    // IPC 按契约不 throw（错误以 error 状态返回）；catch 为纵深防御。
    const status = await window.sgDesktop.refreshCursorMembership().catch((reason: unknown): CursorMembershipStatus => ({
      state: 'error',
      detail: reason instanceof Error ? reason.message.slice(0, 120) : String(reason).slice(0, 120)
    }))
    setMembershipStatus(status)
    return status
  }, [])

  const refreshAccountMemberships = useCallback(async (accountIds?: string[]): Promise<Record<string, CursorMembershipStatus>> => {
    const statuses = await window.sgDesktop.refreshCursorAccountMemberships(accountIds).catch(() => ({}))
    setAccountMemberships((current) => accountIds ? { ...current, ...statuses } : statuses)
    return statuses
  }, [])

  useEffect(() => {
    void window.sgDesktop.listCursorAccounts()
      .then((accounts) => {
        setCursorAccounts(accounts)
        void refreshAccountMemberships()
      })
      .catch((reason: unknown) => reportCursorAccountError('账号信息读取失败', reason))
    void window.sgDesktop.getProcessingProviderStatuses()
      .then((statuses) => setProcessingStatuses((current) => ({
        ...current,
        ...Object.fromEntries(statuses.map((status) => [status.providerId, status]))
      })))
      .catch(() => {})
    void window.sgDesktop.getAgentLaunchPlan()
      .then((plan) => { if (plan) setAgentLaunchPlan(plan) })
      .catch(() => {})
    void window.sgDesktop.getSessionWarmupRun()
      .then((run) => { if (run) setSessionWarmupRun(run) })
      .catch(() => {})
    void window.sgDesktop.getAccountAutomationSettings()
      .then(setAccountAutomationSettings)
      .catch(() => {})
    void window.sgDesktop.getAccountAutomationRun()
      .then((run) => { if (run.phase !== 'idle') setAccountAutomationRun(run) })
      .catch(() => {})
    void window.sgDesktop.listAccountAutomationBitProfiles()
      .then((result) => {
        if (result.ok) {
          setBitProfiles(result.profiles ?? [])
          setBitProfilesMessage('')
        } else {
          setBitProfilesMessage(result.message ?? '指纹浏览器不可达')
        }
      })
      .catch(() => { setBitProfilesMessage('指纹浏览器窗口列表获取失败') })
    void window.sgDesktop.getAccountAutomationRoxyApiKey()
      .then(setRoxyApiKeyStatus)
      .catch(() => {})
    const unsubscribeProcessing = window.sgDesktop.onProcessingProgress(setProcessingProgress)
    const unsubscribeAgentLaunch = window.sgDesktop.onAgentLaunchProgress(setAgentLaunchPlan)
    const unsubscribeSessionWarmup = window.sgDesktop.onSessionWarmupProgress(setSessionWarmupRun)
    const unsubscribeCdpAutoHeal = window.sgDesktop.onCdpAutoHealEvent((event) => {
      if (event.phase === 'done') {
        setCdpAutoHealEvent(undefined)
        setTeamNotice(event.ok ? event.message : `自动重启未成功：${event.message}`)
        return
      }
      if (event.phase === 'cancelled') {
        setCdpAutoHealEvent(undefined)
        setTeamNotice('已取消本次自动重启；本次 Cursor 启动期间不再提示。')
        return
      }
      setCdpAutoHealEvent(event)
    })
    void window.sgDesktop.getCursorCdpSettings()
      .then((settings) => setCdpAutoHealEnabled(settings.autoHealEnabled))
      .catch(() => {})
    void window.sgDesktop.getCursorUpdatePreferences()
      .then(setCursorUpdatePreferences)
      .catch((reason: unknown) => setCursorUpdateError(userFacingErrorMessage(reason)))
    // 切号补丁状态（只读检测，零副作用）；维护页状态卡与热切可用性共用。
    void refreshSwitchPumpStatus()
      .catch(() => {})
    const unsubscribeAccountAutomation = window.sgDesktop.onAccountAutomationProgress((run) => {
      setAccountAutomationRun(run)
      if (run.phase === 'done' || run.phase === 'failed') {
        // 自动化会改动账号列表（新 token 入库 / 移除本地记录），终态后刷新
        void window.sgDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
        // 链内为提速跳过了余额刷新，这里链外异步补齐
        const providerId = run.processingProvider ?? 'aozai'
        void window.sgDesktop.refreshProcessingBalance(providerId).then(updateProcessingStatus).catch(() => {})
        // 活跃账号可能已被移除/换发，一致性指示立即重算（不等 30s 轮询）
        void refreshRuntimeMatch()
        // 处理服务会改变账号档位，档位行同样立即重查
        void refreshMembership()
        void refreshAccountMemberships()
      }
    })
    return () => {
      unsubscribeProcessing()
      unsubscribeAgentLaunch()
      unsubscribeSessionWarmup()
      unsubscribeCdpAutoHeal()
      unsubscribeAccountAutomation()
    }
  }, [refreshRuntimeMatch, refreshMembership, refreshAccountMemberships])

  const selectSession = useCallback((channelId: string) => {
    persistLastSessionChannel(channelId)
    setActiveModule('sessions')
    setSessionListRequested(false)
    setSelectedChannelId(channelId)
  }, [])

  // ── Cursor 运行态账号闸门（发起会话前的双轨凭据核对） ──
  const [runtimeGuard, setRuntimeGuard] = useState<{
    verify: CursorRuntimeAccountMatch
    allowProceed: boolean
    pending: AgentLaunchRequest[]
  } | undefined>()
  const [runtimeGuardBusy, setRuntimeGuardBusy] = useState(false)
  const [runtimeGuardError, setRuntimeGuardError] = useState('')

  // ── Cursor 会员档位闸门状态（发起弹窗） ──
  const [membershipGuard, setMembershipGuard] = useState<{
    status: CursorMembershipStatus
    message: string
    pending: AgentLaunchRequest[]
  } | undefined>()
  const [membershipGuardBusy, setMembershipGuardBusy] = useState(false)
  const [membershipGuardError, setMembershipGuardError] = useState('')

  // 被动状态行：本地 SQLite 读毫秒级，30s 静默轮询让劈叉「随时可见」（后台标签暂停）。
  useEffect(() => {
    void refreshRuntimeMatch()
    // 档位是网络调用，不做定时轮询（会限流/留痕）：挂载时抓一次，
    // 其余时机 = 账号变更 / 奥仔处理后 / 发起闸门 / 手动刷新。
    void refreshMembership()
    const timer = setInterval(() => {
      if (!document.hidden) void refreshRuntimeMatch()
    }, 30_000)
    return () => clearInterval(timer)
  }, [refreshRuntimeMatch, refreshMembership])

  const performAgentLaunch = useCallback(async (requests: AgentLaunchRequest[]): Promise<AgentLaunchPlan> => {
    // 预热探针（闸门之后、批量之前）：低成本模型先跑一次「只回复：1」，
    // 未通过则中止批量——不消耗自动化配额，不让 N 个会话干等 180s 超时。
    if (readSessionWarmupEnabled()) {
      const warmup = await window.sgDesktop.runSessionWarmup()
      setSessionWarmupRun(warmup)
      if (warmup.phase !== 'done') {
        const blocked: AgentLaunchPlan = {
          id: 'session-warmup',
          state: 'failed',
          items: requests.map((request) => ({
            channelId: request.channelId,
            modelSelection: request.modelSelection,
            stage: 'failed' as const,
            message: warmup.message,
            code: 'warmup_failed' as const
          })),
          startedAt: Date.now(),
          finishedAt: Date.now()
        }
        setAgentLaunchPlan(blocked)
        return blocked
      }
    }
    const plan = await window.sgDesktop.launchAgentSessions(requests)
    setAgentLaunchPlan(plan)
    return plan
  }, [])

  const runSessionWarmupNow = useCallback(async (): Promise<void> => {
    const warmup = await window.sgDesktop.runSessionWarmup()
    setSessionWarmupRun(warmup)
  }, [])

  const launchAgentSessions = useCallback(async (requests: AgentLaunchRequest[]): Promise<AgentLaunchPlan> => {
    // 闸门一（身份）在真正创建会话之前：Cursor 登录 ≠ 活跃账号时拦截（防删错官网账号/僵尸会话）。
    const verify = await window.sgDesktop.verifyCursorRuntimeAccount().catch(() => undefined)
    const gate = resolveRuntimeLaunchGate({
      verify,
      automationEnabled: accountAutomationSettings.enabled,
      hasActiveAccount: cursorAccounts.some((account) => account.active)
    })
    if (gate.action === 'proceed') {
      // 闸门二（档位）：身份对齐后在线实查会员档位，free 硬阻断；fail-closed——
      // 拿不到权威结果同样阻断（断网时批量会话本也跑不动）。
      const membership = await refreshMembership()
      const membershipGate = resolveMembershipLaunchGate(membership)
      if (membershipGate.action === 'proceed') return performAgentLaunch(requests)
      setMembershipGuard({ status: membership, message: membershipGate.message, pending: requests })
      const membershipBlocked: AgentLaunchPlan = {
        id: 'membership-guard',
        state: 'failed' as const,
        items: requests.map((request) => ({
          channelId: request.channelId,
          modelSelection: request.modelSelection,
          stage: 'failed' as const,
          message: membershipGate.message,
          code: 'membership_blocked' as const
        })),
        startedAt: Date.now(),
        finishedAt: Date.now()
      }
      setAgentLaunchPlan(membershipBlocked)
      return membershipBlocked
    }
    setRuntimeGuard({ verify: verify!, allowProceed: gate.allowProceed, pending: requests })
    // 调用方语义期望拿到 plan：合成 failed plan 进状态并返回——会话卡片的逐通道
    // 列表立即展示拦截原因，修复动作在弹窗里完成后由真实 plan 覆盖。
    const blocked: AgentLaunchPlan = {
      id: 'runtime-account-guard',
      state: 'failed' as const,
      items: requests.map((request) => ({
        channelId: request.channelId,
        modelSelection: request.modelSelection,
        stage: 'failed' as const,
        message: gate.message,
        code: 'runtime_account_mismatch' as const
      })),
      startedAt: Date.now(),
      finishedAt: Date.now()
    }
    setAgentLaunchPlan(blocked)
    return blocked
  }, [accountAutomationSettings.enabled, cursorAccounts, performAgentLaunch, refreshMembership])

  const createIndependentSessions = useCallback(async (
    input: CreateIndependentSessionsInput
  ): Promise<AgentLaunchPlan> => {
    const created = await window.sgDesktop.createIndependentSessions(input)
    acceptTeamControl(created)
    // 建池后立即登记 Agent 注册表（唯一的接入时机：池 run 一经写入即 running，没有 draft / ready 阶段）。
    await window.sgDesktop.installTaskMcp()
    const [latest, desktop] = await Promise.all([
      window.sgDesktop.getTeamControlSnapshot(),
      window.sgDesktop.getSnapshot()
    ])
    acceptTeamControl(latest)
    acceptSnapshot(desktop)
    const requests = latest.members.flatMap((member) => {
      const channelId = member.binding?.channelId ?? member.slot.channelId
      return channelId ? [{ channelId, modelSelection: member.slot.modelSelection }] : []
    })
    const plan = await launchAgentSessions(requests)
    if (plan.state === 'done' && requests[0]) selectSession(requests[0].channelId)
    return plan
  }, [acceptSnapshot, acceptTeamControl, launchAgentSessions, selectSession])

  const continueGuardedLaunch = useCallback(async (): Promise<void> => {
    const guard = runtimeGuard
    if (!guard) return
    setRuntimeGuardError('')
    setRuntimeGuardBusy(true)
    try {
      const plan = await performAgentLaunch(guard.pending)
      setRuntimeGuard(undefined)
      if (plan.state === 'done') setTeamNotice('会话已全部就绪。')
    } catch (reason) {
      setRuntimeGuardError(userFacingErrorMessage(reason))
    } finally {
      setRuntimeGuardBusy(false)
    }
  }, [runtimeGuard, performAgentLaunch])

  const switchAndContinueLaunch = useCallback(async (): Promise<void> => {
    const guard = runtimeGuard
    const active = cursorAccounts.find((account) => account.active)
    if (!guard || !active) return
    setRuntimeGuardError('')
    setRuntimeGuardBusy(true)
    try {
      const result = await window.sgDesktop.restartCursorWithAccount(active.id)
      if (!result.switched) {
        setRuntimeGuardError('切换未能完成，请重试。')
        return
      }
      if (!result.runtimeVerified) {
        setRuntimeGuardError('Cursor 已重启，但运行时登录态尚未完成确认；请稍后重试发起。')
        return
      }
      if (result.tokenExpired) {
        // 过期 token 切进去只会产出僵尸会话：停在弹窗让用户先重新获取 Token。
        setRuntimeGuardError('该活跃账号的 Token 已过期，请重新获取后再发起会话。')
        return
      }
      await refreshRuntimeMatch()
      setRuntimeGuard(undefined)
      const plan = await performAgentLaunch(guard.pending)
      if (plan.state === 'done') setTeamNotice('账号已切换，会话已全部就绪。')
    } catch (reason) {
      setRuntimeGuardError(userFacingErrorMessage(reason))
    } finally {
      // 冷切换会清账号行的「待重启对齐」标记：回读列表让徽标即时对齐 vault。
      void window.sgDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
      setRuntimeGuardBusy(false)
    }
  }, [runtimeGuard, cursorAccounts, performAgentLaunch, refreshRuntimeMatch])

  // 弹窗内「刷新档位并继续」：重新在线抓取；非 free 即自动续跑暂存的发起请求。
  const refreshMembershipAndContinue = useCallback(async (): Promise<void> => {
    const guard = membershipGuard
    if (!guard) return
    setMembershipGuardError('')
    setMembershipGuardBusy(true)
    try {
      const status = await refreshMembership()
      const decision = resolveMembershipLaunchGate(status)
      if (decision.action === 'proceed') {
        setMembershipGuard(undefined)
        const plan = await performAgentLaunch(guard.pending)
        if (plan.state === 'done') setTeamNotice('账号档位已确认，会话已全部就绪。')
        return
      }
      setMembershipGuard({ ...guard, status, message: decision.message })
    } catch (reason) {
      setMembershipGuardError(userFacingErrorMessage(reason))
    } finally {
      setMembershipGuardBusy(false)
    }
  }, [membershipGuard, performAgentLaunch, refreshMembership])

  const updateProcessingStatus = useCallback((status: ProcessingCredentialStatus): void => {
    setProcessingStatuses((current) => ({ ...current, [status.providerId]: status }))
  }, [])

  const refreshProcessingBalance = useCallback(async (
    providerId: ProcessingProviderId,
    options: { silent?: boolean } = {}
  ): Promise<void> => {
    if (!options.silent) {
      setProcessingBusy(true)
      setProcessingError(null)
    }
    try {
      updateProcessingStatus(await window.sgDesktop.refreshProcessingBalance(providerId))
    } catch (reason) {
      if (!options.silent) setProcessingError({ providerId, message: userFacingErrorMessage(reason) })
    } finally {
      if (!options.silent) setProcessingBusy(false)
    }
  }, [updateProcessingStatus])

  const saveProcessingCredential = useCallback(async (providerId: ProcessingProviderId, code: string): Promise<void> => {
    setProcessingBusy(true)
    setProcessingError(null)
    setProcessingFeedback(null)
    try {
      updateProcessingStatus(await window.sgDesktop.saveProcessingCredential({ providerId, code }))
    } catch (reason) {
      setProcessingError({ providerId, message: userFacingErrorMessage(reason) })
      throw reason
    } finally {
      setProcessingBusy(false)
    }
  }, [updateProcessingStatus])

  const clearProcessingCredential = useCallback(async (providerId: ProcessingProviderId): Promise<void> => {
    setProcessingBusy(true)
    setProcessingError(null)
    setProcessingFeedback(null)
    try {
      updateProcessingStatus(await window.sgDesktop.clearProcessingCredential(providerId))
    } catch (reason) {
      setProcessingError({ providerId, message: userFacingErrorMessage(reason) })
    } finally {
      setProcessingBusy(false)
    }
  }, [updateProcessingStatus])

  const processAccount = useCallback(async (providerId: ProcessingProviderId, accountId: string): Promise<void> => {
    setProcessingBusy(true)
    setProcessingError(null)
    setProcessingFeedback(null)
    setProcessingProgress(null)
    const requestId = crypto.randomUUID()
    try {
      const result = await window.sgDesktop.processAccount({ providerId, accountId, requestId })
      setProcessingFeedback({ providerId, ok: result.ok, message: result.message, originSection: 'accounts', notification: result.notification })
      if (result.balance) {
        setProcessingStatuses((current) => ({ ...current, [providerId]: { ...current[providerId], ...result.balance } }))
      }
      // 处理完成 = 档位大概率已变（free → 试用/付费），立即重查被动档位行。
      if (result.ok) void refreshMembership()
    } catch (reason) {
      setProcessingFeedback({ providerId, ok: false, message: userFacingErrorMessage(reason), originSection: 'accounts', notification: { key: `processing:${providerId}:${requestId}`, eventId: `processing:${requestId}:result` } })
    } finally {
      setProcessingBusy(false)
      setProcessingProgress(null)
    }
  }, [refreshMembership])

  // 手动模式：token 由用户粘贴，不属于库内账号——不触发档位重查，其余状态流与账号处理一致。
  const processToken = useCallback(async (providerId: ProcessingProviderId, token: string): Promise<void> => {
    setProcessingBusy(true)
    setProcessingError(null)
    setProcessingFeedback(null)
    setProcessingProgress(null)
    const requestId = crypto.randomUUID()
    try {
      const result = await window.sgDesktop.processToken({ providerId, token, requestId })
      setProcessingFeedback({ providerId, ok: result.ok, message: result.message, originSection: 'aozai', notification: result.notification })
      if (result.balance) {
        setProcessingStatuses((current) => ({ ...current, [providerId]: { ...current[providerId], ...result.balance } }))
      }
    } catch (reason) {
      setProcessingFeedback({ providerId, ok: false, message: userFacingErrorMessage(reason), originSection: 'aozai', notification: { key: `processing:${providerId}:${requestId}`, eventId: `processing:${requestId}:result` } })
    } finally {
      setProcessingBusy(false)
      setProcessingProgress(null)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let polling = false
    const inspect = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const detection = await window.sgDesktop.detectCursorWorkspace()
        if (!disposed) {
          setCursorWorkspace((previous) => (
            cursorWorkspaceFingerprint(previous) === cursorWorkspaceFingerprint(detection)
              ? previous
              : detection
          ))
        }
      } catch {
        if (!disposed) setCursorWorkspace({ state: 'unavailable', candidates: [], detail: 'Cursor 检测连接未就绪', observedAt: Date.now() })
      } finally {
        polling = false
      }
    }
    void inspect()
    // 复用 5s 检测周期，每次读取当前 IDE 窗口；仅更新展示，不切换运行作用域。
    const timer = setInterval(() => {
      if (!document.hidden) void inspect()
    }, 5_000)
    const onVisibilityChange = (): void => {
      if (!document.hidden) void inspect()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!teamControlLoaded) return
    const run = teamControl.activeRun
    activeRunRef.current = { id: run?.id, status: run?.status }
    setCollaboration((previous) => {
      // Keep this run's history for the read-only group inspector; only a scope change clears it.
      if (!run || previous.runId !== run.id) {
        return previous.runId === run?.id && previous.messageOrder.length === 0
          ? previous
          : emptyTeamCollaborationSnapshot(run?.id)
      }
      return previous
    })
    void window.sgDesktop.getTeamCollaborationSnapshot()
      .then(acceptCollaboration)
      .catch(() => {})
  }, [acceptCollaboration, teamControl.activeRun?.id, teamControl.activeRun?.status, teamControlLoaded])

  const visibleSnapshot = useMemo(() => {
    const effectiveLeadSlotId = teamControl.activeRun?.actingLeadSlotId
      ?? teamControl.members.find((member) => member.role.templateKey === 'lead')?.slot.id
    const memberByChannel = new Map(teamControl.members.flatMap((member) => {
      const channelId = member.binding?.channelId ?? member.slot.channelId
      return channelId ? [[channelId, member] as const] : []
    }))
    return {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => {
        // 徽章只认席位当前绑定的 Composer 的账（会话生命周期 = Composer 生命周期，阶段 2 · 2E）：
        // 只有在绑的 Composer 会入账，席位重建 / 换池后新会话绑定前不显示数字——不回退到通道最新
        // 转录定位的 composer，那在新会话建立前仍指向旧会话，只会顶着旧账。
        // 快照含出绑后封口的历史账（统计页用），结束后的账仍在绑，徽章保持最后一笔数值。
        const usage = session.composerId ? cursorUsage[session.composerId] : undefined
        const withUsage = usage && usage.turns > 0 ? { ...session, usage } : session
        const member = memberByChannel.get(session.channelId)
        if (!member) return withUsage
        const task = taskPool.taskOrder
          .map((taskId) => taskPool.tasks[taskId])
          .find((candidate) => candidate?.assigneeSessionId === member.binding?.agentSessionId)
        const isEffectiveLead = member.slot.id === effectiveLeadSlotId
        return {
          ...withUsage,
          displayName: `${member.role.name}${isEffectiveLead && member.role.templateKey !== 'lead' ? '（临时主控）' : ''} · CH-${session.channelId}`,
          roleName: `${member.slot.name}${isEffectiveLead && member.role.templateKey !== 'lead' ? ' · 临时主控' : ''}`,
          roleTemplateKey: member.role.templateKey,
          isEffectiveLead,
          avatarId: member.slot.avatarId,
          currentTask: task?.title ?? ''
        }
      })
    }
  }, [cursorUsage, snapshot, taskPool, teamControl.activeRun?.actingLeadSlotId, teamControl.members])
  // 统计页席位来源：引用随 sessions 走（sessions 本身已随 members 重算）——推流高频渲染下不触发统计视图模型重算。
  // slotId 让重建前旧 Composer 的账（账上带入账时的席位）仍归到这个席位。
  const statsSeats = useMemo(() => {
    const slotByChannel = new Map(teamControl.members.flatMap((member) => {
      const channelId = member.binding?.channelId ?? member.slot.channelId
      return channelId ? [[channelId, member.slot.id] as const] : []
    }))
    return visibleSnapshot.sessions.map((session) => ({
      channelId: session.channelId,
      roleName: session.roleName,
      displayName: session.displayName,
      avatarId: session.avatarId,
      online: session.online,
      composerId: session.composerId,
      telemetryChannelComposerId: session.telemetryChannelComposerId,
      slotId: slotByChannel.get(session.channelId)
    }))
  }, [visibleSnapshot.sessions, teamControl.members])
  // active 组的通道投影：名册按组分区（阶段 3 · D4=a）与统计页的组求和（阶段 2 · 2E）共用同一份，
  // 免得「谁算一个组、成员怎么对到通道」在两处各写一遍还慢慢走样。
  const activeGroups = useMemo((): RailGroupSource[] => teamControl.groups
    .filter((view) => view.group.status === 'active')
    .map((view) => {
      const channelOf = (member: TeamMemberView): string | undefined => member.binding?.channelId ?? member.slot.channelId
      const lead = view.members.find((member) => member.slot.id === view.effectiveLeadSlotId)
      const leadChannelId = lead ? channelOf(lead) : undefined
      return {
        id: view.group.id,
        name: view.group.name,
        channelIds: view.members.flatMap((member) => {
          const channelId = channelOf(member)
          return channelId ? [channelId] : []
        }),
        ...(leadChannelId ? { leadChannelId } : {}),
        attention: view.attention
      }
    }), [teamControl.groups])
  const statsGroups = useMemo(
    () => activeGroups.map((group) => ({ key: group.id, label: group.name, channelIds: group.channelIds })),
    [activeGroups]
  )
  // ---------- 协作组抽屉（建组 / 加人）：名册多选与运行页共用同一个实例 ----------
  const [groupComposer, setGroupComposer] = useState<GroupComposerMode>()
  const [groupComposerBusy, setGroupComposerBusy] = useState(false)
  const [groupComposerError, setGroupComposerError] = useState('')
  const ungroupedSeats = useMemo(() => ungroupedSeatsOf(teamControl.members), [teamControl.members])
  const defaultGroupName = useMemo(() => nextGroupName(activeGroups.map((group) => group.name)), [activeGroups])
  const openGroupComposer = useCallback((mode: GroupComposerMode): void => {
    setGroupComposerError('')
    setGroupComposer(mode)
  }, [])
  const submitGroupComposer = useCallback(async (operation: () => Promise<unknown>): Promise<void> => {
    setGroupComposerBusy(true)
    setGroupComposerError('')
    try {
      await operation()
      setGroupComposer(undefined)
    } catch (reason) {
      setGroupComposerError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setGroupComposerBusy(false)
    }
  }, [])
  // 名册多选浮动条的去处：建组 / 加人进同一个抽屉（预勾通道，角色在抽屉里确认）；移出直接走 IPC——
  // 确认面在名册里，这里只负责把通道号解析回 slot 与所在 active 组，逐个移出（服务端无批量口）。
  const selectionActions = useMemo((): RailSelectionActions => ({
    createGroup: (channelIds) => openGroupComposer({ kind: 'create', preselectedChannelIds: channelIds }),
    addToGroup: (groupId, channelIds) => {
      const group = activeGroups.find((candidate) => candidate.id === groupId)
      if (group) openGroupComposer({ kind: 'add', groupId, groupName: group.name, preselectedChannelIds: channelIds })
    },
    removeFromGroups: async (channelIds) => {
      for (const channelId of channelIds) {
        const member = teamControl.members.find(
          (candidate) => (candidate.binding?.channelId ?? candidate.slot.channelId) === channelId
        )
        const view = member && teamControl.groups.find(
          (candidate) => candidate.group.status === 'active'
            && candidate.members.some((groupMember) => groupMember.slot.id === member.slot.id)
        )
        // 确认与执行之间席位可能已出组 / 离池：跳过它，移出剩下的——半途报错反而留一半。
        if (!member || !view) continue
        acceptTeamControl(await window.sgDesktop.removeTeamGroupMember({ groupId: view.group.id, slotId: member.slot.id }))
      }
    }
  }), [acceptTeamControl, activeGroups, openGroupComposer, teamControl.groups, teamControl.members])
  /** 会话头部的组名跳转：运行页对应卡片滚入视野并短暂点亮。 */
  const [focusGroupId, setFocusGroupId] = useState<string>()
  const [groupInspectorFocus, setGroupInspectorFocus] = useState<{ key: number; scopeKey: string }>()
  const selectedSession = visibleSnapshot.sessions.find((session) => session.channelId === selectedChannelId)
  const selectedMember = teamControl.members.find((member) => (
    (member.binding?.channelId ?? member.slot.channelId) === selectedSession?.channelId
  ))
  // 会话头部的组名 chip：席位所在的 active 组（独立席位没有）。
  const selectedMemberGroup = useMemo(() => {
    const slotId = selectedMember?.slot.id
    if (!slotId) return undefined
    const view = teamControl.groups.find((candidate) => (
      candidate.group.status === 'active' && candidate.members.some((member) => member.slot.id === slotId)
    ))
    return view ? { id: view.group.id, name: view.group.name } : undefined
  }, [selectedMember?.slot.id, teamControl.groups])
  // 会话工作区回调的引用稳定化：draft 每次按键都触发 App 重渲染，这些回调若内联新建，
  // 会把 SessionWorkspace 时间线的 memo 边界打穿（所有历史卡被迫参与 reconciliation）。
  const workspaceChannelId = selectedSession?.channelId ?? ''
  const sessionGroupContext = useMemo(() => groupContextView(teamControl, workspaceChannelId, taskPool, collaboration),
    [teamControl, workspaceChannelId, taskPool, collaboration])
  const communicationSummaries = useMemo(() => groupCommunicationSummaries(teamControl, collaboration), [teamControl, collaboration])
  const [collaborationTarget, setCollaborationTarget] = useState<{ runId: string; groupId: string; messageId?: string }>()
  const openCollaboration = useCallback((groupId: string): void => {
    const run = teamControl.activeRun
    if (!run || activeRunRef.current.id !== run.id || !teamControl.groups.some(view => view.group.id === groupId && view.group.runId === run.id)) return
    setCollaborationTarget({ runId: run.id, groupId })
    // One local read on explicit open, not another permanent poll or launch-chain precheck.
    void window.sgDesktop.getTeamCollaborationSnapshot().then(acceptCollaboration).catch(() => {})
  }, [teamControl.activeRun, teamControl.groups, acceptCollaboration])
  const collaborationFacts = useMemo(() => {
    const run = teamControl.activeRun
    if (!collaborationTarget || !run || run.id !== collaborationTarget.runId) return undefined
    const group = teamControl.groups.find(view => view.group.id === collaborationTarget.groupId && view.group.runId === run.id)
    return group ? collaborationMapFacts(group, run, collaboration) : undefined
  }, [collaborationTarget, teamControl.activeRun, teamControl.groups, collaboration])
  useEffect(() => { if (collaborationTarget && !collaborationFacts) setCollaborationTarget(undefined) }, [collaborationTarget, collaborationFacts])
  const closeCollaboration = useCallback(() => setCollaborationTarget(undefined), [])
  const openCollaborationMember = useCallback((slotId: string): boolean => {
    if (!collaborationTarget || activeRunRef.current.id !== collaborationTarget.runId) return false
    const member = teamControl.members.find(item => item.slot.id === slotId && item.slot.runId === collaborationTarget.runId && item.slot.groupId === collaborationTarget.groupId)
    const channelId = member?.binding?.channelId ?? member?.slot.channelId
    const session = visibleSnapshot.sessions.find(item => item.channelId === channelId)
    if (!member || !channelId || !session || member.binding?.agentSessionId && member.binding.agentSessionId !== session.id) return false
    closeCollaboration(); selectSession(channelId)
    return true
  }, [collaborationTarget, teamControl.members, visibleSnapshot.sessions, closeCollaboration, selectSession])
  const handleWorkspaceDraftChange = useCallback((value: string): void => {
    if (!workspaceChannelId) return
    setComposerDrafts((current) => ({ ...current, [workspaceChannelId]: value }))
  }, [workspaceChannelId])
  const workspaceQuestionActions = useMemo((): QuestionActions => ({
    notificationScope: { channelId: workspaceChannelId, sessionId: selectedSession?.id, generation: String(selectedSession?.generation ?? 0),
      composerId: selectedSession?.composerId, bindingGeneration: selectedMember?.binding?.generation,
      workspaceId: teamControl.activeWorkspaceId, runId: teamControl.activeRun?.id, slotId: selectedMember?.slot.id, groupId: selectedMember?.slot.groupId },
    answer: (toolCallId, draft) => window.sgDesktop.answerCursorQuestion({
      channelId: workspaceChannelId, toolCallId, ...draft, ...pageOperationDisplay('question-answer').request
    }),
    skip: (toolCallId) => window.sgDesktop.skipCursorQuestion({ channelId: workspaceChannelId, toolCallId, ...pageOperationDisplay('question-skip').request })
  }), [workspaceChannelId, selectedSession?.id, selectedSession?.generation, selectedSession?.composerId, selectedMember?.binding?.generation,
    teamControl.activeWorkspaceId, teamControl.activeRun?.id, selectedMember?.slot.id, selectedMember?.slot.groupId])
  const handleWorkspaceSend = useCallback(async (text: string, attachments?: MessageAttachment[]): Promise<void> => {
    if (!workspaceChannelId) return
    await window.sgDesktop.sendMessage({ channelId: workspaceChannelId, text, attachments })
  }, [workspaceChannelId])
  const handleWorkspaceQuote = useCallback((text: string): void => {
    if (!workspaceChannelId) return
    setComposerDrafts((current) => {
      const existing = (current[workspaceChannelId] ?? '').trimEnd()
      return { ...current, [workspaceChannelId]: existing ? `${existing}\n\n${text}` : text }
    })
  }, [workspaceChannelId])
  // 输入区上方的本轮文件栏：右栏审查页已经在算的「本轮」范围 + 它读到的 Git 摘要，投影成一份视图。
  // 摘要由右栏镜像过来（不重复拉取）；过程流 ~10Hz 推送时按内容等价复用上一份对象，让栏的 memo 边界生效。
  const reviewWorkspaceKey = activeWorkspace?.path || activeWorkspace?.id || activeProjectName || selectedSession?.id || ''
  const [reviewSummaryState, setReviewSummaryState] = useState<{ workspaceKey: string; value: WorkspaceReviewSummary }>()
  const workspaceReviewSummary = reviewSummaryState?.workspaceKey === reviewWorkspaceKey ? reviewSummaryState.value : undefined
  const acceptWorkspaceReviewSummary = useCallback((summary: WorkspaceReviewSummary | undefined): void => {
    setReviewSummaryState(summary ? { workspaceKey: reviewWorkspaceKey, value: summary } : undefined)
  }, [reviewWorkspaceKey])
  const workspaceEntries = workspaceChannelId ? snapshot.conversations[workspaceChannelId] : undefined
  const workspaceLiveProcess = workspaceChannelId ? snapshot.liveProcess?.[workspaceChannelId] : undefined
  const workspaceWorking = selectedSession?.status === 'running'
  const turnFilesRef = useRef<TurnFilesView | undefined>(undefined)
  const workspaceTurnFiles = useMemo(() => {
    if (!workspaceEntries) return undefined
    const next = buildTurnFilesView({
      entries: workspaceEntries,
      liveProcess: workspaceLiveProcess,
      summary: workspaceReviewSummary,
      workspacePath: activeWorkspace?.path,
      working: workspaceWorking,
      // 名册行显示的 Cursor 累计净值 + 它所属的 Composer：栏的合计由它与消息上的回合起点刻度差分得出（见 turn-files-view）。
      sessionChanges: selectedSession?.changes,
      sessionComposerId: selectedSession?.composerId
    })
    const reused = sameTurnFilesView(turnFilesRef.current, next) ? turnFilesRef.current! : next
    turnFilesRef.current = reused
    return reused
  }, [activeWorkspace?.path, selectedSession?.changes, selectedSession?.composerId, workspaceEntries, workspaceLiveProcess, workspaceReviewSummary, workspaceWorking])
  const handleReviewTurnFiles = useCallback((request: ReviewFocusRequest): void => requestReviewFocus(request), [])
  // 「交接」三态：离线入组席位 → 成员身份迁移（可附带上下文）；其余在运行中的席位（独立或入组、
  // 在线或离线）→ 上下文交接；运行已结束 / 非本轮席位 → 禁用并说明原因。
  const handoffEntry = resolveHandoffEntry({ member: selectedMember, run: teamControl.activeRun })
  const [contextHandoffChannel, setContextHandoffChannel] = useState<string>()
  const loadHandoffContext = useCallback((channelId: string) => (
    window.sgDesktop.getSessionHandoffContext({ channelId })
  ), [])
  const deliverHandoff = useCallback((input: Parameters<typeof window.sgDesktop.deliverSessionHandoff>[0]) => (
    window.sgDesktop.deliverSessionHandoff(input)
  ), [])
  const revealHandoffPath = useCallback((path: string) => window.sgDesktop.revealPathInFolder({ path }), [])
  const contextHandoffSession = contextHandoffChannel
    ? visibleSnapshot.sessions.find((session) => session.channelId === contextHandoffChannel)
    : undefined
  useEffect(() => {
    if (activeModule !== 'sessions') return
    if (selectedChannelId && visibleSnapshot.sessions.some((session) => session.channelId === selectedChannelId)) {
      if (readLastSessionChannel() !== selectedChannelId) persistLastSessionChannel(selectedChannelId)
      return
    }
    if (sessionListRequested) return
    const remembered = readLastSessionChannel()
    const fallback = visibleSnapshot.sessions.find((session) => session.channelId === remembered)
      ?? visibleSnapshot.sessions.find((session) => session.online)
      ?? visibleSnapshot.sessions[0]
    if (fallback) {
      persistLastSessionChannel(fallback.channelId)
      setSelectedChannelId(fallback.channelId)
    }
  }, [activeModule, selectedChannelId, sessionListRequested, visibleSnapshot.sessions])
  const changeModule = useCallback((module: AppModule): void => {
    setActiveModule(module)
    if (module === 'sessions') setSessionListRequested(false)
    // 组名跳转的点亮是一次性的：离开运行页即失效，下次进入不再重播。
    if (module !== 'run') setFocusGroupId(undefined)
  }, [])

  const notificationContext = useRef({ sessions: visibleSnapshot.sessions, conversations: visibleSnapshot.conversations, team: teamControl, accounts: cursorAccounts, providerId: accountAutomationSettings.processingProvider,installationId:switchPumpStatus?.installationId,activeModule,selectedChannelId })
  notificationContext.current = { sessions: visibleSnapshot.sessions, conversations: visibleSnapshot.conversations, team: teamControl, accounts: cursorAccounts, providerId: accountAutomationSettings.processingProvider,installationId:switchPumpStatus?.installationId,activeModule,selectedChannelId }
  const [memoryInspection,setMemoryInspection] = useState<{request:TeamMemoryInspectionRequest;value:TeamMemoryInspection}>()
  const openNotificationTarget = useCallback(async (target: NotificationTarget, scope?: NotificationScope,stillRelevant?:()=>boolean): Promise<boolean> => {
    const context = notificationContext.current
    if (!notificationTargetAvailable(target, context.sessions, context.team)) return false
    if (target.kind === 'settings') {
      if(scope?.installationId&&scope.installationId!==context.installationId)return false
      if (scope?.accountId && target.section === 'accounts' && !context.accounts.some(account => account.id === scope.accountId)) return false
      if (scope?.providerId && (target.section === 'aozai' || target.section === 'accounts') && scope.providerId !== context.providerId) return false
      window.location.hash = `#account:${target.section}`; changeModule('account')
      if (target.section === 'accounts' && scope?.accountId) {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        if (!notificationContext.current.accounts.some(account => account.id === scope.accountId)) return false
        const row = document.querySelector<HTMLElement>(`.settings-page [data-account-id="${cssEscape(scope.accountId)}"]`)
        if (!row) return false
        row.scrollIntoView({ block: 'nearest', behavior: 'auto' })
      }
      return true
    }
    if(target.kind==='memory') {
      if(!window.sgDesktop.getTeamMemoryInspection)return false
      const sourceFocus=document.activeElement
      const value=await window.sgDesktop.getTeamMemoryInspection(target)
      if(stillRelevant&&!stillRelevant()||!sourceFocus?.isConnected||document.querySelector('[role="dialog"][aria-modal="true"]')||notificationContext.current.activeModule!==context.activeModule||notificationContext.current.selectedChannelId!==context.selectedChannelId)return false
      if(!notificationTargetAvailable(target,notificationContext.current.sessions,notificationContext.current.team)
        ||!memoryInspectionMatches(target,value))return false
      setMemoryInspection({request:target,value});return true
    }
    if (target.kind === 'run') { setFocusGroupId(target.groupId); changeModule('run'); return true }
    if (target.kind === 'collaboration') {
      if (!target.messageId) { openCollaboration(target.groupId); return true }
      const snapshot = await window.sgDesktop.getTeamCollaborationSnapshot()
      const message = snapshot.messages[target.messageId]
      if (stillRelevant&&!stillRelevant()||!notificationTargetAvailable(target, notificationContext.current.sessions, notificationContext.current.team)
        || snapshot.runId !== target.runId || !message || message.runId !== target.runId || message.groupId !== target.groupId) return false
      const latestTeam = notificationContext.current.team
      const group = latestTeam.groups.find(view => view.group.id === target.groupId && view.group.runId === target.runId)!
      if (!collaborationMapFacts(group, latestTeam.activeRun!, snapshot).messages.some(row => row.id === target.messageId)) return false
      acceptCollaboration(snapshot)
      setCollaborationTarget({ runId: target.runId, groupId: target.groupId, messageId: target.messageId }); return true
    }
    let replyMaterial: string | undefined
    if (target.queueEntryId) {
      const entry = context.conversations[target.scope.channelId!]?.find(entry => entry.id === target.entryId)
      if (!entry || !nativeAssistantEntry(entry, target.scope.channelId!) || entry.status !== 'complete' || entry.replyToEntryId !== target.queueEntryId) return false
    }
    if (target.replyBody) {
      const entry = context.conversations[target.scope.channelId!]?.find(entry => entry.id === target.entryId)
      if (!entry || !nativeAssistantEntry(entry, target.scope.channelId!) || entry.status !== target.replyBody.status) return false
      replyMaterial = replyBodyMaterial(entry.text, target.scope)
      const digest = await replyBodyDigest(entry.text, target.scope)
      if (!digest || digest !== target.replyBody.digest || stillRelevant && !stillRelevant()) return false
      const latest = notificationContext.current, current = latest.conversations[target.scope.channelId!]?.find(entry => entry.id === target.entryId)
      if (!current || current.status !== target.replyBody.status || !nativeAssistantEntry(current, target.scope.channelId!)
        || !notificationTargetAvailable(target, latest.sessions, latest.team) || replyBodyMaterial(current.text, target.scope) !== replyMaterial) return false
    }
    changeModule('sessions'); selectSession(target.scope.channelId!)
    if (target.entryId || target.blockId || target.surface) {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const latest = notificationContext.current
      if (!notificationTargetAvailable(target, latest.sessions, latest.team)) return false
      if (target.queueEntryId) {
        const entry = latest.conversations[target.scope.channelId!]?.find(entry => entry.id === target.entryId)
        if (!entry || !nativeAssistantEntry(entry, target.scope.channelId!) || entry.status !== 'complete' || entry.replyToEntryId !== target.queueEntryId) return false
      }
      if (target.replyBody) {
        const entry = latest.conversations[target.scope.channelId!]?.find(entry => entry.id === target.entryId)
        if (!entry || !nativeAssistantEntry(entry, target.scope.channelId!) || entry.status !== target.replyBody.status || replyBodyMaterial(entry.text, target.scope) !== replyMaterial) return false
      }
      return requestReveal({ ...(target.entryId ? { entryId: target.entryId } : {}), ...(target.blockId ? { blockId: target.blockId } : {}), ...(target.surface ? { surface: target.surface } : {}),
        ...(target.surface === 'context' || target.replyBody ? { sessionScope: target.scope } : {}), ...(target.replyBody ? { replyBody: target.replyBody } : {}) })
    }
    return true
  }, [changeModule, selectSession, openCollaboration, acceptCollaboration])

  const openMembershipTransfer = useCallback(async (slotId: string): Promise<void> => {
    setHandoffBusy(true)
    setHandoffError('')
    try {
      setHandoffOptions(await window.sgDesktop.getMembershipTransferOptions(slotId))
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHandoffBusy(false)
    }
  }, [])

  // 迁移成功后弹窗停在结果页（成员身份与上下文文档各自的结果），由用户点「完成」关闭；
  // 会话区先切到目标席位的通道，关闭后正好落在接手者的会话上。
  const confirmMembershipTransfer = useCallback(async (
    input: { toSlotId: string; includeContext: boolean }
  ): Promise<MembershipTransferOutcome | undefined> => {
    if (!handoffOptions) return undefined
    setHandoffBusy(true)
    setHandoffError('')
    try {
      const { team, ...outcome } = await window.sgDesktop.transferMembership({
        groupId: handoffOptions.groupId,
        fromSlotId: handoffOptions.sourceSlotId,
        toSlotId: input.toSlotId,
        includeContext: input.includeContext
      })
      acceptTeamControl(team)
      const [tasks, messages, desktop] = await Promise.all([
        window.sgDesktop.getTaskPoolSnapshot(),
        window.sgDesktop.getTeamCollaborationSnapshot(),
        window.sgDesktop.getSnapshot()
      ])
      acceptTaskPool(tasks)
      acceptCollaboration(messages)
      acceptSnapshot(desktop)
      if (outcome.transfer.toChannelId) setSelectedChannelId(outcome.transfer.toChannelId)
      return outcome
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    } finally {
      setHandoffBusy(false)
    }
  }, [acceptCollaboration, acceptSnapshot, acceptTaskPool, acceptTeamControl, handoffOptions])

  const accountPanel: SettingsPageProps = {
    accounts: cursorAccounts,
    busy: cursorAccountBusy,
    notice: cursorAccountNotice,
    onDismissNotice: () => setCursorAccountNotice(undefined),
    onSave: async (input) => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const display = pageOperationDisplay('import-token')
      try {
        setCursorAccounts(await window.sgDesktop.saveCursorAccount({ ...input, ...display.request }))
        setCursorAccountNotice({ tone: 'success', title: '账号已保存', detail: '当前 Cursor 运行账号未被本次保存切换。', section: 'import', notification: display.reference })
        // 新账号默认设为活跃（makeActive），一致性锚点变化 → 立即重算指示
        void refreshRuntimeMatch()
        // 新活跃账号档位未知，档位行同步重查
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { reportCursorAccountError('账号保存失败', reason, 'import', display.reference); throw reason }
      finally { setCursorAccountBusy(false) }
    },
    onSaveCard: async (input) => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const display = pageOperationDisplay('import-card')
      try {
        const result = await window.sgDesktop.saveCursorAccountCard({ ...input, ...display.request })
        setCursorAccounts(result.accounts)
        // 与 onSave 同理：卡号导入默认活跃，一致性锚点与档位同步重查
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
        return { outcome: result.outcome, label: result.label, tokenRefreshed: result.tokenRefreshed, loginError: result.loginError, notification: result.notification ?? display.reference }
      }
      catch (reason) { reportCursorAccountError('账号导入失败', reason, 'import', display.reference); throw reason }
      finally { setCursorAccountBusy(false) }
    },
    onReloginAccount: async (accountId) => {
      // 自动登录可能等人机验证（最长约 2 分钟）：不锁全局 busy，按账号粒度置忙；
      // 失败走账号区错误条，成功后列表刷新（maskedToken 变化即可见确认）。
      const display = pageOperationDisplay('account-login')
      try {
        const result = await window.sgDesktop.loginCursorAccount(accountId, display.request)
        setCursorAccounts(result.accounts)
        setCursorAccountNotice({ tone: 'success', title: result.outcome === 'already_logged_in' ? '原窗口已登录，凭据已更新' : '网页登录已完成，凭据已更新',
          detail: '当前 Cursor 运行账号未被本次操作切换。', notification: result.notification ?? display.reference })
        void refreshRuntimeMatch()
      }
      catch (reason) { reportCursorAccountError('账号重新登录失败', reason, 'accounts', display.reference); throw reason }
    },
    onStartProUpgrade: async (accountId) => {
      // 结账链可能等页面加载/人机验证（最长约 2 分钟）：不锁全局 busy（组件内按账号置忙）。
      // 结果不分成败都走反馈条——awaiting_payment（请扫码）与 verified（复核通过）都是正常出口。
      setProUpgradeFeedback(null)
      const display = pageOperationDisplay('checkout')
      try {
        const result = await window.sgDesktop.startCursorProUpgrade(accountId, display.request)
        setProUpgradeFeedback({ ok: true, pending: true, message: result.detail, notification: result.notification ?? display.reference })
      }
      catch (reason) {
        setProUpgradeFeedback({ ok: false, message: reason instanceof Error ? reason.message : String(reason), notification: display.reference })
        throw reason
      }
    },
    proUpgradeFeedback,
    onSelect: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      try { setCursorAccounts(await window.sgDesktop.selectCursorAccount(accountId)) }
      catch (reason) { reportCursorAccountError('当前账号未能更改', reason) }
      finally { setCursorAccountBusy(false) }
      // 换活跃账号会改变劈叉判定（Cursor 登录没变、锚点变了），立即刷新状态行
      void refreshRuntimeMatch()
      // 换活跃账号 = 档位锚点变化，同步重查
      void refreshMembership()
    },
    // 窗口绑定是纯本地元信息写入：不锁账号 busy（避免改绑时整行按钮闪禁），失败走账号区错误条
    onSetAccountFingerprintProfile: async (accountId, profileId) => {
      try { setCursorAccounts(await window.sgDesktop.setCursorAccountFingerprintProfile(accountId, profileId)) }
      catch (reason) { reportCursorAccountError('窗口绑定未能保存', reason) }
    },
    onRemove: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      try {
        setCursorAccounts(await window.sgDesktop.removeCursorAccount(accountId))
        // 删除活跃账号时 vault 会顺延活跃位，一致性锚点变化 → 立即重算指示
        void refreshRuntimeMatch()
        // 活跃位顺延后档位未知，同步重查
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { reportCursorAccountError('账号移除失败', reason) }
      finally { setCursorAccountBusy(false) }
    },
    onImportFromLocal: async () => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const display = pageOperationDisplay('import-local')
      try {
        setCursorAccounts(await window.sgDesktop.importCursorAccountFromLocalCursor(display.request))
        setCursorAccountNotice({ tone: 'success', title: '本机账号已导入', section: 'import', notification: display.reference })
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { reportCursorAccountError('本机账号导入失败', reason, 'import', display.reference) }
      finally { setCursorAccountBusy(false) }
    },
    onImportFromBrowser: async () => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const display = pageOperationDisplay('import-browser')
      try {
        setCursorAccounts(await window.sgDesktop.importCursorAccountFromBrowser(display.request))
        setCursorAccountNotice({ tone: 'success', title: '浏览器账号已导入', detail: '当前 Cursor 运行账号未被本次导入切换。', section: 'import', notification: display.reference })
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { reportCursorAccountError('浏览器账号导入失败', reason, 'import', display.reference) }
      finally { setCursorAccountBusy(false) }
    },
    onImportFromFingerprint: async () => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const display = pageOperationDisplay('import-fingerprint')
      try {
        setCursorAccounts(await window.sgDesktop.importCursorAccountFromFingerprint(display.request))
        setCursorAccountNotice({ tone: 'success', title: '指纹浏览器账号已导入', detail: '绑定以保存账号卡片中的实际窗口为准。当前 Cursor 运行账号未被切换。', section: 'import', notification: display.reference })
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { reportCursorAccountError('指纹浏览器账号导入失败', reason, 'import', display.reference) }
      finally { setCursorAccountBusy(false) }
    },
    // 提前登录：开窗导航 cursor.com（不关窗；失败提示走账号区错误条）
    onOpenFingerprintLogin: async () => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const display = pageOperationDisplay('login-window')
      try { await window.sgDesktop.openFingerprintLoginPage(display.request)
        setCursorAccountNotice({ tone: 'warning', title: '登录窗口已打开，尚待登录', detail: '请在原窗口完成登录；打开窗口本身不代表已经登录。', section: 'import', notification: display.reference }) }
      catch (reason) { reportCursorAccountError('登录窗口未能打开', reason, 'import', display.reference) }
      finally { setCursorAccountBusy(false) }
    },
    onCleanupFingerprintEnvironment: async () => {
      // 清理只影响指纹浏览器 profile，不锁账号操作（面板内自有 busy/反馈态）。
      const display = pageOperationDisplay('fingerprint-cleanup')
      await window.sgDesktop.cleanupFingerprintEnvironment(display.request)
      setCursorAccountNotice({ tone: 'success', title: '浏览器环境清理已返回', detail: '处理范围以原确认入口为准。', section: 'import', notification: display.reference })
    },
    onRestartWithAccount: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const notificationId = crypto.randomUUID()
      const reference = { key: `account-switch:cold:${notificationId}`, eventId: `account-switch:${notificationId}:result` }
      try {
        const result = await window.sgDesktop.restartCursorWithAccount(accountId, { notificationId })
        if (!result.switched) return
        if (!result.runtimeVerified) {
          setCursorAccountNotice(result.relaunchMode === 'failed'
            ? { tone: 'warning', title: 'Cursor 未能启动', detail: '请手动启动 Cursor 后核对登录态。', notification: result.notification ?? reference }
            : { tone: 'warning', title: 'Cursor 登录态仍待确认', detail: 'Cursor 已启动，但运行时登录态尚未完成确认。', notification: result.notification ?? reference })
          return
        }
        if (result.tokenExpired) {
          setCursorAccountNotice({ tone: 'warning', title: '账号 Token 已过期', detail: '请重新获取 Token 后再切换。', notification: result.notification ?? reference })
          return
        }
        const relaunchNote = result.relaunchMode === 'cdp'
          ? result.cdpPortReady
            ? '调试端口已就绪，会话创建能力立即可用。'
            : '已带调试端口拉起，端口仍在启动中，稍候即可创建会话。'
          : result.relaunchMode === 'failed'
            ? '拉起 Cursor 失败，请手动启动 Cursor。'
            : '已重新拉起 Cursor。'
        const portPending = result.relaunchMode === 'cdp' && !result.cdpPortReady
        setCursorAccountNotice({
          tone: portPending ? 'warning' : 'success',
          title: portPending ? '账号已切换，会话端口仍在准备' : '账号切换完成',
          notification: result.notification ?? reference,
          detail: `Cursor 已确认目标账号，登录态与机器码已保存。${result.killedCursor ? 'Cursor 已重启。' : 'Cursor 原先未运行。'}${relaunchNote}`
        })
        // 切换成功 = 运行态与活跃账号重新对齐，立即刷新被动状态行
        void refreshRuntimeMatch()
        // 切换后运行账号变了，档位行同步重查
        void refreshMembership()
        void refreshAccountMemberships([accountId])
      } catch (reason) { reportCursorAccountError('账号切换并重启失败', reason, 'accounts', reference) }
      finally {
        // 冷切换的每个出口 vault 都可能已变（activeId + 清「待重启对齐」标记）：
        // 无条件回读，「当前」徽标与账号行标记跟 vault 真实状态对齐，不留旧值。
        void window.sgDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
        setCursorAccountBusy(false)
      }
    },
    onSwitchLiveAccount: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountNotice(undefined)
      const notificationId = crypto.randomUUID()
      const reference = { key: `account-switch:hot:${notificationId}`, eventId: `account-switch:${notificationId}:result` }
      try {
        const result = await window.sgDesktop.switchCursorAccountLive(accountId, { notificationId })
        if (!result.switched) {
          setCursorAccountNotice({ tone: 'warning', title: '无感切换未完成', detail: `${result.reason ?? '未知原因'}。可改用「切换并重启」。`, notification: result.notification ?? reference })
          return
        }
        setCursorAccountNotice(result.warning
          ? { tone: 'warning', title: '账号已切换，本地状态仍需处理', detail: result.warning, notification: result.notification ?? reference }
          : { tone: 'success', title: '账号已切换，无需重启 Cursor', detail: '令牌、邮箱与账号缓存已刷新。机器码将在下次「切换并重启」时对齐。', notification: result.notification ?? reference })
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships([accountId])
        // pendingMachineAlign 标记随热切置位，账号行标记立即刷新
        void window.sgDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
      } catch (reason) { reportCursorAccountError('无感切换失败', reason, 'accounts', reference) }
      finally { setCursorAccountBusy(false) }
    },
    runtimeMatch,
    membership: membershipStatus,
    accountMemberships,
    onRefreshMembership: async (accountId) => {
      if (accountId) await refreshAccountMemberships([accountId])
      else await refreshMembership()
    },
    processingStatuses,
    processingBusy,
    processingError,
    processingProgress,
    processingFeedback,
    onSaveProcessingCredential: saveProcessingCredential,
    onClearProcessingCredential: clearProcessingCredential,
    onRefreshProcessingBalance: refreshProcessingBalance,
    onProcessAccount: processAccount,
    onProcessToken: processToken,
    automationSettings: accountAutomationSettings,
    automationRun: accountAutomationRun,
    bitProfiles,
    bitProfilesMessage,
    roxyApiKeyStatus,
    onSaveRoxyApiKey: async (key) => {
      const status = await window.sgDesktop.saveAccountAutomationRoxyApiKey(key)
      setRoxyApiKeyStatus(status)
      // Key 就绪后 Roxy 窗口列表立即可拉（此前缺 Key 时列表必失败）
      void window.sgDesktop.listAccountAutomationBitProfiles()
        .then((result) => {
          if (result.ok) {
            setBitProfiles(result.profiles ?? [])
            setBitProfilesMessage('')
          }
        })
        .catch(() => {})
    },
    onRefreshBitProfiles: () => {
      return window.sgDesktop.listAccountAutomationBitProfiles()
        .then((result) => {
          if (result.ok) {
            setBitProfiles(result.profiles ?? [])
            setBitProfilesMessage('')
          } else {
            setBitProfilesMessage(result.message ?? '指纹浏览器不可达')
          }
        })
        .catch((reason: unknown) => setBitProfilesMessage(userFacingErrorMessage(reason)))
    },
    cursorUpdatePreferences,
    cursorUpdateBusy,
    cursorUpdateError,
    onSetCursorAutoUpdateDisabled: async (disabled) => {
      setCursorUpdateBusy(true); setCursorUpdateError('')
      try {
        const result = await window.sgDesktop.setCursorAutoUpdateDisabled(disabled)
        setCursorUpdatePreferences(result)
      } catch (reason) {
        setCursorUpdateError(userFacingErrorMessage(reason))
      } finally {
        setCursorUpdateBusy(false)
      }
    },
    switchPumpStatus,
    switchPumpBusy,
    switchPumpFeedback,
    onRefreshSwitchPumpStatus: refreshSwitchPumpStatus,
    onEnsureSwitchPump: async () => {
      ++switchPumpReadSequence.current
      setSwitchPumpBusy(true); setSwitchPumpFeedback(undefined)
      const display = pageOperationDisplay('patch-install')
      try {
        const outcome = await window.sgDesktop.ensureCursorSwitchPump(display.request)
        setSwitchPumpFeedback({
          ok: outcome.ok,
          pending: Boolean(outcome.warning),
          message: outcome.warning ? `${outcome.message}（${outcome.warning}）` : outcome.message,
          notification: outcome.notification ?? display.reference
        })
      } catch (reason) {
        setSwitchPumpFeedback({ ok: false, message: userFacingErrorMessage(reason), notification: display.reference })
      } finally {
        // 安装/改写后状态可能变化（installed/config），无条件重读一次
        await refreshSwitchPumpStatus().catch(() => {})
        setSwitchPumpBusy(false)
      }
    },
    onRemoveSwitchPump: async () => {
      ++switchPumpReadSequence.current
      setSwitchPumpBusy(true); setSwitchPumpFeedback(undefined)
      const display = pageOperationDisplay('patch-remove')
      try {
        const outcome = await window.sgDesktop.removeCursorSwitchPump(display.request)
        setSwitchPumpFeedback({
          ok: outcome.ok,
          pending: Boolean(outcome.warning),
          message: outcome.warning ? `${outcome.message}（${outcome.warning}）` : outcome.message,
          notification: outcome.notification ?? display.reference
        })
      } catch (reason) {
        setSwitchPumpFeedback({ ok: false, message: userFacingErrorMessage(reason), notification: display.reference })
      } finally {
        await refreshSwitchPumpStatus().catch(() => {})
        setSwitchPumpBusy(false)
      }
    },
    storageScan,
    storageScanBusy,
    storageScanError,
    storageCleanupBusy,
    storageCleanupResult,
    onScanCursorStorage: async (input) => {
      setStorageScanBusy(true); setStorageScanError('')
      try {
        setStorageScan(await window.sgDesktop.scanCursorStorage(input))
      } catch (reason) {
        setStorageScanError(userFacingErrorMessage(reason))
      } finally {
        setStorageScanBusy(false)
      }
    },
    onCleanCursorStorage: async (request) => {
      setStorageCleanupBusy(true); setStorageCleanupResult(undefined); setStorageScanError('')
      try {
        const result = await window.sgDesktop.cleanCursorStorage(request)
        setStorageCleanupResult(result)
        if (result.scan) setStorageScan(result.scan)
      } catch (reason) {
        setStorageCleanupResult({ ok: false, freedBytes: 0, done: [], skipped: [], message: userFacingErrorMessage(reason) })
      } finally {
        setStorageCleanupBusy(false)
      }
    },
    onRevealCursorStorage: (id) => { void window.sgDesktop.revealCursorStorage(id).catch(() => {}) },
    // 统计页（纯只读投影）：全部会话用量 + 当前席位 / 组来源；重建前旧 Composer 的账按席位标签归席位，
    // 归不到席位的由视图模型归入「历史会话」。
    usageSnapshot: cursorUsage,
    statsSeats,
    statsGroups,
    onSetModelDataPolicyAutoAcknowledge: async (enabled) => {
      let message = '已关闭自动确认；官网已有确认保持不变'
      let notification: NotificationReference | undefined
      if (enabled) {
        const display = pageOperationDisplay('model-policy')
        const result = await window.sgDesktop.acknowledgeCursorModelDataPolicies(display.request)
        notification = result.notification ?? display.reference
        // 政策导航若换发了 token，主进程已对同一活跃账号原地入库。
        if (result.tokenUpdated) setCursorAccounts(await window.sgDesktop.listCursorAccounts())
        message = `${result.message}；后续新账号将自动检查`
      }
      const saved = await window.sgDesktop.saveAccountAutomationSettings({
        ...accountAutomationSettings,
        autoAcknowledgeModelDataPolicies: enabled
      })
      setAccountAutomationSettings(saved)
      return { message, notification }
    },
    onSaveAutomationSettings: (settings) => {
      return window.sgDesktop.saveAccountAutomationSettings(settings)
        .then((saved) => { setAccountAutomationSettings(saved); return true })
        .catch((reason: unknown) => {
          setProcessingError({ providerId: settings.processingProvider, message: userFacingErrorMessage(reason) })
          return false
        })
    },
    onCancelAutomation: () => {
      void window.sgDesktop.cancelAccountAutomation().catch(() => {})
    }
  }

  return (
    <>
    <DesktopShell
      snapshot={visibleSnapshot}
      activeModule={activeModule}
      onNotificationTarget={openNotificationTarget}
      sidebar={activeModule === 'sessions' ? (
        <SessionSidebar
          snapshot={visibleSnapshot}
          selectedChannelId={selectedSession?.channelId}
          onSelectSession={selectSession}
          groups={activeGroups}
          selectionActions={selectionActions}
          onOpenRun={() => changeModule('run')}
        />
      ) : null}
      rightPanel={selectedSession ? (close, visible) => (
        <WorkspaceInspector
          session={selectedSession}
          entries={snapshot.conversations[selectedSession.channelId] ?? []}
          liveProcess={snapshot.liveProcess?.[selectedSession.channelId]}
          workspaceId={activeWorkspace?.id}
          workspaceName={activeProjectName}
          workspacePath={activeWorkspace?.path}
          turnFiles={workspaceTurnFiles}
          hidden={!visible}
          onQuoteToComposer={handleWorkspaceQuote}
          onReviewSummary={acceptWorkspaceReviewSummary}
          onClose={close}
          groupFocus={groupInspectorFocus}
          groupContext={{
            view: sessionGroupContext,
            communication: sessionGroupContext.group ? communicationSummaries.get(sessionGroupContext.group.group.id) : undefined,
            onOpenCollaboration: openCollaboration,
            onOpenSession: selectSession,
            onManageGroup: (groupId) => {
              if (!groupId && teamControl.activeRun?.status === 'running') {
                openGroupComposer({ kind: 'create', preselectedChannelIds: [workspaceChannelId] })
              } else {
                setFocusGroupId(groupId)
                changeModule('run')
              }
            },
            onPlanTask: async (groupId, task) => {
              const runId = teamControl.activeRun?.id
              if (!sessionGroupContext.mutable || groupId !== sessionGroupContext.group?.group.id
                || activeRunRef.current.id !== runId || activeRunRef.current.status !== 'running') {
                throw new Error('协作上下文已变化，请在当前组重新创建任务')
              }
              const latest = await submitGroupTask(window.sgDesktop, runId!, groupId, task)
              if (activeRunRef.current.id !== runId) return
              acceptTaskPool(latest)
            }
          }}
        />
      ) : undefined}
      rightPanelFocusKey={groupInspectorFocus?.key}
      cursorWorkspace={cursorWorkspace}
      workspace={activeWorkspace}
      wideContent={activeModule !== 'sessions'}
      teamChannelIds={memberChannelIds}
      cardOpacity={appearance.cardOpacity}
      colorMode={appearance.colorMode}
      accent={appearance.accent}
      background={appearance.background}
      onModuleChange={changeModule}
      onCardOpacityChange={(cardOpacity) => changeAppearance({ cardOpacity })}
      onColorModeChange={(colorMode) => changeAppearance({ colorMode })}
      onAccentChange={(accent) => changeAppearance({ accent })}
      onBackgroundChange={(background) => changeAppearance({ background })}
      onOpenProjectConfiguration={() => changeModule('run')}
    >
      {activeModule === 'account' ? (
        <SettingsPage {...accountPanel} />
      ) : activeModule === 'run' ? (
        <PoolPage
          team={teamControl}
          detectedWorkspace={cursorWorkspace?.workspace}
          externalNotice={teamNotice}
          agentLaunchPlan={agentLaunchPlan}
          cursorModels={visibleSnapshot.cursorModels ?? []}
          taskPool={taskPool}
          communicationSummaries={communicationSummaries}
          onOpenCollaboration={openCollaboration}
          sessionWarmupRun={sessionWarmupRun}
          sessionWarmupEnabled={sessionWarmupEnabled}
          onToggleSessionWarmup={(enabled) => {
            setSessionWarmupEnabled(enabled)
            persistSessionWarmupEnabled(enabled)
          }}
          onRunSessionWarmup={runSessionWarmupNow}
          onLaunchAgentSessions={launchAgentSessions}
          onCreateIndependentSessions={createIndependentSessions}
          onChooseIndependentWorkspace={() => window.sgDesktop.chooseIndependentWorkspace()}
          onEndActiveRun={async () => {
            acceptTeamControl(await window.sgDesktop.endActiveRun())
          }}
          onOpenSessions={() => setActiveModule('sessions')}
          onOpenSession={(channelId) => {
            setSelectedChannelId(channelId)
            changeModule('sessions')
          }}
          onPersistModelSelection={async (channelId, selection) => {
            const result = await window.sgDesktop.setSlotModelSelection(channelId, selection)
            acceptTeamControl(result)
            return result
          }}
          groupActions={{
            removeGroupMember: async (input) => acceptTeamControl(await window.sgDesktop.removeTeamGroupMember(input)),
            setGroupLead: async (input) => acceptTeamControl(await window.sgDesktop.setTeamGroupLead(input)),
            setGroupPlanPolicy: async (input) => acceptTeamControl(await window.sgDesktop.setTeamGroupPlanPolicy(input)),
            updateGroupGoal: async (input) => acceptTeamControl(await window.sgDesktop.updateTeamGroupGoal(input)),
            dissolveGroup: async (input) => acceptTeamControl(await window.sgDesktop.dissolveTeamGroup(input))
          }}
          onOpenGroupComposer={openGroupComposer}
          onTransferMembership={(slotId) => void openMembershipTransfer(slotId)}
          focusGroupId={focusGroupId}
          onEnableCursorCdp={() => window.sgDesktop.enableCursorCdp(pageOperationDisplay('debug-enable').request)}
          cdpAutoHealEnabled={cdpAutoHealEnabled}
          cdpAutoHealEvent={cdpAutoHealEvent}
          onToggleCdpAutoHeal={async (enabled) => {
            const saved = await window.sgDesktop.saveCursorCdpSettings({ autoHealEnabled: enabled })
            setCdpAutoHealEnabled(saved.autoHealEnabled)
          }}
          onCancelCdpAutoHealCountdown={async () => {
            await window.sgDesktop.cancelCdpAutoHealCountdown()
          }}
        />
      ) : selectedSession ? (
        <SessionWorkspace
          key={selectedSession.channelId}
          session={selectedSession}
          contextUsageSampledAt={visibleSnapshot.contextUsageSampledAt}
          entries={snapshot.conversations[selectedSession.channelId] ?? []}
          currentProjectName={activeProjectName}
          onBack={() => { setSessionListRequested(true); setSelectedChannelId(undefined) }}
          onHandoff={handoffEntry.kind === 'context'
            ? () => setContextHandoffChannel(selectedSession.channelId)
            : handoffEntry.kind === 'roles'
              ? () => void openMembershipTransfer(handoffEntry.slotId)
              : undefined}
          handoffTitle={handoffEntry.title}
          group={selectedMemberGroup}
          onOpenGroup={(groupId) => {
            setGroupInspectorFocus(previous => ({ key: (previous?.key ?? 0) + 1,
              scopeKey: `${teamControl.activeRun?.id ?? 'none'}:${groupId}` }))
          }}
          onWithdrawQueued={async (entryId) => {
            const withdrawn = (snapshot.conversations[selectedSession.channelId] ?? []).find((entry) => entry.id === entryId)
            const ok = await window.sgDesktop.withdrawQueuedMessage({ channelId: selectedSession.channelId, entryId })
            if (!ok) throw new Error('这条消息已被 Agent 取走，无法撤回')
            // 撤回不等于丢弃：正文回填输入框（已有草稿则换行接在后面），误触可直接重发。附件已落盘，不回填。
            const withdrawnText = withdrawn?.text.trim()
            if (withdrawnText) {
              setComposerDrafts((current) => {
                const draft = current[selectedSession.channelId] ?? ''
                return { ...current, [selectedSession.channelId]: draft.trim() ? `${draft.trimEnd()}\n\n${withdrawnText}` : withdrawnText }
              })
            }
            acceptSnapshot(await window.sgDesktop.getSnapshot())
            return ok
          }}
          onReleaseQueued={async (entryId) => {
            const ok = await window.sgDesktop.releaseQueuedMessage({ channelId: selectedSession.channelId, entryId })
            if (!ok) throw new Error('这条消息已不在等待状态')
            acceptSnapshot(await window.sgDesktop.getSnapshot())
            return ok
          }}
          draft={composerDrafts[selectedSession.channelId] ?? ''}
          onDraftChange={handleWorkspaceDraftChange}
          attachments={composerAttachments[selectedSession.channelId] ?? []}
          onAttachmentsChange={(attachments) => setComposerAttachments((current) => ({ ...current, [selectedSession.channelId]: attachments }))}
          liveProcess={snapshot.liveProcess?.[selectedSession.channelId]}
          liveAgentResponse={snapshot.liveAgentResponses?.[selectedSession.channelId]}
          nativeProcessStream={snapshot.nativeProcessStream}
          questionActions={workspaceQuestionActions}
          turnFiles={workspaceTurnFiles}
          onReviewTurnFiles={handleReviewTurnFiles}
          onSend={handleWorkspaceSend}
        />
      ) : (
        <SessionOverview
          snapshot={visibleSnapshot}
          onCreateIndependentSessions={() => setActiveModule('run')}
        />
      )}
    </DesktopShell>
    {collaborationFacts ? <GroupCollaborationDialog key={`${collaborationFacts.scopeKey}:${collaborationTarget?.messageId ?? ''}`} facts={collaborationFacts} focusMessageId={collaborationTarget?.messageId}
      workspaceName={teamControl.workspaces.find(workspace => workspace.id === teamControl.activeRun?.workspaceId)?.name}
      onClose={closeCollaboration} onOpenMember={openCollaborationMember} /> : null}
    {groupComposer ? (
      <GroupComposer
        key={groupComposer.kind === 'add' ? `add:${groupComposer.groupId}` : 'create'}
        mode={groupComposer}
        candidates={ungroupedSeats}
        defaultName={defaultGroupName}
        busy={groupComposerBusy}
        error={groupComposerError}
        onClose={() => { if (!groupComposerBusy) setGroupComposer(undefined) }}
        onCreate={(input) => void submitGroupComposer(async () => acceptTeamControl(await window.sgDesktop.createTeamGroup(input)))}
        onAddMembers={(input) => void submitGroupComposer(async () => acceptTeamControl(await window.sgDesktop.addTeamGroupMembers(input)))}
      />
    ) : null}
    {handoffOptions ? (
      <TransferMembershipDialog
        key={handoffOptions.sourceSlotId}
        options={handoffOptions}
        busy={handoffBusy}
        error={handoffError}
        onClose={() => { if (!handoffBusy) setHandoffOptions(undefined) }}
        onConfirm={confirmMembershipTransfer}
        onOpenSession={(channelId) => { setSelectedChannelId(channelId); setSessionListRequested(false) }}
      />
    ) : null}
    {memoryInspection ? <TeamMemoryInspectionDialog key={`${memoryInspection.request.memoryId}:${memoryInspection.request.version}`} request={memoryInspection.request} initial={memoryInspection.value}
      onClose={() => setMemoryInspection(undefined)} onOpenGroup={memoryInspection.request.groupId ? () => {
        const target = { kind: 'run' as const, runId: memoryInspection.request.runId, groupId: memoryInspection.request.groupId }
        if (notificationContext.current.team.activeWorkspaceId!==memoryInspection.request.workspaceId||!notificationTargetAvailable(target, notificationContext.current.sessions, notificationContext.current.team)) return false
        setFocusGroupId(target.groupId); changeModule('run'); return true
      } : undefined} /> : null}
    {contextHandoffChannel && contextHandoffSession ? (
      <SessionHandoffDialog
        key={contextHandoffChannel}
        session={contextHandoffSession}
        sessions={visibleSnapshot.sessions}
        standbyChannelIds={teamControl.standbyChannels.map((channel) => channel.channelId)}
        loadContext={loadHandoffContext}
        deliver={async (input) => {
          const result = await deliverHandoff(input)
          acceptSnapshot(await window.sgDesktop.getSnapshot())
          return result
        }}
        revealPath={revealHandoffPath}
        onOpenSession={(channelId) => { setSelectedChannelId(channelId); setSessionListRequested(false) }}
        onClose={() => setContextHandoffChannel(undefined)}
      />
    ) : null}
    {runtimeGuard ? (
      <RuntimeAccountGuardDialog
        verify={runtimeGuard.verify}
        allowProceed={runtimeGuard.allowProceed}
        canSwitch={cursorAccounts.some((account) => account.active)}
        busy={runtimeGuardBusy}
        error={runtimeGuardError}
        onClose={() => { if (!runtimeGuardBusy) setRuntimeGuard(undefined) }}
        onProceed={() => void continueGuardedLaunch()}
        onSwitchAndRestart={() => void switchAndContinueLaunch()}
      />
    ) : null}
    {membershipGuard ? (
      <MembershipGuardDialog
        status={membershipGuard.status}
        message={membershipGuard.message}
        busy={membershipGuardBusy}
        error={membershipGuardError}
        onClose={() => { if (!membershipGuardBusy) setMembershipGuard(undefined) }}
        onRefresh={() => void refreshMembershipAndContinue()}
      />
    ) : null}
    </>
  )
}
