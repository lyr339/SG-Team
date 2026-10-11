// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountActionsMenu, type AccountMenuAction } from '../src/renderer/src/settings/AccountActionsMenu'

describe('shared account and group action menu interaction', () => {
  let host: HTMLDivElement, root: Root
  const select = vi.fn()
  const actions: AccountMenuAction[] = [
    { key:'a', label:'查看详情', onSelect:select },
    { key:'b', label:'当前不可用', disabled:true, onSelect:select },
    { key:'c', label:'编辑配置', onSelect:select }
  ]
  const trigger = () => host.querySelector<HTMLButtonElement>('button')!
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
  const buttons = () => [...menu()!.querySelectorAll<HTMLButtonElement>('button')]
  const render = async (busyLabel?: string, items = actions) => act(async () => root.render(<AccountActionsMenu label="更多操作" busyLabel={busyLabel} actions={items} />))
  const key = async (target: EventTarget, value: string) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', {key:value,bubbles:true,cancelable:true})) })
  const open = async () => act(async () => trigger().click())
  beforeEach(() => {
    ;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT = true
    host=document.createElement('div');document.body.append(host);root=createRoot(host);select.mockClear()
  })
  afterEach(async () => { await act(async () => root.unmount());host.remove();vi.restoreAllMocks() })
  it('opens with arrows and navigates enabled actions without executing them', async () => {
    await render();trigger().focus();await key(trigger(),'ArrowUp')
    expect(menu()).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('编辑配置')
    await key(document.activeElement!,'ArrowDown')
    expect(document.activeElement?.textContent).toBe('查看详情')
    await key(document.activeElement!,'End')
    expect(document.activeElement?.textContent).toBe('编辑配置')
    await key(document.activeElement!,'Home')
    expect(document.activeElement?.textContent).toBe('查看详情')
    expect(select).not.toHaveBeenCalled()
  })
  it('Escape dismisses only this layer and returns focus to its trigger', async () => {
    await render();await open()
    const outerEscape=vi.fn();window.addEventListener('keydown',outerEscape)
    try { await key(document.activeElement!,'Escape');expect(menu()).toBeNull();expect(document.activeElement).toBe(trigger());expect(outerEscape).not.toHaveBeenCalled() }
    finally { window.removeEventListener('keydown',outerEscape) }
  })
  it('internal menu scrolling does not close it; external scroll closes and restores focused trigger', async () => {
    await render();await open()
    await act(async () => menu()!.dispatchEvent(new Event('scroll')))
    expect(menu()).not.toBeNull()
    await act(async () => document.dispatchEvent(new Event('scroll')))
    expect(menu()).toBeNull();expect(document.activeElement).toBe(trigger())
  })
  it('keyboard focus leaving the menu closes it without stealing the new focus', async () => {
    await render();await open();const outside=document.createElement('button');document.body.append(outside)
    try {await act(async () => outside.focus());expect(menu()).toBeNull();expect(document.activeElement).toBe(outside)} finally {outside.remove()}
  })
  it('external busy state dismisses the old menu and does not resurrect it after completion', async () => {
    await render();await open();await render('处理中…');expect(menu()).toBeNull();expect(trigger().disabled).toBe(true)
    await render();expect(menu()).toBeNull()
  })
  it('selection restores focus before an action may open a new dialog', async () => {
    await render();await open();await act(async () => buttons()[0]!.click())
    expect(select).toHaveBeenCalledOnce();expect(menu()).toBeNull();expect(document.activeElement).toBe(trigger())
  })
  it('remeasures its anchor on resize instead of leaving a detached menu', async () => {
    await render();let left=100
    vi.spyOn(trigger(),'getBoundingClientRect').mockImplementation(() => ({left, right:left+30, top:100,bottom:130,width:30,height:30,x:left,y:100,toJSON:()=>({})}))
    await open();const original=menu()!.style.left;left=400
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(menu()!.style.left).not.toBe(original)
  })
})
