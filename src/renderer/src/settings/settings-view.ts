import type { CursorAccountMetadata, CursorRuntimeAccountMatch } from '../../../domain/cursor-account'
import type { CursorMembershipStatus, CursorMembershipTier } from '../../../domain/cursor-membership'
import { cursorMembershipTierLabel } from '../../../domain/cursor-membership'
import type {
  ProcessingCredentialStatus,
  ProcessingProgressEvent,
  ProcessingProviderId
} from '../../../domain/processing-provider'
import { resolveExecutionProfileId } from '../../../domain/account-automation'
import type {
  AccountAutomationPhase,
  AccountAutomationRun,
  AccountAutomationSettings
} from '../../../domain/account-automation'
import type { CursorUpdatePreferences } from '../../../domain/cursor-update'
import type { CursorSwitchPumpStatus } from '../../../domain/cursor-switch-pump'
import type {
  CursorStorageCleanupRequest,
  CursorStorageCleanupResult,
  CursorStorageItemId,
  CursorStorageScan
} from '../../../domain/cursor-storage-cleanup'
import type { CursorUsageSnapshot } from '../../../domain/cursor-usage'
import type { StatsGroupSource, StatsSeatSource } from './stats-view'

/**
 * 设置页视图模型与纯函数。
 *
 * 本文件的函数与类型逐字迁移自原 lobby/LobbyAccountTile.tsx（账号管线页），
 * 逻辑零变更；测试从原断言直接平移。
 */

/** 档位段视觉模型：标签 + 按档位着色的类名。 */
export interface AccountStatusTierView {
  label: string
  className: string
}

/** 顶部登录状态模型；会员等级在当前账号卡片中独立呈现。 */
export interface AccountStatusLineView {
  tone: '' | 'is-warn' | 'is-off'
  text: string
  /** 鼠标悬停的完整说明（劈叉时含双账号明细）。 */
  detail?: string
}

export interface LiveSwitchAvailability {
  enabled: boolean
  title: string
}

/** 手动无感切换只依赖运行泵能力，与自动化开关完全解耦。 */
export function liveSwitchAvailability(status: CursorSwitchPumpStatus | undefined): LiveSwitchAvailability {
  if (!status) return { enabled: false, title: '正在检测 Cursor 无感换号能力…' }
  if (status.kind === 'installed') {
    return {
      enabled: true,
      title: status.managed === false
        ? '使用现有兼容切号补丁，不重启 Cursor 切换到此账号'
        : '不重启 Cursor 切换到此账号；机器码下次冷切换时对齐'
    }
  }
  if (status.kind === 'not-installed') {
    return { enabled: false, title: '请先到「Cursor 维护」安装切号补丁' }
  }
  return { enabled: false, title: status.message }
}

/** 档位着色类：卡片内采用 Free 绿、Trial 琥珀、Pro 蓝、Pro+ 靛、Ultra 紫、Enterprise 橙。 */
function tierClassNameFor(tier: CursorMembershipTier | 'unknown'): string {
  switch (tier) {
    case 'free': return 'is-tier-free'
    case 'free_trial': return 'is-tier-trial'
    case 'pro': return 'is-tier-pro'
    case 'pro_plus': return 'is-tier-proplus'
    case 'ultra': return 'is-tier-ultra'
    case 'enterprise': return 'is-tier-enterprise'
    default: return 'is-tier-unknown'
  }
}

export function accountMembershipPlanFor(membership: CursorMembershipStatus | undefined): AccountStatusTierView | undefined {
  if (membership?.state !== 'ok' || !membership.profile) return undefined
  const { tier, raw } = membership.profile
  const label = tier === 'free_trial'
    ? 'Free Trial'
    : tier === 'unknown'
      ? cursorMembershipTierLabel(tier, raw)
      : `${cursorMembershipTierLabel(tier, raw)} Plan`
  return { label, className: tierClassNameFor(tier) }
}

/**
 * 顶部仅呈现登录一致性和异常：
 * - matched       → "email · 一致"
 * - mismatch      → "登录账号不一致"（红点，悬停见双账号）
 * - 会员正常等级移入当前账号卡片；401/抓取失败仍在顶部告警。
 */
export function accountStatusLineFor(
  runtimeMatch: CursorRuntimeAccountMatch | undefined,
  membership: CursorMembershipStatus | undefined
): AccountStatusLineView | undefined {
  const parts: string[] = []
  let tone: AccountStatusLineView['tone'] = ''
  let detail: string | undefined
  let hasSignal = false

  if (runtimeMatch?.status === 'matched') {
    hasSignal = true
    parts.push(runtimeMatch.activeLabel ?? runtimeMatch.cursorLabel ?? '')
    parts.push('一致')
  } else if (runtimeMatch?.status === 'mismatch') {
    hasSignal = true
    tone = 'is-off'
    parts.push('登录账号不一致')
    detail = `Cursor 当前登录 ${runtimeMatch.cursorLabel ?? '未知'}，活跃账号 ${runtimeMatch.activeLabel ?? '未知'}`
  }

  if (membership?.state === 'auth_expired') {
    hasSignal = true
    tone = 'is-off'
    parts.push('服务端会话已失效')
    detail = `${membership.detail ?? '服务端拒绝当前登录会话'}；“一致”只表示本地 JWT 账号标识相同`
  } else if (membership?.state === 'error') {
    hasSignal = true
    if (tone !== 'is-off') tone = 'is-warn'
    parts.push('档位获取失败')
  }

  if (!hasSignal) return undefined
  return {
    tone,
    text: parts.join(' · '),
    detail: detail ?? 'Cursor 运行登录态与活跃账号的比对（发起批量会话前会再校验）'
  }
}

interface StatusFeedback {
  ok: boolean
  message: string
}

interface ProcessingFeedback extends StatusFeedback { providerId: ProcessingProviderId }

export interface SettingsPageProps {
  accounts: CursorAccountMetadata[]
  busy: boolean
  error: string
  onSave: (input: { label: string; token: string }) => Promise<void>
  /** 卡号粘贴导入：返回新建/更新与自动登录结果供表单亮出反馈；失败抛错（同时进账号区错误条）。 */
  onSaveCard?: (input: { card: string }) => Promise<{
    outcome: 'created' | 'updated'
    label: string
    tokenRefreshed?: boolean
    loginError?: string
  }>
  /** 用账号保存的凭据在指纹浏览器自动登录并刷新 Token（仅卡号导入的账号展示入口）。 */
  onReloginAccount?: (accountId: string) => Promise<void>
  /** 升级 Pro 扫码付款：直达 Stripe 月付结账（USD · 支付宝）并自动填写账单资料；结果经 proUpgradeFeedback 亮出。 */
  onStartProUpgrade?: (accountId: string) => Promise<void>
  /** 升级 Pro 结果反馈（待扫码/复核通过/失败原因）。 */
  proUpgradeFeedback?: StatusFeedback | null
  onSelect: (accountId: string) => Promise<void>
  onRemove: (accountId: string) => Promise<void>
  onRestartWithAccount?: (accountId: string) => Promise<void>
  onImportFromLocal?: () => Promise<void>
  onImportFromBrowser?: () => Promise<void>
  /** 第一步「获取 Token」的指纹导入：读选中指纹 profile 登录态（导入即绑定该窗口）。 */
  onImportFromFingerprint?: () => Promise<void>
  /** 打开选定的指纹浏览器窗口并导航 cursor.com（用户提前登录入口；窗口不自动关）。 */
  onOpenFingerprintLogin?: () => Promise<void>
  onCleanupFingerprintEnvironment?: () => Promise<void>
  /** 绑定/改绑/解绑账号的指纹窗口（undefined 解绑，自动化回退默认窗口）。 */
  onSetAccountFingerprintProfile?: (accountId: string, profileId?: string) => Promise<void>
  processingStatuses?: Record<ProcessingProviderId, ProcessingCredentialStatus>
  processingBusy?: boolean
  processingError?: { providerId: ProcessingProviderId; message: string } | null
  processingProgress?: ProcessingProgressEvent | null
  processingFeedback?: ProcessingFeedback | null
  onSaveProcessingCredential?: (providerId: ProcessingProviderId, code: string) => Promise<void>
  onClearProcessingCredential?: (providerId: ProcessingProviderId) => Promise<void>
  onRefreshProcessingBalance?: (providerId: ProcessingProviderId) => Promise<void>
  onProcessAccount?: (providerId: ProcessingProviderId, accountId: string) => Promise<void>
  /** 手动模式：用户粘贴任意 Session Token 直接提交处理（独立于自动化，不触发加固/删除/换号；token 不持久化）。 */
  onProcessToken?: (providerId: ProcessingProviderId, token: string) => Promise<void>
  automationSettings?: AccountAutomationSettings
  automationRun?: AccountAutomationRun
  /** 指纹浏览器窗口列表（账号自动化链的浏览器宿主，用户按当次网络选择）。 */
  bitProfiles?: Array<{ id: string; name: string; seq?: number }>
  /** 窗口列表获取失败提示（客户端未运行等）。 */
  bitProfilesMessage?: string
  onRefreshBitProfiles?: () => void
  /** Roxy API Key 状态（指纹浏览器统一 Roxy，未保存 Key 时展示输入框）。 */
  roxyApiKeyStatus?: { saved: boolean; maskedKey?: string }
  onSaveRoxyApiKey?: (key: string) => Promise<void>
  /**
   * 当前运行平台（测试注入点）。缺省读 preload 注入的 documentElement.dataset.platform；
   * 决定是否显示「系统浏览器」宿主（Keychain + Apple Events 为 macOS 专属，Windows 隐藏）。
   * 指纹浏览器提供方与平台无关（恒 Roxy）。
   */
  platform?: NodeJS.Platform
  /** Cursor 运行态登录态与活跃账号的一致性核对（被动状态行；未拉取/无活跃账号时不渲染）。 */
  runtimeMatch?: CursorRuntimeAccountMatch
  /** 在线会员档位（被动状态行；未拉取/未登录时不渲染）。 */
  membership?: CursorMembershipStatus
  /** 每个已保存账号各自的在线会员档位，不依赖是否选为当前账号。 */
  accountMemberships?: Record<string, CursorMembershipStatus>
  /** 手动刷新指定账号档位。 */
  onRefreshMembership?: (accountId?: string) => void | Promise<void>
  cursorUpdatePreferences?: CursorUpdatePreferences
  cursorUpdateBusy?: boolean
  cursorUpdateError?: string
  onSetCursorAutoUpdateDisabled?: (disabled: boolean) => Promise<void>
  onSetModelDataPolicyAutoAcknowledge?: (enabled: boolean) => Promise<{ message: string }>
  onSaveAutomationSettings?: (settings: AccountAutomationSettings) => void
  onCancelAutomation?: () => void
  /** 无感换号（热切）：不重启 Cursor 直接把运行态切到指定账号；结果经账号区消息条呈现。 */
  onSwitchLiveAccount?: (accountId: string) => Promise<void>
  /** 切号补丁状态卡（维护页）：只读检测 + 一键安装/卸载。 */
  switchPumpStatus?: CursorSwitchPumpStatus
  switchPumpBusy?: boolean
  switchPumpFeedback?: { ok: boolean; message: string }
  onRefreshSwitchPumpStatus?: () => void
  onEnsureSwitchPump?: () => Promise<void>
  onRemoveSwitchPump?: () => Promise<void>
  /** 存储清理页：盘点结果、进行中状态、上次清理结果与三个动作。 */
  storageScan?: CursorStorageScan
  storageScanBusy?: boolean
  storageScanError?: string
  storageCleanupBusy?: boolean
  storageCleanupResult?: CursorStorageCleanupResult
  onScanCursorStorage?: (input?: { chatHistoryOlderThanDays?: number }) => Promise<void>
  onCleanCursorStorage?: (request: CursorStorageCleanupRequest) => Promise<void>
  onRevealCursorStorage?: (id: CursorStorageItemId) => void
  /** 统计页：全部会话的用量快照（含逐回合账本）、席位来源与 active 组来源投影，纯只读。 */
  usageSnapshot?: CursorUsageSnapshot
  statsSeats?: readonly StatsSeatSource[]
  statsGroups?: readonly StatsGroupSource[]
}

/** 运行中的相位（非空闲、非终态）：期间禁用会改动账号 / 浏览器状态的操作。 */
export type ActiveAutomationPhase = Exclude<AccountAutomationPhase, 'idle' | 'done' | 'failed' | 'cancelled'>

export function isActiveAutomationPhase(phase: AccountAutomationPhase): phase is ActiveAutomationPhase {
  return phase === 'countdown' || phase === 'processing' || phase === 'hardening-countdown'
    || phase === 'importing' || phase === 'deleting' || phase === 'cleaning'
}

/** 运行耗时摘要：仅在有始有终时给出。 */
export function automationDurationText(run: AccountAutomationRun): string {
  if (!run.startedAt || !run.finishedAt || run.finishedAt < run.startedAt) return ''
  const sec = (run.finishedAt - run.startedAt) / 1000
  if (sec >= 60) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`
  return `${Math.round(sec * 10) / 10} 秒`
}

/** 指纹窗口的展示名（#序号 名称；列表缺失时回退原始 id——窗口可能被删或 Roxy 未连接）。 */
export function profileDisplayName(
  profiles: readonly { id: string; name: string; seq?: number }[] | undefined,
  profileId: string
): string {
  const found = profiles?.find((profile) => profile.id === profileId)
  if (!found) return profileId
  return `${found.seq !== undefined ? `#${found.seq} ` : ''}${found.name}`
}

/**
 * 自动化「执行浏览器」跟随文案：解析规则与主进程 resolveExecutionProfileId 同一函数，
 * 界面显示的执行窗口与实际执行窗口不分叉。
 */
export function automationBrowserFollowText(input: {
  browserHost?: 'external' | 'fingerprint'
  accounts: readonly CursorAccountMetadata[]
  defaultProfileId?: string
  profiles?: readonly { id: string; name: string; seq?: number }[]
}): string {
  if ((input.browserHost ?? 'fingerprint') === 'external') return '系统浏览器（Edge/Chrome）'
  const active = input.accounts.find((account) => account.active)
  if (!active) return '指纹浏览器（Roxy）· 跟随活跃账号窗口'
  if (active.fingerprintProfileId) {
    return `指纹浏览器（Roxy）· 跟随活跃账号 → ${profileDisplayName(input.profiles, active.fingerprintProfileId)}`
  }
  const fallback = resolveExecutionProfileId(input.accounts, input.defaultProfileId)
  return `指纹浏览器（Roxy）· 未绑定，走默认窗口${fallback ? `「${profileDisplayName(input.profiles, fallback)}」` : '（未选择）'}`
}
