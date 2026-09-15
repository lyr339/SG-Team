// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS } from '../src/domain/account-automation'
import { SettingsPage as LobbyAccountTile } from '../src/renderer/src/settings/SettingsPage'
import type { SettingsPageProps as LobbyAccountTileProps } from '../src/renderer/src/settings/settings-view'

describe('Cursor 本机维护操作', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    history.replaceState(null, '', '#account:maintenance')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  function props(overrides: Partial<LobbyAccountTileProps> = {}): LobbyAccountTileProps {
    return {
      accounts: [],
      busy: false,
      error: '',
      onSave: async () => {},
      onSelect: async () => {},
      onRemove: async () => {},
      automationSettings: {
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'roxy-1'
      },
      automationRun: { phase: 'idle', message: '', startedAt: 0 },
      cursorUpdatePreferences: {
        settingsPath: '/tmp/Cursor/User/settings.json',
        updateMode: undefined,
        autoUpdateDisabled: false,
        settingsExists: true
      },
      ...overrides
    }
  }

  it('两个配置操作都调用真实回调，政策确认完成后回显主进程结果', async () => {
    const setUpdate = vi.fn(async () => {})
    const setPolicy = vi.fn(async () => ({ message: '已确认 claude-fable-5 的数据政策' }))
    await act(async () => root.render(<LobbyAccountTile {...props({
      automationSettings: {
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'roxy-1',
        autoAcknowledgeModelDataPolicies: false
      },
      onSetCursorAutoUpdateDisabled: setUpdate,
      onSetModelDataPolicyAutoAcknowledge: setPolicy
    })} />))

    const toggleByLabel = (text: string): HTMLInputElement =>
      container.querySelector<HTMLInputElement>(`input[aria-label="${text}"]`)!
    const updateToggle = toggleByLabel('关闭 Cursor 自动更新')
    await act(async () => updateToggle.click())
    expect(setUpdate).toHaveBeenCalledWith(true)

    const policyToggle = toggleByLabel('自动确认受限模型数据政策')
    expect(policyToggle.disabled).toBe(false)
    await act(async () => policyToggle.click())
    expect(setPolicy).toHaveBeenCalledWith(true)
    expect(container.textContent).toContain('已确认 claude-fable-5 的数据政策')
  })

  it('未选择 Roxy 窗口时仍可关闭自动确认，并提示重新开启所需条件', async () => {
    const setPolicy = vi.fn(async () => ({ message: '已关闭' }))
    await act(async () => root.render(<LobbyAccountTile {...props({
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, browserHost: 'fingerprint' },
      onSetModelDataPolicyAutoAcknowledge: setPolicy
    })} />))
    const input = container.querySelector<HTMLInputElement>('input[aria-label="自动确认受限模型数据政策"]')!
    const label = input.closest('label')!
    expect(input.disabled).toBe(false)
    expect(label.title).toContain('重新开启前请先在「导入来源」选择默认窗口')
    await act(async () => input.click())
    expect(setPolicy).toHaveBeenCalledWith(false)
  })

  it('会员等级刷新期间旋转并阻止重复点击，完成后恢复', async () => {
    history.replaceState(null, '', '#account:accounts')
    let resolveRefresh!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve }))
    await act(async () => root.render(<LobbyAccountTile {...props({
      accounts: [{ id: 'account:1', label: 'work@example.com', maskedToken: '••••9f2k', active: true, createdAt: 1, updatedAt: 1 }],
      membership: { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } },
      onRefreshMembership: refresh
    })} />))
    const button = container.querySelector<HTMLButtonElement>('.account-membership-refresh')!
    await act(async () => button.click())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(button.className).toContain('is-refreshing')
    expect(button.disabled).toBe(true)
    await act(async () => resolveRefresh())
    expect(button.className).not.toContain('is-refreshing')
    expect(button.disabled).toBe(false)
  })

  it('复用外部兼容切号泵时开关呈开态禁用，不给拾光卸载权限', async () => {
    const remove = vi.fn(async () => {})
    await act(async () => root.render(<LobbyAccountTile {...props({
      switchPumpStatus: {
        kind: 'installed', managed: false, message: '检测到兼容切号补丁',
        config: { port: 51_824, key: 'masked', revision: 2 }
      },
      onEnsureSwitchPump: async () => {},
      onRemoveSwitchPump: remove
    })} />))
    const row = container.querySelector('.cursor-maintenance__switch-pump')!
    expect(row.classList.contains('is-compatible')).toBe(true)
    const toggle = row.querySelector<HTMLInputElement>('input[aria-label="切号补丁（无感换号）"]')!
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)
    expect(row.querySelector('button')).toBeNull()
    expect(row.textContent).toContain('端口 51824')
    expect(row.textContent).toContain('拾光只复用、不覆盖或卸载')
    expect(remove).not.toHaveBeenCalled()
  })

  it('未安装与拾光管理的已安装补丁由开关触发安装／移除', async () => {
    const ensure = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    const render = (installed: boolean) => root.render(<LobbyAccountTile {...props({
      switchPumpStatus: installed
        ? { kind: 'installed', managed: true, message: 'ok', config: { port: 51_824, key: 'key', revision: 1 } }
        : { kind: 'not-installed', message: '切号补丁未安装' },
      onEnsureSwitchPump: ensure, onRemoveSwitchPump: remove
    })} />)
    await act(async () => render(false))
    const row = () => container.querySelector('.cursor-maintenance__switch-pump')!
    expect(row().textContent).toContain('未安装')
    const toggle = () => row().querySelector<HTMLInputElement>('input[aria-label="切号补丁（无感换号）"]')!
    expect(toggle().checked).toBe(false)
    await act(async () => toggle().click())
    expect(ensure).toHaveBeenCalledTimes(1)
    await act(async () => render(true))
    expect(row().textContent).toContain('已安装（端口 51824）')
    expect(toggle().checked).toBe(true)
    await act(async () => toggle().click())
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('把内部 updateMode=none 翻译为用户可读状态', async () => {
    await act(async () => root.render(<LobbyAccountTile {...props({
      cursorUpdatePreferences: {
        settingsPath: '/tmp/settings.json', updateMode: 'none',
        autoUpdateDisabled: true, settingsExists: true
      },
      onSetCursorAutoUpdateDisabled: async () => {}
    })} />))
    const hints = [...container.querySelectorAll('.settings-row__hint')].map((node) => node.textContent)
    expect(hints.some((text) => text?.includes('已关闭'))).toBe(true)
    expect(container.textContent).not.toContain('none')
  })
})
