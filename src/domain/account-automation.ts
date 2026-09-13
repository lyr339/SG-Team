/** 会话创建后的账号自动化（玩法开关 + 延时 + RoxyBrowser 指纹浏览器窗口）。 */

export interface AccountAutomationSettings {
  /** 总开关：一键创建会话全部提交成功后，是否自动执行账号自动化链。默认关。 */
  enabled: boolean
  /** 触发后倒计时秒数（支持 0.5 步进），倒计时内可取消。 */
  delaySec: number
  /** 奥仔完成后、账号加固前的第二段倒计时秒数（支持 0.5 步进），倒计时内可取消。 */
  postProcessDelaySec: number
  /**
   * 账号管线的浏览器宿主——在第一步「获取 Token」选定，贯穿整条管线：
   *   - 'fingerprint' 指纹浏览器（RoxyBrowser profile + CDP）：Token 从 profile 导入，奥仔后的
   *                  换发与页内删除也在同一 profile 执行（一致性天然成立）。提供方恒 Roxy，
   *                  不落设置（比特已全面退役）
   *   - 'external'   系统浏览器（Edge/Chrome，仅 macOS）：Token 从 cookie 库导入，后续走 AppleScript 链
   * 缺省 'fingerprint'。
   */
  browserHost?: 'external' | 'fingerprint'
  /**
   * 默认指纹浏览器窗口 id（仅 fingerprint 宿主使用；字段名保留 bit 前缀兼容旧设置文件）。
   * 语义：新账号导入的目标窗口 + 未绑定账号的执行回退。已绑定窗口的账号
   * （CursorAccountMetadata.fingerprintProfileId）在自动化链中改用各自绑定，不读此值。
   * 本机代理环境时有时无（Clash 开关），用户按当次网络状态选择
   * 「挂代理」或「直连」窗口；两个窗口都需在指纹浏览器里预先登录 cursor.com。
   */
  bitProfileId?: string
  /** 指纹浏览器账号导入/预检时，自动查询并确认受限模型的数据政策。默认开启。 */
  autoAcknowledgeModelDataPolicies?: boolean
  /**
   * 无感换号（换票续接）：奥仔退款成功后，不重启 Cursor 直接把运行态热切到下一
   * 可用账号（切号泵补丁回执为准），删除旧号照常进行。默认开启；关闭则自动化
   * 不动运行中的 Cursor。手动「无感切换」按钮不受此开关约束。
   */
  seamlessHandoverEnabled?: boolean
  /** 指定接手账号；缺省为自动选择最近更新的非当前账号。 */
  seamlessHandoverAccountId?: string
}

export const ACCOUNT_AUTOMATION_DELAY_MIN_SEC = 0.5
export const ACCOUNT_AUTOMATION_DELAY_MAX_SEC = 60

export const DEFAULT_ACCOUNT_AUTOMATION_SETTINGS: AccountAutomationSettings = {
  enabled: false,
  delaySec: 10,
  postProcessDelaySec: 10,
  autoAcknowledgeModelDataPolicies: true
}

export function normalizeAccountAutomationSettings(value: unknown): AccountAutomationSettings {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const delay = typeof raw.delaySec === 'number' && Number.isFinite(raw.delaySec)
    ? Math.round(raw.delaySec * 2) / 2
    : DEFAULT_ACCOUNT_AUTOMATION_SETTINGS.delaySec
  const postProcessDelay = typeof raw.postProcessDelaySec === 'number' && Number.isFinite(raw.postProcessDelaySec)
    ? Math.round(raw.postProcessDelaySec * 2) / 2
    // 旧设置迁移：新增字段首次读取时沿用原倒计时，保持用户既有节奏。
    : delay
  const bitProfileId = typeof raw.bitProfileId === 'string' && raw.bitProfileId.trim() ? raw.bitProfileId.trim() : undefined
  // 宿主白名单；缺省回落 'fingerprint'（未迁移的旧设置仍走已配置的指纹链路）。
  // 旧设置里的 fingerprintProvider 字段已被统一 Roxy 提供方取代，读取时直接丢弃。
  const browserHost = raw.browserHost === 'external' ? 'external' : 'fingerprint'
  const seamlessHandoverAccountId = typeof raw.seamlessHandoverAccountId === 'string' && raw.seamlessHandoverAccountId.trim()
    ? raw.seamlessHandoverAccountId.trim()
    : undefined
  return {
    enabled: raw.enabled === true,
    delaySec: Math.min(ACCOUNT_AUTOMATION_DELAY_MAX_SEC, Math.max(ACCOUNT_AUTOMATION_DELAY_MIN_SEC, delay)),
    postProcessDelaySec: Math.min(ACCOUNT_AUTOMATION_DELAY_MAX_SEC, Math.max(ACCOUNT_AUTOMATION_DELAY_MIN_SEC, postProcessDelay)),
    browserHost,
    bitProfileId,
    autoAcknowledgeModelDataPolicies: raw.autoAcknowledgeModelDataPolicies !== false,
    seamlessHandoverEnabled: raw.seamlessHandoverEnabled !== false,
    ...(seamlessHandoverAccountId ? { seamlessHandoverAccountId } : {})
  }
}

export interface AccountHandoverCandidate {
  id: string
  label: string
  active: boolean
  updatedAt: number
}

/**
 * 自动化接手账号的唯一选择规则：有效指定优先，否则选择最近更新的非当前账号。
 * 主进程执行与设置页预览共用，避免 UI 显示目标和实际切换目标分叉。
 */
export function selectAccountHandoverTarget<T extends AccountHandoverCandidate>(
  accounts: readonly T[],
  currentAccountId: string | undefined,
  preferredAccountId?: string
): T | undefined {
  const candidates = accounts.filter((account) => account.id !== currentAccountId && !account.active)
  const preferred = preferredAccountId?.trim()
  if (preferred) {
    const selected = candidates.find((account) => account.id === preferred)
    if (selected) return selected
  }
  return [...candidates].sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

/**
 * 自动化执行链的指纹窗口解析规则（唯一权威）：
 * 活跃账号绑定的窗口优先；未绑定时回退默认窗口（bitProfileId）。
 *
 * 主进程装配与设置页预览共用，避免「实际执行窗口」与「界面显示窗口」分叉。
 * 用户显式操作（导入 / 打开登录页 / 一键清理）不走这里——它们显式指定目标窗口。
 */
export function resolveExecutionProfileId(
  accounts: readonly { active: boolean; fingerprintProfileId?: string }[],
  defaultProfileId?: string
): string | undefined {
  const bound = accounts.find((account) => account.active)?.fingerprintProfileId?.trim()
  if (bound) return bound
  const fallback = defaultProfileId?.trim()
  return fallback || undefined
}

export type AccountAutomationPhase =
  | 'idle'
  | 'countdown'
  | 'processing'
  /** 奥仔完成后、账号加固前的第二段倒计时（可取消）。 */
  | 'hardening-countdown'
  | 'importing'
  | 'deleting'
  /** 删除成功后的浏览器环境清场（Roxy 关窗缓存清理 + 指纹轮换）。 */
  | 'cleaning'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface AccountAutomationRun {
  phase: AccountAutomationPhase
  message: string
  planId?: string
  /** countdown / hardening-countdown 阶段剩余秒数。 */
  remainingSec?: number
  startedAt: number
  finishedAt?: number
  /** 与主流程并行的无感换号子状态；目标在本轮开始后冻结。 */
  handover?: {
    accountId: string
    label: string
    status: 'preparing' | 'switching' | 'done' | 'failed'
    message: string
    startedAt: number
    finishedAt?: number
  }
}

export const IDLE_ACCOUNT_AUTOMATION_RUN: AccountAutomationRun = {
  phase: 'idle',
  message: '',
  startedAt: 0
}
