// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS } from '../src/domain/account-automation'
import { SettingsAutomation } from '../src/renderer/src/settings/SettingsAutomation'

describe('automation post-processing boundary', () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })
  function props(overrides: Partial<ComponentProps<typeof SettingsAutomation>> = {}): ComponentProps<typeof SettingsAutomation> {
    return { accounts: [{ id: 'one', label: 'Current', active: true, maskedToken: '••••', createdAt: 0, updatedAt: 0 },
      { id: 'two', label: 'Spare', active: false, maskedToken: '••••', createdAt: 0, updatedAt: 1 }],
      processingStatuses: { aozai: { providerId: 'aozai' as const, label: '奥仔', unit: 'points' as const, saved: true },
        henxin: { providerId: 'henxin' as const, label: '痕心', unit: 'uses' as const, saved: false } },
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, postProcessDelaySec: 8, seamlessHandoverAccountId: 'two' },
      automationRun: { phase: 'idle' as const, message: '', startedAt: 0 }, onSaveAutomationSettings: async () => true, ...overrides }
  }
  const toggle = (): HTMLInputElement => container.querySelector('input[aria-label="处理后执行后续操作"]')!

  it('keeps the old full chain on by default and makes saved processing-only options inert without erasing them', async () => {
    await act(async () => root.render(<SettingsAutomation {...props()} />))
    expect(toggle().checked).toBe(true)
    expect(container.querySelector('.settings-automation__post-options')?.hasAttribute('inert')).toBe(false)
    const settings = { ...props().automationSettings!, postProcessingEnabled: false }
    await act(async () => root.render(<SettingsAutomation {...props({ automationSettings: settings })} />))
    expect(toggle().checked).toBe(false)
    const options = container.querySelector('.settings-automation__post-options')!
    expect(options.hasAttribute('inert')).toBe(true)
    expect(options.className).not.toContain('is-open')
    expect(container.textContent).toContain('不换号、不加固、不清场')
    expect(options.querySelector<HTMLInputElement>('input[role="spinbutton"]')!.value).toBe('8')
    await act(async () => root.render(<SettingsAutomation {...props({ automationSettings: { ...settings, postProcessingEnabled: true } })} />))
    expect(container.querySelector('.settings-automation__post-options')!.className).toContain('is-open')
    expect(container.textContent).toContain('Spare')
  })

  it('awaits the authoritative save, blocks duplicate clicks and does not announce success on failure', async () => {
    let settle!: (ok: boolean) => void
    const save = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve }))
    await act(async () => root.render(<SettingsAutomation {...props({ onSaveAutomationSettings: save })} />))
    await act(async () => { toggle().click(); toggle().click() })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ postProcessingEnabled: false, postProcessDelaySec: 8, seamlessHandoverAccountId: 'two' }))
    expect(toggle().disabled).toBe(false)
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
    expect(toggle().checked).toBe(false)
    expect(container.querySelector('.settings-row .toggle-switch.is-disabled')).toBeNull()
    expect(toggle().getAttribute('aria-busy')).toBe('true')
    expect(container.textContent).toContain('加固与清场不可撤销')
    await act(async () => settle(false))
    expect(toggle().disabled).toBe(false)
    expect(toggle().checked).toBe(true)
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('未保存')
  })

  it('cannot change the boundary during either countdown, processing or cleanup', async () => {
    const save = vi.fn(async () => true)
    for (const phase of ['countdown', 'processing', 'hardening-countdown', 'cleaning'] as const) {
      await act(async () => root.render(<SettingsAutomation {...props({ automationRun: { phase, message: 'run', startedAt: 0, planId: phase }, onSaveAutomationSettings: save })} />))
      expect(toggle().disabled).toBe(true)
      await act(async () => toggle().click())
    }
    expect(save).not.toHaveBeenCalled()
  })

  it('closes an already-open portalled account menu when the downstream module is collapsed', async () => {
    await act(async () => root.render(<SettingsAutomation {...props()} />))
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="自动化无感换号接手账号"]')!
    await act(async () => trigger.click())
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    await act(async () => root.render(<SettingsAutomation {...props({ automationSettings: { ...props().automationSettings!, postProcessingEnabled: false } })} />))
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('processing-only completion shows skipped stages even when current settings were re-enabled', async () => {
    await act(async () => root.render(<SettingsAutomation {...props({ automationRun: { phase: 'done', startedAt: 0,
      finishedAt: 5000, postProcessingEnabled: false, message: '奥仔处理完成，后续未执行' } })} />))
    expect(container.querySelectorAll('.automation-run__stage.is-done')).toHaveLength(2)
    expect(container.querySelectorAll('.automation-run__stage.is-skipped')).toHaveLength(2)
    expect(container.querySelector('.automation-run__handover')).toBeNull()
  })
})
