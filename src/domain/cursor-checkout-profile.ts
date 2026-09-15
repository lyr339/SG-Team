/** 升级 Pro 扫码付款的账单资料（Stripe 结账页填写用；非敏感，明文随自动化设置存储）。 */

export interface CursorCheckoutProfile {
  /** 账单姓名（拼音/英文稳妥）。 */
  name: string
  /** 省（Stripe 省份 select 的 value，中文省名，如 "湖北省"）。 */
  province: string
  /** 市（billingLocality）。 */
  city: string
  /** 区/县（billingDependentLocality，中国地址特有）。 */
  district: string
  /** 地址行 1。 */
  line1: string
  /** 地址行 2（可选）。 */
  line2?: string
  /** 邮编。 */
  postalCode: string
}

/**
 * 链路既定拍板（不进资料、不占设置项，实机标定 2026-09-15）：
 * 账单国家 = 中国（Alipay 支付方式出现的前提）、币种 = USD（结账页内切换器）、
 * 计费周期 = 月付（checkoutDeepControl?yearly=false；Alipay 对年付有 90 天退款限制）。
 */
export const CURSOR_CHECKOUT_COUNTRY = 'CN'

export const DEFAULT_CURSOR_CHECKOUT_PROFILE: CursorCheckoutProfile = {
  name: 'Li Ming',
  province: '湖北省',
  city: '武汉市',
  district: '洪山区',
  line1: '珞喻路 456 号',
  postalCode: '430070'
}

/**
 * 编辑友好型归一：资料整体缺失/非对象时给整套默认；已是字符串的字段原样保留
 * （含编辑中途的空串——若按字段回退默认，输入框会永远清不空、无法重输）。
 * 完整性校验在执行时进行（cursorCheckoutProfileIssue），存储层不做拦截。
 */
export function normalizeCursorCheckoutProfile(value: unknown): CursorCheckoutProfile {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const text = (key: 'name' | 'province' | 'city' | 'district' | 'line1' | 'postalCode'): string =>
    typeof raw[key] === 'string' ? raw[key] as string : DEFAULT_CURSOR_CHECKOUT_PROFILE[key]
  const line2 = typeof raw.line2 === 'string' && raw.line2.trim() ? raw.line2.trim() : undefined
  return {
    name: text('name'),
    province: text('province'),
    city: text('city'),
    district: text('district'),
    line1: text('line1'),
    ...(line2 ? { line2 } : {}),
    postalCode: text('postalCode')
  }
}

/**
 * 升级 Pro 结账的执行结果：
 * - awaiting_payment  表单已提交，等待用户在指纹窗口内用支付宝扫码付款
 * - verified          仅填写并复核通过、未提交（allowSubmit=false 的测试/校准闸门）
 */
export interface CursorProUpgradeResult {
  outcome: 'awaiting_payment' | 'verified'
  detail: string
}

/** 执行前校验：返回第一个不完整字段的中文名；完整返回 undefined。 */
export function cursorCheckoutProfileIssue(profile: CursorCheckoutProfile): string | undefined {
  if (!profile.name.trim()) return '姓名'
  if (!profile.province.trim()) return '省份'
  if (!profile.city.trim()) return '城市'
  if (!profile.district.trim()) return '区/县'
  if (!profile.line1.trim()) return '地址行 1'
  if (!profile.postalCode.trim()) return '邮编'
  return undefined
}
