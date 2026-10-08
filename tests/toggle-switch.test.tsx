// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToggleSwitch } from '../src/renderer/src/lobby/ToggleSwitch'

describe('stable shared toggle interactions', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  const input = () => host.querySelector<HTMLInputElement>('input')!
  it('keeps one pending intent, focus and contrast, and blocks duplicate clicks until authoritative settlement', async () => {
    let resolve!: (ok: boolean) => void
    const save = vi.fn(() => new Promise<boolean>(done => { resolve = done }))
    await act(async () => root.render(<ToggleSwitch checked={false} label="自动检查" onChange={save} />))
    const node = input(); node.focus()
    await act(async () => node.click())
    expect(node.checked).toBe(true); expect(node.disabled).toBe(false)
    expect(node.getAttribute('aria-busy')).toBe('true'); expect(document.activeElement).toBe(node)
    expect(host.querySelector('.is-disabled')).toBeNull()
    await act(async () => { node.click(); node.click() }); expect(save).toHaveBeenCalledTimes(1)
    expect(node.checked).toBe(true)
    await act(async () => { root.render(<ToggleSwitch checked={true} label="自动检查" onChange={save} />); resolve(true) })
    expect(input()).toBe(node); expect(node.checked).toBe(true); expect(node.hasAttribute('aria-busy')).toBe(false)
  })
  it('rolls a failed save back to the controlled state and permits retry', async () => {
    let reject!: (reason: Error) => void
    const save = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue(false)
    await act(async () => root.render(<ToggleSwitch checked={false} label="开关" onChange={save} />))
    await act(async () => input().click()); expect(input().checked).toBe(true)
    await act(async () => reject(Error('private disk detail')))
    expect(input().checked).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toBe('设置未保存，请重试。')
    expect(host.textContent).not.toContain('private disk detail')
    await act(async () => input().click()); expect(save).toHaveBeenCalledTimes(2); expect(input().checked).toBe(false)
  })
  it('distinguishes an unavailable switch from a transient operation lock without losing keyboard focus', async () => {
    const save = vi.fn()
    await act(async () => root.render(<ToggleSwitch checked={true} label="开关" onChange={save} />))
    input().focus()
    await act(async () => root.render(<ToggleSwitch checked={true} busy label="开关" onChange={save} />))
    expect(input().disabled).toBe(false); expect(document.activeElement).toBe(input())
    await act(async () => input().click()); expect(save).not.toHaveBeenCalled(); expect(input().checked).toBe(true)
    await act(async () => root.render(<ToggleSwitch checked={true} disabled label="开关" onChange={save} />))
    expect(input().disabled).toBe(true); expect(host.querySelector('.is-disabled')).not.toBeNull()
  })
  it('does not introduce pending state into synchronous draft switches', async () => {
    const save = vi.fn()
    await act(async () => root.render(<ToggleSwitch checked={false} label="模型草稿" onChange={save} />))
    await act(async () => input().click())
    expect(save).toHaveBeenCalledWith(true); expect(input().getAttribute('aria-busy')).toBeNull()
    expect(host.querySelector('.is-saving')).toBeNull()
  })
  it('keeps an operational capability unconfirmed until its real operation and controlled state settle', async () => {
    let resolve!: () => void
    const save = () => new Promise<void>(done => { resolve = done })
    await act(async () => root.render(<ToggleSwitch checked={false} optimistic={false} label="补丁能力" onChange={save} />))
    await act(async () => input().click())
    expect(input().checked).toBe(false); expect(input().getAttribute('aria-busy')).toBe('true')
    await act(async () => { root.render(<ToggleSwitch checked={true} optimistic={false} label="补丁能力" onChange={save} />); resolve() })
    expect(input().checked).toBe(true)
  })
  it('does not update an unmounted switch when a late save settles', async () => {
    let resolve!: () => void
    await act(async () => root.render(<ToggleSwitch checked={false} label="开关" onChange={() => new Promise<void>(done => { resolve = done })} />))
    await act(async () => input().click()); await act(async () => root.render(null))
    await act(async () => resolve()); expect(host.childElementCount).toBe(0)
  })
})
