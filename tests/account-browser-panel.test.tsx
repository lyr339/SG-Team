// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, type AccountAutomationSettings } from '../src/domain/account-automation'
import { AccountBrowserPanel } from '../src/renderer/src/lobby/AccountBrowserPanel'

describe('AccountBrowserPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders the environment cleanup action with two-click confirmation and result feedback', async () => {
    const cleanupCalls: number[] = []
    function Harness(): React.JSX.Element {
      const [settings, setSettings] = useState<AccountAutomationSettings>({
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'win-1'
      })
      return (
        <AccountBrowserPanel
          settings={settings}
          disabled={false}
          isWindows={false}
          providerLabel="Roxy"
          profiles={[
            { id: 'win-1', name: '代理窗口', seq: 4 },
            { id: 'win-2', name: '直连窗口', seq: 5 }
          ]}
          apiKeyStatus={{ saved: true, maskedKey: '6192****eada' }}
          onSettingsChange={setSettings}
          onCleanupEnvironment={async () => {
            cleanupCalls.push(1)
            if (cleanupCalls.length === 1) throw new Error('Roxy 本地缓存清理失败：window is open')
          }}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    const button = () => container.querySelector<HTMLButtonElement>('.account-browser__cleanup-button')!

    // 首次点击：进入确认态（琥珀提示），不触发清理。
    expect(container.querySelector('.account-browser__cleanup')).toBeTruthy()
    expect(button().textContent).toContain('一键清理')
    await act(async () => button().click())
    expect(cleanupCalls).toHaveLength(0)
    expect(button().textContent).toContain('确认清理')
    expect(button().classList.contains('is-confirming')).toBe(true)

    // 二次点击：执行清理；失败信息就地反馈。
    await act(async () => button().click())
    expect(cleanupCalls).toHaveLength(1)
    expect(container.textContent).toContain('Roxy 本地缓存清理失败：window is open')

    // 切换 profile 解除确认态并清空反馈（选项经 portal 渲染到 document.body）。
    await act(async () => button().click())
    expect(button().textContent).toContain('确认清理')
    const windowSelect = container.querySelector('.menu-select__button') as HTMLButtonElement
    await act(async () => windowSelect.click())
    const option = Array.from(document.body.querySelectorAll('.menu-select__menu button'))
      .find((element) => element.textContent?.includes('#5')) as HTMLButtonElement
    await act(async () => option.click())
    expect(button().textContent).toContain('一键清理')
  })

  it('lets a saved Roxy API Key be replaced: 更换 opens the input, 保存 overwrites, 取消 keeps the old key', async () => {
    const saved: string[] = []
    function Harness(): React.JSX.Element {
      const [settings, setSettings] = useState<AccountAutomationSettings>({
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'win-1'
      })
      const [status, setStatus] = useState({ saved: true, maskedKey: '6192****eada' })
      return (
        <AccountBrowserPanel
          settings={settings}
          disabled={false}
          isWindows={false}
          providerLabel="Roxy"
          profiles={[{ id: 'win-1', name: '代理窗口', seq: 4 }]}
          apiKeyStatus={status}
          onSettingsChange={setSettings}
          onSaveApiKey={async (key) => {
            saved.push(key)
            setStatus({ saved: true, maskedKey: `${key.slice(0, 4)}****${key.slice(-4)}` })
          }}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    const keyCell = () => container.querySelector('.account-browser__key-cell')!
    const buttonNamed = (text: string): HTMLButtonElement | undefined => Array.from(keyCell().querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === text)

    // 已保存：只回显掩码 + 「更换」，没有输入框（这正是此前无法更改的缺陷点）。
    expect(keyCell().querySelector('code')?.textContent).toBe('6192****eada')
    expect(keyCell().querySelector('input')).toBeNull()
    expect(buttonNamed('更换')).toBeTruthy()

    // 「更换」→ 输入态：输入框 + 「保存」（不足 8 位禁用）+ 「取消」。
    await act(async () => buttonNamed('更换')!.click())
    const input = () => keyCell().querySelector<HTMLInputElement>('input')!
    expect(input()).toBeTruthy()
    expect(input().placeholder).toBe('粘贴新的 Roxy API Key')
    expect(buttonNamed('保存')!.disabled).toBe(true)
    expect(buttonNamed('取消')).toBeTruthy()

    // 「取消」→ 回到掩码态，旧 Key 不动。
    await act(async () => buttonNamed('取消')!.click())
    expect(keyCell().querySelector('input')).toBeNull()
    expect(keyCell().querySelector('code')?.textContent).toBe('6192****eada')
    expect(saved).toHaveLength(0)

    // 再次「更换」并粘贴新 Key → 「保存」可用 → 保存后掩码更新、退出输入态。
    await act(async () => buttonNamed('更换')!.click())
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input(), '  roxy-new-key-7788  ')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttonNamed('保存')!.disabled).toBe(false)
    await act(async () => buttonNamed('保存')!.click())
    expect(saved).toEqual(['roxy-new-key-7788'])
    expect(keyCell().querySelector('input')).toBeNull()
    expect(keyCell().querySelector('code')?.textContent).toBe('roxy****7788')
    expect(buttonNamed('更换')).toBeTruthy()
  })

  it('switches the whole-pipeline browser source and renders provider-specific configuration', async () => {
    function Harness(): React.JSX.Element {
      const [settings, setSettings] = useState<AccountAutomationSettings>({
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'win-1'
      })
      return (
        <AccountBrowserPanel
          settings={settings}
          disabled={false}
          isWindows={false}
          providerLabel="Roxy"
          profiles={[{ id: 'win-1', name: '代理窗口', seq: 4 }]}
          apiKeyStatus={{ saved: true, maskedKey: '6192****eada' }}
          onSettingsChange={setSettings}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    expect(container.textContent).toContain('会话浏览器')
    expect(container.textContent).toContain('贯穿全流程')
    expect(container.textContent).toContain('#4 代理窗口')
    expect(container.querySelectorAll('.account-browser__connection-row')).toHaveLength(1)
    expect(container.querySelector('.account-browser__key-row')).toBeNull()
    expect(container.querySelector('.account-browser__window-row')).toBeNull()
    const system = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('系统浏览器'))!
    await act(async () => system.click())
    expect(system.getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toContain('使用现有登录会话')
    expect(container.textContent).toContain('Edge / Chrome')
  })
})
