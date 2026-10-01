// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsNotice, type SettingsNoticeMessage } from '../src/renderer/src/settings/SettingsNotice'

describe('设置操作反馈', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  const render = async (message: SettingsNoticeMessage, onDismiss = vi.fn()): Promise<void> => {
    await act(async () => root.render(<SettingsNotice message={message} onDismiss={onDismiss} />))
  }
  const toggle = (): HTMLButtonElement => host.querySelector('.settings-notice__toggle')!

  it('成功只展示短结果，完整诊断可自行展开；重渲染不打断阅读', async () => {
    const message: SettingsNoticeMessage = { tone: 'success', title: '账号切换完成', detail: '登录态与机器码已保存。调试端口已就绪。' }
    await render(message)
    expect(host.querySelector('[role="status"]')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    const detail = host.querySelector('.settings-notice__details')!
    expect(detail.getAttribute('aria-hidden')).toBe('true')
    expect(detail.hasAttribute('inert')).toBe(true)
    await act(async () => toggle().click())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(detail.textContent).toBe(message.detail)
    await render({ ...message })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })

  it.each(['warning', 'error'] as const)('%s 的原因默认展开，不静默隐藏故障；下一次成功恢复紧凑态', async (tone) => {
    await render({ tone, title: '账号切换未完成', detail: '请重新获取 Token。' })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('aside')?.getAttribute('role')).toBe(tone === 'error' ? 'alert' : 'status')
    await render({ tone: 'success', title: '账号切换完成', detail: '已确认目标账号。' })
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('关闭仅通知调用方，没有计时器，也不会触发详情展开', async () => {
    const dismiss = vi.fn()
    await render({ tone: 'success', title: '账号切换完成' }, dismiss)
    expect(host.querySelector('.settings-notice__toggle')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!.click())
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
