import { describe, expect, it } from 'vitest'
import {
  CURSOR_CHECKOUT_COUNTRY,
  DEFAULT_CURSOR_CHECKOUT_PROFILE,
  cursorCheckoutProfileIssue,
  normalizeCursorCheckoutProfile
} from '../src/domain/cursor-checkout-profile'

describe('normalizeCursorCheckoutProfile（升级 Pro 账单资料归一）', () => {
  it('整体缺失/非对象 → 整套默认', () => {
    expect(normalizeCursorCheckoutProfile(undefined)).toEqual(DEFAULT_CURSOR_CHECKOUT_PROFILE)
    expect(normalizeCursorCheckoutProfile(null)).toEqual(DEFAULT_CURSOR_CHECKOUT_PROFILE)
    expect(normalizeCursorCheckoutProfile('湖北')).toEqual(DEFAULT_CURSOR_CHECKOUT_PROFILE)
  })

  it('部分字段缺失 → 字段级回退默认；已是字符串的原样保留', () => {
    const normalized = normalizeCursorCheckoutProfile({ name: 'Zhang San', postalCode: '430000' })
    expect(normalized).toEqual({
      ...DEFAULT_CURSOR_CHECKOUT_PROFILE,
      name: 'Zhang San',
      postalCode: '430000'
    })
  })

  it('编辑中途的空串原样保留（否则输入框永远清不空）', () => {
    const normalized = normalizeCursorCheckoutProfile({ ...DEFAULT_CURSOR_CHECKOUT_PROFILE, line1: '' })
    expect(normalized.line1).toBe('')
    expect(cursorCheckoutProfileIssue(normalized)).toBe('地址行 1')
  })

  it('line2 可选稀疏：空白剔除，有效值去首尾空白保留', () => {
    expect(normalizeCursorCheckoutProfile({ line2: '   ' }).line2).toBeUndefined()
    expect(normalizeCursorCheckoutProfile({ line2: ' 3 栋 2 单元 ' }).line2).toBe('3 栋 2 单元')
  })
})

describe('cursorCheckoutProfileIssue（执行前完整性校验）', () => {
  it('默认资料完整 → undefined', () => {
    expect(cursorCheckoutProfileIssue(DEFAULT_CURSOR_CHECKOUT_PROFILE)).toBeUndefined()
  })

  it.each([
    ['name', '姓名'],
    ['province', '省份'],
    ['city', '城市'],
    ['district', '区/县'],
    ['line1', '地址行 1'],
    ['postalCode', '邮编']
  ] as const)('缺 %s → 报「%s」', (key, label) => {
    expect(cursorCheckoutProfileIssue({ ...DEFAULT_CURSOR_CHECKOUT_PROFILE, [key]: '  ' })).toBe(label)
  })

  it('链路拍板：账单国家恒为中国（Alipay 出现的前提）', () => {
    expect(CURSOR_CHECKOUT_COUNTRY).toBe('CN')
  })
})
