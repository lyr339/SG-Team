import { describe, expect, it } from 'vitest'
import { normalizeAccountAutomationSettings, resolveExecutionProfileId } from '../src/domain/account-automation'
import { AccountAutomationSettingsStore } from '../src/application/account-automation-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('processing-only boundary persistence', () => {
  it('only explicit false changes the old full-chain behavior', () => {
    expect(normalizeAccountAutomationSettings({ enabled: true }).postProcessingEnabled).toBeUndefined()
    expect(normalizeAccountAutomationSettings({ postProcessingEnabled: 'false' }).postProcessingEnabled).toBeUndefined()
    expect(normalizeAccountAutomationSettings({ postProcessingEnabled: false }).postProcessingEnabled).toBe(false)
  })
  it('survives restart without erasing the saved timers, handover target or browser settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-automation-boundary-'))
    try {
      const store = new AccountAutomationSettingsStore(join(root, 'settings.json'))
      store.save({ enabled: true, postProcessingEnabled: false, delaySec: 5, postProcessDelaySec: 9,
        seamlessHandoverEnabled: true, seamlessHandoverAccountId: 'spare', bitProfileId: 'window', handoverDelaySec: 3 })
      const saved = new AccountAutomationSettingsStore(store.path).load()
      expect(saved).toMatchObject({ postProcessingEnabled: false, postProcessDelaySec: 9, seamlessHandoverAccountId: 'spare', bitProfileId: 'window' })
      expect(store.save({ ...saved, postProcessingEnabled: true })).toMatchObject({ postProcessDelaySec: 9, handoverDelaySec: 3 })
      expect(store.load().postProcessingEnabled).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

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
