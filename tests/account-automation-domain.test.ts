import { describe, expect, it } from 'vitest'
import { resolveExecutionProfileId } from '../src/domain/account-automation'

/**
 * 自动化执行链的窗口解析（唯一权威规则）：
 * 活跃账号绑定优先，未绑定回退默认窗口——主进程装配与设置页预览共用此函数。
 */
describe('resolveExecutionProfileId', () => {
  const bound = { active: true, fingerprintProfileId: 'win-1' }

  it('活跃账号有绑定 → 绑定窗口优先于默认窗口', () => {
    expect(resolveExecutionProfileId([bound], 'win-default')).toBe('win-1')
  })

  it('活跃账号未绑定 → 回退默认窗口', () => {
    expect(resolveExecutionProfileId([{ active: true }], 'win-default')).toBe('win-default')
  })

  it('非活跃账号的绑定绝不参与解析', () => {
    expect(resolveExecutionProfileId([
      { active: false, fingerprintProfileId: 'win-other' },
      { active: true }
    ], 'win-default')).toBe('win-default')
  })

  it('无活跃账号 → 回退默认窗口（vault_empty 降级语义）', () => {
    expect(resolveExecutionProfileId([{ active: false, fingerprintProfileId: 'win-1' }], 'win-default')).toBe('win-default')
  })

  it('绑定与默认都缺失 → undefined（调用方抛带引导的错误）', () => {
    expect(resolveExecutionProfileId([{ active: true }])).toBeUndefined()
    expect(resolveExecutionProfileId([], undefined)).toBeUndefined()
  })

  it('空白绑定/空白默认视为缺失，不污染解析结果', () => {
    expect(resolveExecutionProfileId([{ active: true, fingerprintProfileId: '  ' }], 'win-default')).toBe('win-default')
    expect(resolveExecutionProfileId([{ active: true }], '  ')).toBeUndefined()
    expect(resolveExecutionProfileId([{ active: true, fingerprintProfileId: ' win-1 ' }])).toBe('win-1')
  })
})
