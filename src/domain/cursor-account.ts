export interface CursorAccountMetadata {
  id: string
  label: string
  maskedToken: string
  active: boolean
  createdAt: number
  updatedAt: number
  /** 热切换号后机器码仍属上一账号，待冷切换归一。 */
  pendingMachineAlign?: boolean
  /**
   * 账号绑定的指纹浏览器窗口 id（Roxy profile）。
   * 绑定在导入时自动记录（从哪个窗口读出 Token 就绑定哪个窗口），也可在账号列表改绑；
   * 自动化链的浏览器操作锚定活跃账号的绑定窗口，未绑定时回退「默认窗口」。
   */
  fingerprintProfileId?: string
  /** 卡号导入账号的邮箱（明文展示用；非卡号来源的账号缺省）。 */
  email?: string
  /** 是否随账号保存了加密登录凭据（邮箱/Cursor 密码等，自动登录的准入条件）。 */
  hasCredentials?: boolean
}

/**
 * 卡号导入随账号保存的登录凭据（整体加密为一个 blob 入库，永不入明文存储/日志/回显）。
 * 邮箱密码与辅邮密码供日后读取登录验证码；Cursor 密码供指纹浏览器自动登录。
 */
export interface CursorAccountCredentials {
  email: string
  cursorPassword: string
  emailPassword?: string
  recoveryEmail?: string
  recoveryEmailPassword?: string
}

export function isCursorAccountCredentials(value: unknown): value is CursorAccountCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const optionalStrings = ['emailPassword', 'recoveryEmail', 'recoveryEmailPassword']
  return typeof record.email === 'string' && typeof record.cursorPassword === 'string'
    && optionalStrings.every((key) => record[key] === undefined || typeof record[key] === 'string')
}

/**
 * Cursor 运行时登录态与拾光活跃账号的一致性核对结果。
 *
 * 背景：会话创建消耗的是 Cursor 编辑器运行态（state.vscdb cursorAuth/*），
 * 账号自动化锚定的是 vault 活跃账号 + 浏览器宿主——两轨各自正常时互不校验，
 * 用户绕过拾光手动登录/换号会造成劈叉（删错官网账号 / 会话僵尸）。
 * 一致性锚点 = 两侧 JWT sub（用户唯一标识）。
 */
export type CursorRuntimeAccountMatchStatus =
  | 'matched'
  | 'mismatch'
  /** Cursor 无可用登录态（未登录 / 未安装 / token 损坏）。 */
  | 'cursor_unavailable'
  /** vault 无活跃账号（本核对不适用；自动化 preflight 另有拦截）。 */
  | 'vault_empty'

export interface CursorRuntimeAccountMatch {
  status: CursorRuntimeAccountMatchStatus
  /** Cursor 运行态身份显示（cachedEmail 优先，回落 JWT sub）。 */
  cursorLabel?: string
  /** vault 活跃账号身份显示（label 内邮箱优先，回落 JWT sub）。 */
  activeLabel?: string
  /** cursor_unavailable 时的底层原因（截断后的错误消息）。 */
  detail?: string
}
