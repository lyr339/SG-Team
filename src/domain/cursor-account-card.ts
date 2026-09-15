/**
 * 账号卡号（卡密格式）解析：邮箱----邮箱密码----Cursor密码----辅邮----辅邮密码----Token。
 *
 * 卡号是账号商的标准交付格式，Token 段通常是 URL 编码的 WorkosCursorSessionToken
 * （user_xxx::jwt）。解析器是纯函数，渲染层用它做粘贴预览，主进程用它做权威校验——
 * 两处共享同一实现，预览所见即入库结果。
 */

export interface CursorAccountCard {
  /** Cursor 账号邮箱（第 1 段）。 */
  email: string
  /** 邮箱登录密码（第 2 段；用于日后读取登录验证码，可空）。 */
  emailPassword?: string
  /** Cursor 官网登录密码（第 3 段，自动登录用）。 */
  cursorPassword: string
  /** 辅助邮箱（第 4 段，可空）。 */
  recoveryEmail?: string
  /** 辅助邮箱密码（第 5 段，可空）。 */
  recoveryEmailPassword?: string
  /** 会话 Token（第 6 段；已 URL 解码，user_xxx::jwt 或纯 jwt）。 */
  token: string
}

export interface ParsedCursorAccountCard extends CursorAccountCard {
  /** 默认账号备注（= 邮箱）。 */
  label: string
  /** JWT payload 的 sub（auth0|user_xxx），无法解码时缺省。 */
  sub?: string
  /** Token 前缀的用户 id（user_xxx），非该形态时缺省。 */
  userId?: string
  /** JWT exp（毫秒时间戳），无法解码时缺省。 */
  expiresAt?: number
}

const CARD_SEPARATOR = '----'
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 粘贴内容识别：含分隔符按卡号处理，否则按单独 Token（旧手动添加路径）。 */
export function detectPastedSecret(raw: string): 'empty' | 'token' | 'card' {
  const text = raw.trim()
  if (!text) return 'empty'
  return text.includes(CARD_SEPARATOR) ? 'card' : 'token'
}

function decodeCardToken(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.includes('%')) return trimmed
  try {
    return decodeURIComponent(trimmed)
  } catch {
    // 含 % 但不是合法编码：按原文继续，形状校验会给出最终判定。
    return trimmed
  }
}

/** 跨端 base64url JSON 解码（渲染层无 Buffer，atob + TextDecoder 两端同义）。 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析卡号文本。任一字段不合法即抛带字段位置的中文错误（表单原样亮出）。
 * 辅邮两段允许为空（部分卡号不带辅邮）；邮箱 / Cursor 密码 / Token 必填。
 */
export function parseCursorAccountCard(raw: string): ParsedCursorAccountCard {
  const text = raw.trim()
  if (!text) throw new Error('请粘贴卡号内容')
  const parts = text.split(CARD_SEPARATOR).map((part) => part.trim())
  if (parts.length !== 6) {
    throw new Error(`卡号应为 6 段（邮箱----邮箱密码----Cursor密码----辅邮----辅邮密码----Token），当前识别为 ${parts.length} 段`)
  }
  const [email, emailPassword, cursorPassword, recoveryEmail, recoveryEmailPassword, rawToken] = parts as [
    string, string, string, string, string, string
  ]
  if (!EMAIL_PATTERN.test(email)) throw new Error('第 1 段（邮箱）不是有效邮箱地址')
  if (recoveryEmail && !EMAIL_PATTERN.test(recoveryEmail)) throw new Error('第 4 段（辅邮）不是有效邮箱地址')
  if (!cursorPassword) throw new Error('第 3 段（Cursor 密码）为空')

  const token = decodeCardToken(rawToken)
  if (!token) throw new Error('第 6 段（Token）为空')
  const userId = token.includes('::') ? token.split('::', 1)[0]!.trim() : undefined
  const jwt = token.includes('::') ? token.slice(token.indexOf('::') + 2) : token
  const payload = decodeJwtPayload(jwt)
  if (!payload) throw new Error('第 6 段（Token）不是有效的 Cursor 会话 Token（user_xxx::jwt）')

  const sub = typeof payload.sub === 'string' ? payload.sub : undefined
  const expiresAt = typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  return {
    email,
    label: email,
    ...(emailPassword ? { emailPassword } : {}),
    cursorPassword,
    ...(recoveryEmail ? { recoveryEmail } : {}),
    ...(recoveryEmailPassword ? { recoveryEmailPassword } : {}),
    token,
    ...(sub ? { sub } : {}),
    ...(userId ? { userId } : {}),
    ...(expiresAt ? { expiresAt } : {})
  }
}
