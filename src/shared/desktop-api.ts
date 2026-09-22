import type { AgentSession } from '../domain/agent-session'
import type { ConversationEntry, ProcessBlock } from '../domain/conversation-entry'
import type { PlanTaskInput, TaskPoolSnapshot, TeamTask } from '../domain/task-pool'
import type { TeamControlSnapshot, TeamGroupPlanPolicy } from '../domain/team-control'
import type { TeamCollaborationSnapshot } from '../domain/team-collaboration'
import type { TeamMemorySnapshot } from '../domain/team-memory'
import type { CursorAccountMetadata, CursorRuntimeAccountMatch } from '../domain/cursor-account'
import type { CursorProUpgradeResult } from '../domain/cursor-checkout-profile'
import type { CursorMembershipStatus } from '../domain/cursor-membership'
import type { MembershipTransferInput, MembershipTransferOptions, MembershipTransferOutcome } from '../domain/team-handoff'
import type { CursorWorkspaceDetection } from '../domain/cursor-workspace'
import type { CursorModelOption, CursorModelSelection } from '../domain/cursor-model'
import type {
  ProcessingCredentialStatus,
  ProcessingProgressEvent,
  ProcessingProviderId,
  ProcessingResult
} from '../domain/processing-provider'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../domain/agent-launch'
import type { SessionWarmupRun } from '../domain/session-warmup'
import type { CdpAutoHealEvent, CursorCdpSettings } from '../domain/cursor-cdp'
import type { AccountAutomationRun, AccountAutomationSettings } from '../domain/account-automation'
import type { CursorSwitchPumpOutcome, CursorSwitchPumpStatus } from '../domain/cursor-switch-pump'
import type { CursorUpdatePreferences, CursorUpdateWriteResult } from '../domain/cursor-update'
import type { CursorUsageSnapshot } from '../domain/cursor-usage'
import type {
  CursorStorageCleanupRequest,
  CursorStorageCleanupResult,
  CursorStorageItemId,
  CursorStorageScan
} from '../domain/cursor-storage-cleanup'
import type {
  WorkspaceOpenFileResult,
  WorkspaceReviewActionInput,
  WorkspaceReviewActionResult,
  WorkspaceReviewFileDiff,
  WorkspaceReviewScope,
  WorkspaceReviewSummary
} from '../domain/workspace-review'
import type { SessionHandoffContext, SessionHandoffRequest, SessionHandoffResult } from '../domain/session-handoff'
import type { CursorStatusLine } from '../domain/cursor-status-line'
import type { AppUpdateSettings, AppUpdateStatus, UpdateGate } from '../domain/app-update'

export type BridgeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

/** 一回合的 Cursor 原生实时过程流。 */
export interface LiveProcessState {
  turn: string
  blocks: ProcessBlock[]
  /** 原生超长回合因传输上限折叠的步骤数。 */
  truncatedItemCount?: number
  startedAt: number
  updatedAt: number
  /**
   * 服务端确认的回合生成状态（RC-9）：Cursor 常把生成中的 Thinking 块标记为
   * done，靠「某块 running」猜测会把仍在生成的直播过程误判为历史——
   * 误判会跳过打字机播放器直接整段显示。渲染层以本字段为权威直播信号。
   */
  generating?: boolean
}

/** Cursor Composer 正在生成的原生回复；只存在于实时层，不写历史消息。 */
export interface LiveAgentResponseState {
  id: string
  channelId: string
  text: string
  status: 'streaming' | 'complete'
  startedAt: number
  updatedAt: number
  /** 生命周期守卫用的证据来源（渲染层不消费）：observer 原生帧 / runtime inspect / 转录兜底。 */
  source?: 'native' | 'inspect' | 'transcript'
}

export interface NativeProcessStreamStatus {
  state: 'connected' | 'reconnecting' | 'unavailable'
  detail: string
  updatedAt: number
}

/**
 * 名册常驻状态行的 Cursor 侧事实（hook v32 / runtime inspect 每帧携带）：与 Cursor 会话列表
 * 副标题同一算法。只存在于实时层——不进封口、不落库、不参与虚拟回合。
 */
export interface LiveStatusLineState {
  composerId: string
  /** 回合存活（Cursor composer status === 'generating'）；决定显示 statusLine 还是 Completed / Stopped。 */
  generating: boolean
  /** Cursor 回合状态原文（generating / aborted / completed / none）。 */
  composerStatus?: string
  /** 回合存活时的副标题；Cursor 一个都扫不到时缺省（渲染层落到 "Planning next moves"）。 */
  statusLine?: CursorStatusLine
  updatedAt: number
}

export interface BridgeConnection {
  state: BridgeConnectionState
  endpoint: string
  attempt: number
  lastError: string
}

export interface DesktopSnapshot {
  connection: BridgeConnection
  sessions: AgentSession[]
  /**
   * 每通道时间线。进程内与 `getSnapshot` 拉取回包里始终完整；`onSnapshot` 推送里
   * 只含渲染层尚未持有该版本的通道（主进程按 `conversationRevisions` 瘦身，见 snapshot-push.ts），
   * 渲染层按版本合并（snapshot-sharing.ts）。
   */
  conversations: Record<string, ConversationEntry[]>
  /**
   * 每通道时间线的版本号，始终完整：主进程里同一数组引用 = 同一版本。IPC 结构化克隆抹掉引用身份，
   * 渲染层据此按值复用上一份快照的数组，未变通道的历史回合不重渲，也据此识别推送里被省略的通道。
   */
  conversationRevisions?: Record<string, number>
  /**
   * 不进入会话时间线的投递回执（key = commandId）。
   * 用于系统内部通知等静默消息，让调度器能确认送达但不污染用户会话。
   */
  commandReceipts?: Record<string, ConversationEntry>
  /** 按通道映射的 Cursor 原生实时过程流。 */
  liveProcess?: Record<string, LiveProcessState>
  /** 按通道映射的 Cursor 原生流式回复。record_reply 落地后自动移除。 */
  liveAgentResponses?: Record<string, LiveAgentResponseState>
  /** 按通道映射的名册状态行事实（Cursor 侧栏副标题同源）；随作用域切换清空。 */
  liveStatusLine?: Record<string, LiveStatusLineState>
  /** Cursor 原生过程观察器健康度；断链时 UI 必须明确披露。 */
  nativeProcessStream?: NativeProcessStreamStatus
  protocolIssues: string[]
  /** Cursor 模型目录（约 80KB）。与 conversations 同一套推送瘦身：渲染层已持有同版本时推送里省略。 */
  cursorModels?: CursorModelOption[]
  /** 模型目录的版本号（同一数组引用 = 同一版本），与 conversationRevisions 同源。 */
  cursorModelsRevision?: number
  updatedAt: number
}

export interface SendMessageInput {
  channelId: string
  text: string
  /** 主进程内部轮次栅栏；渲染层普通发送不填写。 */
  scopeRunId?: string
  /** 消息附件（图片/文件） */
  attachments?: import('../domain/conversation-entry').MessageAttachment[]
  /**
   * 静默投递：消息只进出站队列（Agent 可收到），不写入会话时间线。
   * 用于系统内部协作通知（如团队消息投递提醒），避免对用户刷屏。
   */
  silent?: boolean
  /**
   * 投递类型（主进程内部）：`internal` 等价 silent；`membership` 是拾光服务端的成员关系通知
   *（入组 / 出组 / 解散 / lead 变更），同为 silent，但投递时用成员关系后缀而非内部协作后缀。
   * 渲染层普通发送不填写。
   */
  kind?: 'user' | 'internal' | 'membership'
  /**
   * 「等待新会话」：消息留给该席位重建/重启后的新会话，当前会话取不到。
   * 渲染层只填这个布尔；主进程按席位现任会话令牌换算为 holdSessionToken。
   */
  holdUntilNewSession?: boolean
  /** 主进程内部：保持位令牌（渲染层不填写）。 */
  holdSessionToken?: string
}

export interface QueuedMessageRef {
  channelId: string
  /** 时间线条目 id（outbox:<id>）。 */
  entryId: string
}

export interface SendMessageAccepted {
  commandId: string
}

/** 拾光卡片提交的 ask_question 答案：按题 id 的选项 id（可含自由填写哨兵）与自由填写正文。 */
export interface CursorQuestionAnswerInput {
  channelId: string
  toolCallId: string
  selections: Record<string, string[]>
  freeformTexts?: Record<string, string>
  /** 用户附言；为空时主进程按选择生成摘要（Cursor 的回退路径要求跟进消息非空）。 */
  note?: string
}

export interface CursorQuestionSkipInput {
  channelId: string
  toolCallId: string
}

export type CursorQuestionFailureCode =
  | 'invalid_input'
  | 'composer_unbound'
  | 'cdp_unavailable'
  | 'composer_not_loaded'
  | 'unsupported_runtime'
  | 'question_not_pending'
  | 'submit_failed'
  | 'unconfirmed'

export type CursorQuestionActionResult =
  | { ok: true; status: 'submitted' | 'cancelled' }
  | { ok: false; code: CursorQuestionFailureCode; message: string }

export interface CreateIndependentSessionsInput {
  workspacePath: string
  sessions: Array<{ modelSelection?: CursorModelSelection }>
}

export interface IndependentWorkspaceSelection {
  id: string
  name: string
  path: string
}

/** 会话池 · 协作组：建组 / 加人的成员配置（席位 + 组内角色模板，不能是 solo）。 */
export interface TeamGroupMemberInput {
  slotId: string
  roleTemplateKey: string
}

export interface CreateTeamGroupInput {
  name: string
  goal?: string
  members: TeamGroupMemberInput[]
  /** 可空：无 lead 的纯协作组（共享目标 + 消息 + 记忆；任务由用户在拾光里创建，或按 planPolicy 由成员规划）。 */
  leadSlotId?: string
  /** 省略 = 有 lead → lead_only，无 lead → any_member。 */
  planPolicy?: TeamGroupPlanPolicy
}

export interface TeamGroupPlanPolicyInput {
  groupId: string
  planPolicy: TeamGroupPlanPolicy
}

/** 用户为某个协作组一次规划 1–30 条任务；字段与 `team_task plan` 的任务清单一致。 */
export interface TeamGroupPlanTasksInput {
  groupId: string
  tasks: PlanTaskInput[]
}

export interface TeamGroupMembersInput {
  groupId: string
  members: TeamGroupMemberInput[]
}

export interface TeamGroupMemberRef {
  groupId: string
  slotId: string
}

export interface TeamGroupLeadInput {
  groupId: string
  /** null = 清空 lead（组变为无 lead 的纯协作组）。 */
  slotId: string | null
}

export interface TeamGroupGoalInput {
  groupId: string
  goal: string
}

/** 团队 MCP 接入结果：登记 Agent 注册身份并接管内嵌通道；失败以 IPC 异常传播。 */
export interface McpInstallationResult {
  workspacePath: string
  workspaceId: string
  runId: string
  serverNames: string[]
}

/** 卡号导入结果：accounts 为最新列表；outcome 区分新建/按 JWT sub 原地更新。 */
export interface SaveCursorAccountCardResult {
  accounts: CursorAccountMetadata[]
  outcome: 'created' | 'updated'
  accountId: string
  label: string
  /** 卡内 Token 已过期且经凭据自动登录刷新成功。 */
  tokenRefreshed?: boolean
  /** 卡内 Token 已过期且自动登录未成功（账号与凭据已保存，可稍后重试）。 */
  loginError?: string
}

export interface SgDesktopApi {
  listCursorAccounts(): Promise<CursorAccountMetadata[]>
  saveCursorAccount(input: { label: string; token: string; makeActive?: boolean }): Promise<CursorAccountMetadata[]>
  /** 卡号粘贴导入（邮箱----邮箱密码----Cursor密码----辅邮----辅邮密码----Token）：主进程权威解析，凭据整体加密随账号保存。 */
  saveCursorAccountCard(input: { card: string; makeActive?: boolean }): Promise<SaveCursorAccountCardResult>
  /** 用账号保存的凭据在指纹浏览器窗口自动登录并刷新 Token（仅卡号导入的账号）。 */
  loginCursorAccount(accountId: string): Promise<{ accounts: CursorAccountMetadata[]; outcome: 'already_logged_in' | 'logged_in' }>
  /**
   * 升级 Pro 扫码付款：在账号绑定的指纹窗口直达 Stripe 月付结账（USD · 支付宝），
   * 自动填写「自动化」设置里的账单资料并提交；窗口保留，用户扫码完成付款。
   * 登录态归属 ≠ 目标账号时 fail-closed 中止（绝不给错误账号付款）。
   */
  startCursorProUpgrade(accountId: string): Promise<CursorProUpgradeResult>
  selectCursorAccount(accountId: string): Promise<CursorAccountMetadata[]>
  removeCursorAccount(accountId: string): Promise<CursorAccountMetadata[]>
  /** 绑定/改绑/解绑账号的指纹浏览器窗口（undefined 解绑，回退默认窗口）。 */
  setCursorAccountFingerprintProfile(accountId: string, profileId?: string): Promise<CursorAccountMetadata[]>
  importCursorAccountFromLocalCursor(): Promise<CursorAccountMetadata[]>
  importCursorAccountFromBrowser(): Promise<CursorAccountMetadata[]>
  /** 第一步「获取 Token」的指纹导入：读当前选中指纹浏览器 profile 的登录态（读毕关窗，cookie 留 profile）；保存时自动绑定该窗口。 */
  importCursorAccountFromFingerprint(): Promise<CursorAccountMetadata[]>
  /** 打开选定的指纹浏览器窗口并导航到 cursor.com：用户可提前登录（cookie 落 profile，窗口不自动关）。 */
  openFingerprintLoginPage(): Promise<void>
  cleanupFingerprintEnvironment(): Promise<void>
  /** 查询并幂等确认当前指纹浏览器账号所需的受限模型数据政策。 */
  acknowledgeCursorModelDataPolicies(): Promise<{
    changed: boolean
    tokenUpdated: boolean
    modelIds: string[]
    message: string
  }>
  /**
   * 一键切换账号（FlyCursor「一键换号」同款时序）：确定性终止 Cursor → 独占写入
   * 登录态（cursorAuth/* 键）→ 重置账号绑定机器码（machineid 文件 +
   * storage.serviceMachineId + storage.json 遥测 4 键）→ 清理上一账号痕迹 →
   * 拉起 Cursor（恒附带 --remote-debugging-port，会话创建能力无缝恢复）。
   * 重启会断开全部拾光通道，UI 必须在调用前完成用户确认。
   */
  restartCursorWithAccount(accountId: string): Promise<{
    switched: boolean
    killedCursor: boolean
    relaunchMode: 'cdp' | 'plain' | 'failed'
    cdpPortReady?: boolean
    machineIdentityApplied: boolean
    backupDir?: string
    tokenExpiresAt?: number
    tokenExpired?: boolean
    runtimeVerified: boolean
  }>
  /**
   * 核对 Cursor 运行时登录态（state.vscdb cursorAuth）与拾光活跃账号是否同一账号
   * （JWT sub 比对；本地 SQLite 读，毫秒级）。发起会话前的闸门与大厅被动状态行共用。
   */
  verifyCursorRuntimeAccount(): Promise<CursorRuntimeAccountMatch>
  /**
   * 无感换号（热切）：不杀进程、不写库、不动机器码——票据经回环泵给运行中
   * Cursor 的切号补丁，硬回执到手才同步活跃账号。永不 throw；switched=false
   * 时 reason 为人话原因（补丁未装/端口占用/回执超时/换票失败）。
   */
  switchCursorAccountLive(accountId: string): Promise<{ switched: boolean; reason?: string; warning?: string }>
  /** 切号补丁只读状态（维护页状态卡）。 */
  getCursorSwitchPumpStatus(): Promise<CursorSwitchPumpStatus>
  /** 一键安装/修复切号补丁（写 Cursor workbench bundle + 重签名；重启 Cursor 生效）。 */
  ensureCursorSwitchPump(): Promise<CursorSwitchPumpOutcome>
  /** 卸载切号补丁（重启 Cursor 生效）。 */
  removeCursorSwitchPump(): Promise<CursorSwitchPumpOutcome>
  /**
   * 在线获取 Cursor 运行时账号的会员档位（api2.cursor.sh/auth/full_stripe_profile，
   * Bearer 运行时 token；token 明文只在主进程内）。批量会话发起闸门与手动刷新共用；
   * 失败返回 error 状态（fail-closed：过闸必须有权威结果）。
   */
  refreshCursorMembership(): Promise<CursorMembershipStatus>
  /** 按本地账号库存逐个读取加密凭据并在线查询档位；Token 不离开主进程。 */
  refreshCursorAccountMemberships(accountIds?: string[]): Promise<Record<string, CursorMembershipStatus>>
  getProcessingProviderStatuses(): Promise<ProcessingCredentialStatus[]>
  saveProcessingCredential(input: { providerId: ProcessingProviderId; code: string }): Promise<ProcessingCredentialStatus>
  clearProcessingCredential(providerId: ProcessingProviderId): Promise<ProcessingCredentialStatus>
  refreshProcessingBalance(providerId: ProcessingProviderId): Promise<ProcessingCredentialStatus>
  processAccount(input: { providerId: ProcessingProviderId; accountId: string; requestId: string }): Promise<ProcessingResult>
  /** 手动模式：用户自行粘贴任意 Session Token 提交处理；token 不持久化，独立于自动化链。 */
  processToken(input: { providerId: ProcessingProviderId; token: string; requestId: string }): Promise<ProcessingResult>
  onProcessingProgress(listener: (event: ProcessingProgressEvent) => void): () => void
  launchAgentSessions(requests: AgentLaunchRequest[]): Promise<AgentLaunchPlan>
  getAgentLaunchPlan(): Promise<AgentLaunchPlan | undefined>
  onAgentLaunchProgress(listener: (plan: AgentLaunchPlan) => void): () => void
  /** 会话预热探针：批量发起前用最低成本模型验证账号能真实跑通响应；绝不触发账号自动化。 */
  runSessionWarmup(): Promise<SessionWarmupRun>
  getSessionWarmupRun(): Promise<SessionWarmupRun | undefined>
  onSessionWarmupProgress(listener: (run: SessionWarmupRun) => void): () => void
  enableCursorCdp(): Promise<{ ok: boolean; message: string; suggestAutoHeal?: boolean }>
  getCursorCdpSettings(): Promise<CursorCdpSettings>
  saveCursorCdpSettings(settings: CursorCdpSettings): Promise<CursorCdpSettings>
  getCursorUpdatePreferences(): Promise<CursorUpdatePreferences>
  setCursorAutoUpdateDisabled(disabled: boolean): Promise<CursorUpdateWriteResult>
  /** Cursor 本机存储盘点（只读）；对话历史阈值缺省 90 天。 */
  scanCursorStorage(input?: { chatHistoryOlderThanDays?: number }): Promise<CursorStorageScan>
  /** 执行清理：主进程重新扫描后按新鲜事实建计划，逐项执行并返回新盘点。 */
  cleanCursorStorage(request: CursorStorageCleanupRequest): Promise<CursorStorageCleanupResult>
  /** 在系统文件管理器里定位该项所在位置。 */
  revealCursorStorage(id: CursorStorageItemId): Promise<void>
  /** 用户取消 auto-heal 倒计时：本次 Cursor 启动不再自动重启。 */
  cancelCdpAutoHealCountdown(): Promise<void>
  onCdpAutoHealEvent(listener: (event: CdpAutoHealEvent) => void): () => void
  /**
   * 拾光自更新（手动组件）：主进程只静默检查；发现新版由渲染层按 reminderVersion 出一个不打扰的小提醒；
   * 下载与安装都由用户显式触发。安装会退出拾光运行安装器（按机安装经一次 UAC），装完自动拉起新版。
   */
  getAppUpdateStatus(): Promise<AppUpdateStatus>
  checkAppUpdate(): Promise<AppUpdateStatus>
  downloadAppUpdate(): Promise<AppUpdateStatus>
  cancelAppUpdateDownload(): Promise<AppUpdateStatus>
  /** 先过门禁：`block` / 未确认的 `confirm` 只返回结论；放行后进程随即退出安装。 */
  installAppUpdate(input: { confirmed: boolean }): Promise<{ gate: UpdateGate; status: AppUpdateStatus }>
  /** mac：回滚到更新前的备份（app + 库）。`confirmed: false` 只返回门禁结论，永远不动手。 */
  rollbackAppUpdate(input: { confirmed: boolean }): Promise<{ gate: UpdateGate; status: AppUpdateStatus }>
  /** 用户看过「已更新 / 已回滚 / 失败已恢复」的提示后清掉它。 */
  dismissAppUpdateApplyResult(): Promise<AppUpdateStatus>
  skipAppUpdate(): Promise<AppUpdateStatus>
  unskipAppUpdate(): Promise<AppUpdateStatus>
  /** 稍后：24 小时内不再提醒。 */
  snoozeAppUpdate(): Promise<AppUpdateStatus>
  dismissAppUpdateFailure(): Promise<AppUpdateStatus>
  saveAppUpdateSettings(settings: AppUpdateSettings): Promise<AppUpdateStatus>
  /** 在系统浏览器打开当前状态对应的发布页。 */
  openAppUpdateReleasePage(): Promise<boolean>
  onAppUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void
  getAccountAutomationSettings(): Promise<AccountAutomationSettings>
  saveAccountAutomationSettings(settings: AccountAutomationSettings): Promise<AccountAutomationSettings>
  getAccountAutomationRun(): Promise<AccountAutomationRun>
  cancelAccountAutomation(): Promise<AccountAutomationRun>
  /** 列出指纹浏览器窗口（账号自动化链的浏览器宿主；失败时 message 说明客户端状态）。 */
  listAccountAutomationBitProfiles(): Promise<{ ok: boolean; profiles?: Array<{ id: string; name: string; seq?: number }>; message?: string }>
  /** Roxy API Key 状态（已保存时只回掩码）。 */
  getAccountAutomationRoxyApiKey(): Promise<{ saved: boolean; maskedKey?: string }>
  /** 保存 Roxy API Key（明文仅入主进程 userData 文件，不回显）。 */
  saveAccountAutomationRoxyApiKey(key: string): Promise<{ saved: boolean; maskedKey?: string }>
  onAccountAutomationProgress(listener: (run: AccountAutomationRun) => void): () => void
  /**
   * Windows 标题栏覆盖层（titleBarOverlay）颜色跟随应用主题；macOS 无覆盖层，
   * 调用静默生效。渲染层在主题生效与系统深浅色切换时同步。
   */
  setWindowChromeColorMode(mode: 'light' | 'dark'): Promise<boolean>
  getSnapshot(): Promise<DesktopSnapshot>
  sendMessage(input: SendMessageInput): Promise<SendMessageAccepted>
  /** 撤回仍在队列中的用户消息（已投递则返回 false）。 */
  withdrawQueuedMessage(input: QueuedMessageRef): Promise<boolean>
  /** 解除「等待新会话」保持位，消息回到普通排队。 */
  releaseQueuedMessage(input: QueuedMessageRef): Promise<boolean>
  /** 在拾光里回答 Cursor 原生 ask_question：答案经 CDP 交给该会话的待决策，附言作为跟进消息送达模型。 */
  answerCursorQuestion(input: CursorQuestionAnswerInput): Promise<CursorQuestionActionResult>
  /** 跳过 Cursor 原生 ask_question（等同 Cursor 面板里的 Skip）。 */
  skipCursorQuestion(input: CursorQuestionSkipInput): Promise<CursorQuestionActionResult>
  /** 会话交接：定位该通道 Cursor 会话的上下文文档（转录）与可用投递方式。 */
  getSessionHandoffContext(input: { channelId: string }): Promise<SessionHandoffContext>
  /** 会话交接：把上下文文档路径（连同拾光会话记录）排进目标通道队列。 */
  deliverSessionHandoff(input: SessionHandoffRequest): Promise<SessionHandoffResult>
  /** 在系统文件管理器中显示该路径（仅允许拾光已解析出的文件）。 */
  revealPathInFolder(input: { path: string }): Promise<boolean>
  /** 把图片（附件 data URL，或正文引用的本地图片路径）写入系统剪贴板；成功返回 true。 */
  copyImageToClipboard(input: { dataUrl: string } | { path: string }): Promise<boolean>
  /** 弹出保存对话框把图片另存为文件；用户取消返回 false。 */
  saveImageAs(input: ({ dataUrl: string } | { path: string }) & { name?: string }): Promise<boolean>
  getTaskPoolSnapshot(): Promise<TaskPoolSnapshot>
  installTaskMcp(): Promise<McpInstallationResult>
  getTeamControlSnapshot(): Promise<TeamControlSnapshot>
  detectCursorWorkspace(): Promise<CursorWorkspaceDetection>
  /** 新建会话池（独立批次）：替换当前活动 run；每个会话一个独立席位，入组是之后的操作员动作。 */
  createIndependentSessions(input: CreateIndependentSessionsInput): Promise<TeamControlSnapshot>
  chooseIndependentWorkspace(): Promise<IndependentWorkspaceSelection | undefined>
  /**
   * 显式结束当前会话池：run 进入 completed，本轮排队消息归档；
   * 携带会话令牌的旧 Cursor 会话在下一次轮询收到围栏终止指令并自行退出。
   */
  endActiveRun(): Promise<TeamControlSnapshot>
  setSlotModelSelection(channelId: string, selection: CursorModelSelection): Promise<TeamControlSnapshot>
  /**
   * 会话池 · 协作组（只在独立批次 run 内可用）。成员关系变化落库后，拾光向相关席位投递
   * 成员关系通知；出组释放其任务租约，解散取消本组未完成任务。全部返回最新团队快照。
   */
  createTeamGroup(input: CreateTeamGroupInput): Promise<TeamControlSnapshot>
  addTeamGroupMembers(input: TeamGroupMembersInput): Promise<TeamControlSnapshot>
  /** 有效 lead 且组内仍有其他成员时被拒绝（`lead_must_transfer_first`）：先换 lead 再移出。 */
  removeTeamGroupMember(input: TeamGroupMemberRef): Promise<TeamControlSnapshot>
  setTeamGroupLead(input: TeamGroupLeadInput): Promise<TeamControlSnapshot>
  updateTeamGroupGoal(input: TeamGroupGoalInput): Promise<TeamControlSnapshot>
  /** 谁能 team_task plan：只对无 lead 的组产生实际效果（有 lead 时规划权始终归有效 lead）。 */
  setTeamGroupPlanPolicy(input: TeamGroupPlanPolicyInput): Promise<TeamControlSnapshot>
  dissolveTeamGroup(input: { groupId: string }): Promise<TeamControlSnapshot>
  /** 成员身份迁移的候选：源席位须在 active 组内，候选 = 池内全部独立席位（在线 / 离线都可选）。 */
  getMembershipTransferOptions(slotId: string): Promise<MembershipTransferOptions>
  /**
   * 成员身份迁移（阶段 2 · 2C）：把协作组内席位的组身份（组角色 + lead）移交给池内另一个独立席位，
   * 绑定 / 令牌 / Composer 不动。`includeContext` 为真时，主进程在迁移前解析原席位上下文文档、
   * 迁移成功后投递给目标席位的通道，结果在 contextHandoff。
   */
  transferMembership(input: MembershipTransferInput): Promise<MembershipTransferOutcome & {
    team: TeamControlSnapshot
  }>
  /**
   * 用户为某个协作组规划任务（桌面侧唯一的任务写入口）：与 `team_task plan` 同一条聚合路径，
   * 创建后由桌面编排器自动派单；返回新建的任务。
   */
  planTeamGroupTasks(input: TeamGroupPlanTasksInput): Promise<TeamTask[]>
  getTeamCollaborationSnapshot(): Promise<TeamCollaborationSnapshot>
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void
  /** 当前 TeamRun 的 Cursor 会话用量快照；结束冻结，下轮启动清零。 */
  getCursorUsageSnapshot(): Promise<CursorUsageSnapshot>
  onCursorUsageSnapshot(listener: (snapshot: CursorUsageSnapshot) => void): () => void
  /** 当前活动工作区的真实 Git 工作树审查摘要；右栏打开时按需读取。 */
  getWorkspaceReview(input?: { scope?: WorkspaceReviewScope }): Promise<WorkspaceReviewSummary>
  /** 按仓库相对路径读取单文件 unified diff；路径由主进程再次做工作区边界校验。 */
  getWorkspaceReviewFile(input: { path: string; scope?: WorkspaceReviewScope }): Promise<WorkspaceReviewFileDiff>
  /** 用户显式发起的 Git 动作（暂存 / 取消暂存 / 撤销，文件级或单 hunk）。 */
  applyWorkspaceReviewAction(input: WorkspaceReviewActionInput): Promise<WorkspaceReviewActionResult>
  /** 在系统文件管理器中显示工作区内的文件（仓库相对路径，主进程做边界校验）。 */
  revealWorkspaceFile(input: { path: string }): Promise<boolean>
  /** 用编辑器深链打开工作区文件（可带行号）；scheme 未注册时退到系统默认程序。 */
  openWorkspaceFile(input: { path: string; line?: number }): Promise<WorkspaceOpenFileResult>
  /** 主进程文件系统监听到工作区 / Git 状态变化（去抖后）；渲染层据此刷新当前范围。 */
  onWorkspaceReviewChanged(listener: () => void): () => void
  onTaskPoolSnapshot(listener: (snapshot: TaskPoolSnapshot) => void): () => void
  onTeamControlSnapshot(listener: (state: TeamControlSnapshot) => void): () => void
  onTeamCollaborationSnapshot(listener: (state: TeamCollaborationSnapshot) => void): () => void
}

export const IPC = {
  cursorAccountsList: 'cursor-accounts:list',
  cursorAccountsSave: 'cursor-accounts:save',
  cursorAccountsSaveCard: 'cursor-accounts:save-card',
  cursorAccountsLogin: 'cursor-accounts:login',
  cursorAccountsStartProUpgrade: 'cursor-accounts:start-pro-upgrade',
  cursorAccountsSelect: 'cursor-accounts:select',
  cursorAccountsRemove: 'cursor-accounts:remove',
  cursorAccountsSetFingerprintProfile: 'cursor-accounts:set-fingerprint-profile',
  cursorAccountsImportFromLocal: 'cursor-accounts:import-from-local',
  cursorAccountsImportFromBrowser: 'cursor-accounts:import-from-browser',
  cursorAccountsImportFromFingerprint: 'cursor-accounts:import-from-fingerprint',
  cursorAccountsOpenFingerprintLogin: 'cursor-accounts:open-fingerprint-login',
  cursorAccountsCleanupFingerprintEnvironment: 'cursor-accounts:cleanup-fingerprint-environment',
  cursorAccountsAcknowledgeModelDataPolicies: 'cursor-accounts:acknowledge-model-data-policies',
  cursorAccountsRestartWith: 'cursor-accounts:restart-with',
  cursorAccountsSwitchLive: 'cursor-accounts:switch-live',
  cursorSwitchPumpStatus: 'cursor-switch-pump:status',
  cursorSwitchPumpEnsure: 'cursor-switch-pump:ensure',
  cursorSwitchPumpRemove: 'cursor-switch-pump:remove',
  cursorAccountsVerifyRuntime: 'cursor-accounts:verify-runtime',
  cursorAccountsRefreshMembership: 'cursor-accounts:refresh-membership',
  cursorAccountsRefreshMemberships: 'cursor-accounts:refresh-memberships',
  processingGetStatuses: 'processing:get-statuses',
  processingSaveCredential: 'processing:save-credential',
  processingClearCredential: 'processing:clear-credential',
  processingRefreshBalance: 'processing:refresh-balance',
  processingProcessAccount: 'processing:process-account',
  processingProcessToken: 'processing:process-token',
  processingProgress: 'processing:progress',
  agentLaunchStart: 'agent-launch:start',
  agentLaunchGet: 'agent-launch:get',
  agentLaunchProgress: 'agent-launch:progress',
  agentLaunchEnableCdp: 'agent-launch:enable-cdp',
  sessionWarmupRun: 'session-warmup:run',
  sessionWarmupGet: 'session-warmup:get',
  sessionWarmupProgress: 'session-warmup:progress',
  cursorCdpGetSettings: 'cursor-cdp:get-settings',
  cursorCdpSaveSettings: 'cursor-cdp:save-settings',
  cursorUpdateGetPreferences: 'cursor-update:get-preferences',
  cursorUpdateSetAutoUpdateDisabled: 'cursor-update:set-auto-update-disabled',
  cursorStorageScan: 'cursor-storage:scan',
  cursorStorageCleanup: 'cursor-storage:cleanup',
  cursorStorageReveal: 'cursor-storage:reveal',
  cursorCdpCancelCountdown: 'cursor-cdp:cancel-countdown',
  cursorCdpAutoHealEvent: 'cursor-cdp:auto-heal-event',
  appUpdateGetStatus: 'app-update:get-status',
  appUpdateCheck: 'app-update:check',
  appUpdateDownload: 'app-update:download',
  appUpdateCancelDownload: 'app-update:cancel-download',
  appUpdateInstall: 'app-update:install',
  appUpdateRollback: 'app-update:rollback',
  appUpdateDismissApplyResult: 'app-update:dismiss-apply-result',
  appUpdateSkip: 'app-update:skip',
  appUpdateUnskip: 'app-update:unskip',
  appUpdateSnooze: 'app-update:snooze',
  appUpdateDismissFailure: 'app-update:dismiss-failure',
  appUpdateSaveSettings: 'app-update:save-settings',
  appUpdateOpenReleasePage: 'app-update:open-release-page',
  appUpdateStatus: 'app-update:status',
  cursorUsageGet: 'cursor-usage:get',
  cursorUsageSnapshot: 'cursor-usage:snapshot',
  workspaceReviewGet: 'workspace-review:get',
  workspaceReviewFile: 'workspace-review:file',
  workspaceReviewApply: 'workspace-review:apply',
  workspaceReviewReveal: 'workspace-review:reveal',
  workspaceReviewOpen: 'workspace-review:open',
  workspaceReviewChanged: 'workspace-review:changed',
  accountAutomationGetSettings: 'account-automation:get-settings',
  accountAutomationSaveSettings: 'account-automation:save-settings',
  accountAutomationGetRun: 'account-automation:get-run',
  accountAutomationCancel: 'account-automation:cancel',
  accountAutomationListBitProfiles: 'account-automation:list-bit-profiles',
  accountAutomationGetRoxyApiKey: 'account-automation:get-roxy-api-key',
  accountAutomationSaveRoxyApiKey: 'account-automation:save-roxy-api-key',
  accountAutomationProgress: 'account-automation:progress',
  windowSetChromeColorMode: 'window:set-chrome-color-mode',
  windowFullscreenChanged: 'window:fullscreen-changed',
  getSnapshot: 'sg-team-session:get-snapshot',
  sendMessage: 'sg-team-session:send-message',
  withdrawQueuedMessage: 'sg-team-session:withdraw-queued-message',
  releaseQueuedMessage: 'sg-team-session:release-queued-message',
  answerCursorQuestion: 'sg-team-session:answer-cursor-question',
  skipCursorQuestion: 'sg-team-session:skip-cursor-question',
  sessionHandoffContext: 'sg-team-session:handoff-context',
  sessionHandoffDeliver: 'sg-team-session:handoff-deliver',
  revealPathInFolder: 'sg-team-session:reveal-path',
  copyImageToClipboard: 'sg-team-session:copy-image',
  saveImageAs: 'sg-team-session:save-image',
  snapshot: 'sg-team-session:snapshot',
  taskPoolGet: 'task-pool:get',
  taskPoolSnapshot: 'task-pool:snapshot',
  taskMcpInstall: 'task-mcp:install',
  teamControlGet: 'team-control:get',
  teamControlDetectWorkspace: 'team-control:detect-workspace',
  teamControlCreateIndependent: 'team-control:create-independent',
  teamControlChooseIndependentWorkspace: 'team-control:choose-independent-workspace',
  teamControlEndRun: 'team-control:end-run',
  teamControlSetSlotModelSelection: 'team-control:set-slot-model-selection',
  teamControlSnapshot: 'team-control:snapshot',
  teamGroupCreate: 'team-group:create',
  teamGroupAddMembers: 'team-group:add-members',
  teamGroupRemoveMember: 'team-group:remove-member',
  teamGroupSetLead: 'team-group:set-lead',
  teamGroupUpdateGoal: 'team-group:update-goal',
  teamGroupSetPlanPolicy: 'team-group:set-plan-policy',
  teamGroupDissolve: 'team-group:dissolve',
  teamGroupTransferOptions: 'team-group:transfer-options',
  teamGroupTransferMembership: 'team-group:transfer-membership',
  teamGroupPlanTasks: 'team-group:plan-tasks',
  teamCollaborationGet: 'team-collaboration:get',
  teamCollaborationSnapshot: 'team-collaboration:snapshot'
} as const
