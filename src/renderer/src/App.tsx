import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QuestionActions } from './QuestionCard'
import type {
  CreateIndependentSessionsInput,
  DesktopSnapshot
} from '../../shared/desktop-api'
import { emptyTaskPoolSnapshot, newestTaskPoolSnapshot } from '../../domain/task-pool'
import type { CursorUsageSnapshot } from '../../domain/cursor-usage'
import { emptyTeamControlSnapshot, type TeamRunStatus } from '../../domain/team-control'
import { emptyTeamCollaborationSnapshot } from '../../domain/team-collaboration'
import { DesktopShell, type AppModule } from './DesktopShell'
import { SessionOverview } from './SessionOverview'
import { SessionWorkspace } from './SessionWorkspace'
import { SessionSidebar } from './SessionSidebar'
import { WorkspaceInspector } from './WorkspaceInspector'
import { RunPage } from './run/RunPage'
import { SettingsPage } from './settings/SettingsPage'
import type { SettingsPageProps } from './settings/settings-view'
import { ManualHandoffDialog } from './team/ManualHandoffDialog'
import { SessionHandoffDialog } from './SessionHandoffDialog'
import { resolveHandoffEntry } from './handoff-entry'
import type { MembershipTransferOptions, MembershipTransferOutcome } from '../../domain/team-handoff'
import type { CursorAccountMetadata, CursorRuntimeAccountMatch } from '../../domain/cursor-account'
import type { CursorMembershipStatus } from '../../domain/cursor-membership'
import type { CursorUpdatePreferences } from '../../domain/cursor-update'
import type { CursorSwitchPumpStatus } from '../../domain/cursor-switch-pump'
import type { CursorStorageCleanupResult, CursorStorageScan } from '../../domain/cursor-storage-cleanup'
import type { AozaiCardStatus, AozaiProgressEvent } from '../../domain/aozai-service'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../../domain/agent-launch'
import type { SessionWarmupRun } from '../../domain/session-warmup'
import type { AccountAutomationRun, AccountAutomationSettings } from '../../domain/account-automation'
import type { CdpAutoHealEvent } from '../../domain/cursor-cdp'
import { DEFAULT_SEAT_ROTATION_SETTINGS, type SeatRotationSettings } from '../../domain/seat-rotation'
import type { MessageAttachment } from '../../domain/conversation-entry'
import { mergeDesktopSnapshot, snapshotGaps } from './snapshot-sharing'
import { userFacingErrorMessage } from './error-message'
import { resolveRuntimeLaunchGate } from './lobby/runtime-account-gate'
import { RuntimeAccountGuardDialog } from './lobby/RuntimeAccountGuardDialog'
import { resolveMembershipLaunchGate } from './lobby/membership-gate'
import { MembershipGuardDialog } from './lobby/MembershipGuardDialog'
import type { CursorWorkspaceDetection } from '../../domain/cursor-workspace'
import {
  shouldShowCollaborationForRun,
  visibleTeamCollaborationSnapshot
} from './team/team-collaboration-view'
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
  const [cursorAccountError, setCursorAccountError] = useState('')
  // 升级 Pro 结账结果反馈（待扫码/复核通过/失败原因）；按账号粒度置忙在组件内。
  const [proUpgradeFeedback, setProUpgradeFeedback] = useState<{ ok: boolean; message: string } | null>(null)
  const [cursorUpdatePreferences, setCursorUpdatePreferences] = useState<CursorUpdatePreferences>()
  const [cursorUpdateBusy, setCursorUpdateBusy] = useState(false)
  const [cursorUpdateError, setCursorUpdateError] = useState('')
  // 切号补丁（无感换号依赖）：状态卡只读检测 + 一键安装/卸载
  const [switchPumpStatus, setSwitchPumpStatus] = useState<CursorSwitchPumpStatus>()
  const [switchPumpBusy, setSwitchPumpBusy] = useState(false)
  const [switchPumpFeedback, setSwitchPumpFeedback] = useState<{ ok: boolean; message: string }>()
  // 存储清理：盘点结果只来自主进程；清理结果自带清理后的新盘点
  const [storageScan, setStorageScan] = useState<CursorStorageScan>()
  const [storageScanBusy, setStorageScanBusy] = useState(false)
  const [storageScanError, setStorageScanError] = useState('')
  const [storageCleanupBusy, setStorageCleanupBusy] = useState(false)
  const [storageCleanupResult, setStorageCleanupResult] = useState<CursorStorageCleanupResult>()
  const [aozaiStatus, setAozaiStatus] = useState<AozaiCardStatus>({ saved: false })
  const [aozaiBusy, setAozaiBusy] = useState(false)
  const [aozaiError, setAozaiError] = useState('')
  const [aozaiProgress, setAozaiProgress] = useState<AozaiProgressEvent | null>(null)
  const [aozaiFeedback, setAozaiFeedback] = useState<{ ok: boolean; message: string } | null>(null)
  const [agentLaunchPlan, setAgentLaunchPlan] = useState<AgentLaunchPlan | undefined>(undefined)
  // 会话预热探针：批量发起前用最低成本模型验证账号能真实跑通响应（绝不触发账号自动化）。
  const [sessionWarmupRun, setSessionWarmupRun] = useState<SessionWarmupRun | undefined>(undefined)
  const [sessionWarmupEnabled, setSessionWarmupEnabled] = useState<boolean>(() => readSessionWarmupEnabled())
  const [accountAutomationSettings, setAccountAutomationSettings] = useState<AccountAutomationSettings>({ enabled: false, delaySec: 30, postProcessDelaySec: 30 })
  const [accountAutomationRun, setAccountAutomationRun] = useState<AccountAutomationRun | undefined>(undefined)
  // 席位自动轮换设置（结果不在这里：轮换进度与结论投影在会话快照 seatRotation 上）。
  const [seatRotationSettings, setSeatRotationSettings] = useState<SeatRotationSettings>({ ...DEFAULT_SEAT_ROTATION_SETTINGS })
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
  const mcpReconcileRunRef = useRef<string | undefined>(undefined)
  const activeRunRef = useRef<{ id?: string; status?: TeamRunStatus }>({})
  const activeWorkspace = teamControl.workspaces.find((workspace) => workspace.id === teamControl.activeWorkspaceId)
  const activeProjectName = activeWorkspace?.name ?? cursorWorkspace?.workspace?.name
  const memberChannelIds = teamControl.members
    .map((member) => member.binding?.channelId ?? member.slot.channelId)
    .filter((channelId): channelId is string => Boolean(channelId))
  const memberChannelKey = memberChannelIds
    .sort()
    .join(',')
  const reconcileKeyOf = (snapshot: ReturnType<typeof emptyTeamControlSnapshot>): string | undefined => {
    if (!snapshot.activeRun) return undefined
    const channels = snapshot.members
      .map((member) => member.binding?.channelId ?? member.slot.channelId)
      .filter((channelId): channelId is string => Boolean(channelId))
      .sort()
      .join(',')
    return `${snapshot.activeRun.id}:${channels}`
  }

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
      if (!activeRun.id || !['launching', 'running', 'attention', 'paused'].includes(activeRun.status ?? '')) {
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
      .catch((reason: unknown) => setCursorAccountError(reason instanceof Error ? reason.message : String(reason)))
    void window.sgDesktop.getAozaiCardStatus()
      .then(setAozaiStatus)
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
    void window.sgDesktop.getSeatRotationSettings()
      .then(setSeatRotationSettings)
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
    const unsubscribeAozai = window.sgDesktop.onAozaiProgress(setAozaiProgress)
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
    void window.sgDesktop.getCursorSwitchPumpStatus()
      .then(setSwitchPumpStatus)
      .catch(() => {})
    const unsubscribeAccountAutomation = window.sgDesktop.onAccountAutomationProgress((run) => {
      setAccountAutomationRun(run)
      if (run.phase === 'done' || run.phase === 'failed') {
        // 自动化会改动账号列表（新 token 入库 / 移除本地记录），终态后刷新
        void window.sgDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
        // 链内为提速跳过了余额刷新，这里链外异步补齐
        void window.sgDesktop.refreshAozaiBalance().then(setAozaiStatus).catch(() => {})
        // 活跃账号可能已被移除/换发，一致性指示立即重算（不等 30s 轮询）
        void refreshRuntimeMatch()
        // 奥仔处理会改变账号档位，档位行同样立即重查
        void refreshMembership()
        void refreshAccountMemberships()
      }
    })
    return () => {
      unsubscribeAozai()
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
    mcpReconcileRunRef.current = reconcileKeyOf(created)
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
      if (plan.state === 'done') setTeamNotice('会话已全部就绪，可以启动团队。')
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

  const refreshAozaiBalance = useCallback(async (options: { silent?: boolean } = {}): Promise<void> => {
    if (!options.silent) {
      setAozaiBusy(true)
      setAozaiError('')
    }
    try {
      setAozaiStatus(await window.sgDesktop.refreshAozaiBalance())
    } catch (reason) {
      if (!options.silent) setAozaiError(userFacingErrorMessage(reason))
    } finally {
      if (!options.silent) setAozaiBusy(false)
    }
  }, [])

  const saveAozaiCard = useCallback(async (cardCode: string): Promise<void> => {
    setAozaiBusy(true)
    setAozaiError('')
    setAozaiFeedback(null)
    try {
      setAozaiStatus(await window.sgDesktop.saveAozaiCard(cardCode))
    } catch (reason) {
      setAozaiError(userFacingErrorMessage(reason))
      throw reason
    } finally {
      setAozaiBusy(false)
    }
  }, [])

  const clearAozaiCard = useCallback(async (): Promise<void> => {
    setAozaiBusy(true)
    setAozaiError('')
    setAozaiFeedback(null)
    try {
      setAozaiStatus(await window.sgDesktop.clearAozaiCard())
    } catch (reason) {
      setAozaiError(userFacingErrorMessage(reason))
    } finally {
      setAozaiBusy(false)
    }
  }, [])

  const processAozaiAccount = useCallback(async (accountId: string): Promise<void> => {
    setAozaiBusy(true)
    setAozaiError('')
    setAozaiFeedback(null)
    setAozaiProgress(null)
    try {
      const result = await window.sgDesktop.processAozaiAccount({ accountId, requestId: crypto.randomUUID() })
      setAozaiFeedback({ ok: result.ok, message: result.message })
      setAozaiStatus((previous) => ({
        ...previous,
        remaining: typeof result.remaining === 'number' ? result.remaining : previous.remaining
      }))
      // 处理完成 = 档位大概率已变（free → 试用/付费），立即重查被动档位行。
      if (result.ok) void refreshMembership()
    } catch (reason) {
      setAozaiFeedback({ ok: false, message: userFacingErrorMessage(reason) })
    } finally {
      setAozaiBusy(false)
      setAozaiProgress(null)
    }
  }, [refreshMembership])

  // 手动模式：token 由用户粘贴，不属于库内账号——不触发档位重查，其余状态流与账号处理一致。
  const processAozaiToken = useCallback(async (token: string): Promise<void> => {
    setAozaiBusy(true)
    setAozaiError('')
    setAozaiFeedback(null)
    setAozaiProgress(null)
    try {
      const result = await window.sgDesktop.processAozaiToken({ token, requestId: crypto.randomUUID() })
      setAozaiFeedback({ ok: result.ok, message: result.message })
      setAozaiStatus((previous) => ({
        ...previous,
        remaining: typeof result.remaining === 'number' ? result.remaining : previous.remaining
      }))
    } catch (reason) {
      setAozaiFeedback({ ok: false, message: userFacingErrorMessage(reason) })
    } finally {
      setAozaiBusy(false)
      setAozaiProgress(null)
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
    const run = teamControl.activeRun
    if (!run || !['draft', 'ready'].includes(run.status)) return
    if (memberChannelIds.length === 0) return
    const topologyKey = `${run.id}:${memberChannelKey}`
    if (mcpReconcileRunRef.current === topologyKey) return
    mcpReconcileRunRef.current = topologyKey
    void window.sgDesktop.installTaskMcp()
      .then(async () => {
        setTeamNotice('本轮通道已自动接入 SG Team。')
        acceptTeamControl(await window.sgDesktop.getTeamControlSnapshot())
      })
      .catch((reason: unknown) => {
        setTeamNotice(`自动接入 MCP 失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }, [
    acceptTeamControl,
    teamControl.activeRun?.id,
    teamControl.activeRun?.status,
    memberChannelKey
  ])

  useEffect(() => {
    if (!teamControlLoaded) return
    const run = teamControl.activeRun
    activeRunRef.current = { id: run?.id, status: run?.status }
    setCollaboration((previous) => {
      if (!shouldShowCollaborationForRun(previous, run)) {
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
  // 统计页组来源：活动 run 的 active 组 → 成员通道号；组求和 = 成员席位之和（阶段 2 · 2E）。
  const statsGroups = useMemo(() => teamControl.groups
    .filter((view) => view.group.status === 'active')
    .map((view) => ({
      key: view.group.id,
      label: view.group.name,
      channelIds: view.members.flatMap((member) => {
        const channelId = member.binding?.channelId ?? member.slot.channelId
        return channelId ? [channelId] : []
      })
    })), [teamControl.groups])
  const selectedSession = visibleSnapshot.sessions.find((session) => session.channelId === selectedChannelId)
  const selectedMember = teamControl.members.find((member) => (
    (member.binding?.channelId ?? member.slot.channelId) === selectedSession?.channelId
  ))
  // 会话工作区回调的引用稳定化：draft 每次按键都触发 App 重渲染，这些回调若内联新建，
  // 会把 SessionWorkspace 时间线的 memo 边界打穿（所有历史卡被迫参与 reconciliation）。
  const workspaceChannelId = selectedSession?.channelId ?? ''
  const handleWorkspaceDraftChange = useCallback((value: string): void => {
    if (!workspaceChannelId) return
    setComposerDrafts((current) => ({ ...current, [workspaceChannelId]: value }))
  }, [workspaceChannelId])
  const workspaceQuestionActions = useMemo((): QuestionActions => ({
    answer: (toolCallId, draft) => window.sgDesktop.answerCursorQuestion({
      channelId: workspaceChannelId, toolCallId, ...draft
    }),
    skip: (toolCallId) => window.sgDesktop.skipCursorQuestion({ channelId: workspaceChannelId, toolCallId })
  }), [workspaceChannelId])
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
  const activeRunCollaboration = useMemo(() => (
    visibleTeamCollaborationSnapshot(collaboration, teamControl.activeRun)
  ), [collaboration, teamControl.activeRun])
  const changeModule = useCallback((module: AppModule): void => {
    setActiveModule(module)
    if (module === 'sessions') setSessionListRequested(false)
  }, [])

  const openManualHandoff = useCallback(async (slotId: string): Promise<void> => {
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
  const confirmManualHandoff = useCallback(async (
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
    error: cursorAccountError,
    onSave: async (input) => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        setCursorAccounts(await window.sgDesktop.saveCursorAccount(input))
        // 新账号默认设为活跃（makeActive），一致性锚点变化 → 立即重算指示
        void refreshRuntimeMatch()
        // 新活跃账号档位未知，档位行同步重查
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)); throw reason }
      finally { setCursorAccountBusy(false) }
    },
    onSaveCard: async (input) => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        const result = await window.sgDesktop.saveCursorAccountCard(input)
        setCursorAccounts(result.accounts)
        // 与 onSave 同理：卡号导入默认活跃，一致性锚点与档位同步重查
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
        return { outcome: result.outcome, label: result.label, tokenRefreshed: result.tokenRefreshed, loginError: result.loginError }
      }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)); throw reason }
      finally { setCursorAccountBusy(false) }
    },
    onReloginAccount: async (accountId) => {
      // 自动登录可能等人机验证（最长约 2 分钟）：不锁全局 busy，按账号粒度置忙；
      // 失败走账号区错误条，成功后列表刷新（maskedToken 变化即可见确认）。
      try {
        const result = await window.sgDesktop.loginCursorAccount(accountId)
        setCursorAccounts(result.accounts)
        void refreshRuntimeMatch()
      }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)); throw reason }
    },
    onStartProUpgrade: async (accountId) => {
      // 结账链可能等页面加载/人机验证（最长约 2 分钟）：不锁全局 busy（组件内按账号置忙）。
      // 结果不分成败都走反馈条——awaiting_payment（请扫码）与 verified（复核通过）都是正常出口。
      setProUpgradeFeedback(null)
      try {
        const result = await window.sgDesktop.startCursorProUpgrade(accountId)
        setProUpgradeFeedback({ ok: true, message: result.detail })
      }
      catch (reason) {
        setProUpgradeFeedback({ ok: false, message: reason instanceof Error ? reason.message : String(reason) })
        throw reason
      }
    },
    proUpgradeFeedback,
    onSelect: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try { setCursorAccounts(await window.sgDesktop.selectCursorAccount(accountId)) }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setCursorAccountBusy(false) }
      // 换活跃账号会改变劈叉判定（Cursor 登录没变、锚点变了），立即刷新状态行
      void refreshRuntimeMatch()
      // 换活跃账号 = 档位锚点变化，同步重查
      void refreshMembership()
    },
    // 窗口绑定是纯本地元信息写入：不锁账号 busy（避免改绑时整行按钮闪禁），失败走账号区错误条
    onSetAccountFingerprintProfile: async (accountId, profileId) => {
      try { setCursorAccounts(await window.sgDesktop.setCursorAccountFingerprintProfile(accountId, profileId)) }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
    },
    onRemove: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        setCursorAccounts(await window.sgDesktop.removeCursorAccount(accountId))
        // 删除活跃账号时 vault 会顺延活跃位，一致性锚点变化 → 立即重算指示
        void refreshRuntimeMatch()
        // 活跃位顺延后档位未知，同步重查
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setCursorAccountBusy(false) }
    },
    onImportFromLocal: async () => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        setCursorAccounts(await window.sgDesktop.importCursorAccountFromLocalCursor())
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setCursorAccountBusy(false) }
    },
    onImportFromBrowser: async () => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        setCursorAccounts(await window.sgDesktop.importCursorAccountFromBrowser())
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setCursorAccountBusy(false) }
    },
    onImportFromFingerprint: async () => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        setCursorAccounts(await window.sgDesktop.importCursorAccountFromFingerprint())
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships()
      }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setCursorAccountBusy(false) }
    },
    // 提前登录：开窗导航 cursor.com（不关窗；失败提示走账号区错误条）
    onOpenFingerprintLogin: async () => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try { await window.sgDesktop.openFingerprintLoginPage() }
      catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setCursorAccountBusy(false) }
    },
    onCleanupFingerprintEnvironment: async () => {
      // 清理只影响指纹浏览器 profile，不锁账号操作（面板内自有 busy/反馈态）。
      await window.sgDesktop.cleanupFingerprintEnvironment()
    },
    onRestartWithAccount: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        const result = await window.sgDesktop.restartCursorWithAccount(accountId)
        if (!result.switched) return
        if (!result.runtimeVerified) {
          setCursorAccountError('⚠️ Cursor 已重启，但运行时登录态尚未完成确认。')
          return
        }
        if (result.tokenExpired) {
          setCursorAccountError('⚠️ 该账号的 Token 已过期，请重新获取后再切换。')
          return
        }
        const relaunchNote = result.relaunchMode === 'cdp'
          ? result.cdpPortReady
            ? '调试端口已就绪，会话创建能力立即可用。'
            : '已带调试端口拉起，端口仍在启动中，稍候即可创建会话。'
          : result.relaunchMode === 'failed'
            ? '拉起 Cursor 失败，请手动启动 Cursor。'
            : '已重新拉起 Cursor。'
        setCursorAccountError(
          `✅ Cursor 运行时已确认目标账号，登录态与机器码均已落库（${result.killedCursor ? '已重启' : 'Cursor 原先未运行'}；${relaunchNote}）`
        )
        // 切换成功 = 运行态与活跃账号重新对齐，立即刷新被动状态行
        void refreshRuntimeMatch()
        // 切换后运行账号变了，档位行同步重查
        void refreshMembership()
        void refreshAccountMemberships([accountId])
      } catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally {
        // 冷切换的每个出口 vault 都可能已变（activeId + 清「待重启对齐」标记）：
        // 无条件回读，「当前」徽标与账号行标记跟 vault 真实状态对齐，不留旧值。
        void window.sgDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
        setCursorAccountBusy(false)
      }
    },
    onSwitchLiveAccount: async (accountId) => {
      setCursorAccountBusy(true); setCursorAccountError('')
      try {
        const result = await window.sgDesktop.switchCursorAccountLive(accountId)
        if (!result.switched) {
          setCursorAccountError(`⚠️ 无感换号未完成：${result.reason ?? '未知原因'}。可改用「切换并重启」。`)
          return
        }
        setCursorAccountError(result.warning
          ? `⚠️ 已换号，但本地状态需要处理：${result.warning}`
          : '✅ 已换号，Cursor 无需重启——令牌、邮箱与账号缓存均已刷新；机器码待下次「切换并重启」时对齐。')
        void refreshRuntimeMatch()
        void refreshMembership()
        void refreshAccountMemberships([accountId])
        // pendingMachineAlign 标记随热切置位，账号行标记立即刷新
        void window.sgDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
      } catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setCursorAccountBusy(false) }
    },
    runtimeMatch,
    membership: membershipStatus,
    accountMemberships,
    onRefreshMembership: async (accountId) => {
      if (accountId) await refreshAccountMemberships([accountId])
      else await refreshMembership()
    },
    aozaiStatus,
    aozaiBusy,
    aozaiError,
    aozaiProgress,
    aozaiFeedback,
    onSaveAozaiCard: saveAozaiCard,
    onClearAozaiCard: clearAozaiCard,
    onRefreshAozaiBalance: refreshAozaiBalance,
    onProcessAozaiAccount: processAozaiAccount,
    onProcessAozaiToken: processAozaiToken,
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
      void window.sgDesktop.listAccountAutomationBitProfiles()
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
    onRefreshSwitchPumpStatus: () => {
      void window.sgDesktop.getCursorSwitchPumpStatus()
        .then(setSwitchPumpStatus)
        .catch(() => {})
    },
    onEnsureSwitchPump: async () => {
      setSwitchPumpBusy(true); setSwitchPumpFeedback(undefined)
      try {
        const outcome = await window.sgDesktop.ensureCursorSwitchPump()
        setSwitchPumpFeedback({
          ok: outcome.ok,
          message: outcome.warning ? `${outcome.message}（${outcome.warning}）` : outcome.message
        })
      } catch (reason) {
        setSwitchPumpFeedback({ ok: false, message: userFacingErrorMessage(reason) })
      } finally {
        setSwitchPumpBusy(false)
        // 安装/改写后状态可能变化（installed/config），无条件重读一次
        void window.sgDesktop.getCursorSwitchPumpStatus().then(setSwitchPumpStatus).catch(() => {})
      }
    },
    onRemoveSwitchPump: async () => {
      setSwitchPumpBusy(true); setSwitchPumpFeedback(undefined)
      try {
        const outcome = await window.sgDesktop.removeCursorSwitchPump()
        setSwitchPumpFeedback({
          ok: outcome.ok,
          message: outcome.warning ? `${outcome.message}（${outcome.warning}）` : outcome.message
        })
      } catch (reason) {
        setSwitchPumpFeedback({ ok: false, message: userFacingErrorMessage(reason) })
      } finally {
        setSwitchPumpBusy(false)
        void window.sgDesktop.getCursorSwitchPumpStatus().then(setSwitchPumpStatus).catch(() => {})
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
      if (enabled) {
        const result = await window.sgDesktop.acknowledgeCursorModelDataPolicies()
        // 政策导航若换发了 token，主进程已对同一活跃账号原地入库。
        if (result.tokenUpdated) setCursorAccounts(await window.sgDesktop.listCursorAccounts())
        message = `${result.message}；后续新账号将自动检查`
      }
      const saved = await window.sgDesktop.saveAccountAutomationSettings({
        ...accountAutomationSettings,
        autoAcknowledgeModelDataPolicies: enabled
      })
      setAccountAutomationSettings(saved)
      return { message }
    },
    onSaveAutomationSettings: (settings) => {
      void window.sgDesktop.saveAccountAutomationSettings(settings)
        .then((saved) => setAccountAutomationSettings(saved))
        .catch((reason: unknown) => setAozaiError(userFacingErrorMessage(reason)))
    },
    onCancelAutomation: () => {
      void window.sgDesktop.cancelAccountAutomation().catch(() => {})
    },
    seatRotationSettings,
    onSaveSeatRotationSettings: (settings) => {
      // 乐观更新：滑杆拖动即时反馈；主进程归一化后的值回写覆盖。
      setSeatRotationSettings(settings)
      void window.sgDesktop.saveSeatRotationSettings(settings)
        .then(setSeatRotationSettings)
        .catch((reason: unknown) => setTeamNotice(`席位自动轮换设置未保存：${userFacingErrorMessage(reason)}`))
    }
  }

  return (
    <>
    <DesktopShell
      snapshot={visibleSnapshot}
      activeModule={activeModule}
      sidebar={activeModule === 'sessions' ? (
        <SessionSidebar
          snapshot={visibleSnapshot}
          selectedChannelId={selectedSession?.channelId}
          onSelectSession={selectSession}
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
          hidden={!visible}
          onQuoteToComposer={handleWorkspaceQuote}
          onClose={close}
        />
      ) : undefined}
      cursorWorkspace={cursorWorkspace}
      workspace={activeWorkspace}
      wideContent={activeModule !== 'sessions'}
      teamChannelIds={memberChannelIds}
      cardOpacity={appearance.cardOpacity}
      colorMode={appearance.colorMode}
      accent={appearance.accent}
      onModuleChange={changeModule}
      onCardOpacityChange={(cardOpacity) => changeAppearance({ cardOpacity })}
      onColorModeChange={(colorMode) => changeAppearance({ colorMode })}
      onAccentChange={(accent) => changeAppearance({ accent })}
      onOpenProjectConfiguration={() => changeModule('run')}
    >
      {activeModule === 'account' ? (
        <SettingsPage {...accountPanel} />
      ) : activeModule === 'run' ? (
        <RunPage
          team={teamControl}
          detectedWorkspace={cursorWorkspace?.workspace}
          externalNotice={teamNotice}
          agentLaunchPlan={agentLaunchPlan}
          cursorModels={visibleSnapshot.cursorModels ?? []}
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
          onPersistModelSelection={async (channelId, selection) => {
            const result = await window.sgDesktop.setSlotModelSelection(channelId, selection)
            acceptTeamControl(result)
            return result
          }}
          groupActions={{
            createGroup: async (input) => acceptTeamControl(await window.sgDesktop.createTeamGroup(input)),
            addGroupMembers: async (input) => acceptTeamControl(await window.sgDesktop.addTeamGroupMembers(input)),
            removeGroupMember: async (input) => acceptTeamControl(await window.sgDesktop.removeTeamGroupMember(input)),
            setGroupLead: async (input) => acceptTeamControl(await window.sgDesktop.setTeamGroupLead(input)),
            updateGroupGoal: async (input) => acceptTeamControl(await window.sgDesktop.updateTeamGroupGoal(input)),
            dissolveGroup: async (input) => acceptTeamControl(await window.sgDesktop.dissolveTeamGroup(input))
          }}
          onEnableCursorCdp={() => window.sgDesktop.enableCursorCdp()}
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
          entries={snapshot.conversations[selectedSession.channelId] ?? []}
          currentProjectName={activeProjectName}
          onBack={() => { setSessionListRequested(true); setSelectedChannelId(undefined) }}
          onHandoff={handoffEntry.kind === 'context'
            ? () => setContextHandoffChannel(selectedSession.channelId)
            : handoffEntry.kind === 'roles'
              ? () => void openManualHandoff(handoffEntry.slotId)
              : undefined}
          handoffTitle={handoffEntry.title}
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
          onSend={handleWorkspaceSend}
        />
      ) : (
        <SessionOverview
          snapshot={visibleSnapshot}
          onOpenConfiguration={() => setActiveModule('run')}
          onCreateIndependentSessions={() => setActiveModule('run')}
        />
      )}
    </DesktopShell>
    {handoffOptions ? (
      <ManualHandoffDialog
        key={handoffOptions.sourceSlotId}
        options={handoffOptions}
        busy={handoffBusy}
        error={handoffError}
        onClose={() => { if (!handoffBusy) setHandoffOptions(undefined) }}
        onConfirm={confirmManualHandoff}
        onOpenSession={(channelId) => { setSelectedChannelId(channelId); setSessionListRequested(false) }}
      />
    ) : null}
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
