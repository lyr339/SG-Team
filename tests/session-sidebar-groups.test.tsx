// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { SessionSidebar, type RailSelectionActions } from '../src/renderer/src/SessionSidebar'
import type { RailGroupSource } from '../src/renderer/src/session-rail-view'

const sessions = (ids: string[]) => ids.map((id, index) => ({
  id,
  channelId: String(index + 1),
  displayName: `CH-${index + 1}`,
  online: true,
  waiting: true,
  connectionPhase: 'waiting',
  status: 'waiting' as const
}))

function snapshotOf(ids: string[]): DesktopSnapshot {
  return {
    sessions: sessions(ids) as DesktopSnapshot['sessions'],
    connection: { state: 'connected' }
  } as unknown as DesktopSnapshot
}

/** 默认名册：「验收」组 CH-1（lead）+ CH-2，独立 CH-3 / 4 / 5。 */
const GROUPS: RailGroupSource[] = [
  { id: 'g1', name: '验收', channelIds: ['1', '2'], leadChannelId: '1', attention: false }
]

function actionsOf(overrides?: Partial<RailSelectionActions>): RailSelectionActions {
  return {
    createGroup: vi.fn(),
    addToGroup: vi.fn(),
    removeFromGroups: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('SessionSidebar 名册多选与浮动条', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
  })

  interface RenderOptions {
    ids?: string[]
    groups?: RailGroupSource[]
    actions?: RailSelectionActions
    onSelect?: (channelId: string) => void
  }

  async function render(options: RenderOptions = {}): Promise<void> {
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={snapshotOf(options.ids ?? ['a', 'b', 'c', 'd', 'e'])}
          onSelectSession={options.onSelect ?? (() => {})}
          groups={options.groups ?? GROUPS}
          selectionActions={options.actions}
        />
      )
    })
  }

  function rowOf(channelId: string): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(`.session-row[data-channel-id="${channelId}"]`)!
  }
  async function clickRow(channelId: string, init?: MouseEventInit): Promise<void> {
    await act(async () => {
      rowOf(channelId).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
    })
  }
  function checkboxOf(channelId: string): HTMLInputElement {
    return rowOf(channelId).closest('.session-list__slot')!.querySelector<HTMLInputElement>('.session-row__pick input')!
  }
  const bar = (): HTMLElement | null => container.querySelector<HTMLElement>('.session-pane__bar')
  function barButton(text: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.session-pane__bar button'))
      .find((button) => button.textContent?.includes(text))
  }
  const pickedChannels = (): string[] => Array.from(
    container.querySelectorAll<HTMLElement>('.session-list__slot.is-picked .session-row')
  ).map((row) => row.dataset.channelId!)

  it('⌘/Ctrl+点击切换选中、Shift+点击选范围，都不打开会话；普通点击打开并清选', async () => {
    const onSelect = vi.fn()
    await render({ actions: actionsOf(), onSelect })

    await clickRow('3', { ctrlKey: true })
    expect(pickedChannels()).toEqual(['3'])
    expect(bar()!.textContent).toContain('已选 1')

    // Shift 范围：锚点 CH-3 → CH-5，同段全选。
    await clickRow('5', { shiftKey: true })
    expect(pickedChannels()).toEqual(['3', '4', '5'])
    expect(barButton('建组（3）')).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()

    // 普通点击是「打开」：清掉暂态选集。
    await clickRow('4')
    expect(onSelect).toHaveBeenCalledWith('4')
    expect(bar()).toBeNull()
  })

  it('Shift 范围不跨分区：锚点在独立段、点组内行时退化为单选切换', async () => {
    await render({ actions: actionsOf() })
    await clickRow('3', { ctrlKey: true })
    await clickRow('2', { shiftKey: true })
    expect(pickedChannels()).toEqual(['2', '3'])
  })

  it('复选框选中（Shift+勾选 = 范围），行 aria-label 标注已选中', async () => {
    await render({ actions: actionsOf() })
    await act(async () => {
      checkboxOf('4').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(pickedChannels()).toEqual(['4'])
    expect(rowOf('4').getAttribute('aria-label')).toContain('已选中')

    await act(async () => {
      checkboxOf('3').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    })
    expect(pickedChannels()).toEqual(['3', '4'])
    expect(checkboxOf('3').checked).toBe(true)
  })

  it('建组：独立选集按名册可见顺序交给抽屉，随后清选', async () => {
    const actions = actionsOf()
    await render({ actions })
    await clickRow('4', { ctrlKey: true })
    await clickRow('3', { ctrlKey: true })
    await act(async () => { barButton('建组（2）')!.click() })
    expect(actions.createGroup).toHaveBeenCalledWith(['3', '4'])
    expect(bar()).toBeNull()
    expect(pickedChannels()).toEqual([])
  })

  it('加入现有组：下拉选组后把选集交给抽屉', async () => {
    const actions = actionsOf()
    await render({ actions })
    await clickRow('3', { ctrlKey: true })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.session-pane__bar .menu-select__button')!.click()
    })
    const option = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-select__menu button'))
      .find((button) => button.textContent?.includes('验收'))!
    await act(async () => { option.click() })
    expect(actions.addToGroup).toHaveBeenCalledWith('g1', ['3'])
    expect(bar()).toBeNull()
  })

  it('混合选择只提供移出组，并说明独立会话不受影响', async () => {
    await render({ actions: actionsOf() })
    await clickRow('2', { ctrlKey: true })
    await clickRow('3', { ctrlKey: true })
    expect(barButton('移出组（1）')).toBeTruthy()
    expect(barButton('建组')).toBeUndefined()
    expect(container.querySelector('.session-pane__bar-hint')!.textContent).toContain('1 个独立会话不受影响')
  })

  it('lead 在选集里且组内还有别人：移出禁用并说明；取消选择 lead 后恢复', async () => {
    await render({ actions: actionsOf() })
    await clickRow('1', { ctrlKey: true })
    await clickRow('2', { ctrlKey: true })
    const remove = barButton('移出组（2）')!
    expect(remove.disabled).toBe(true)
    expect(container.querySelector('.session-pane__bar-hint')!.textContent).toContain('CH-1 是所在组的 lead')

    await clickRow('1', { ctrlKey: true })
    expect(barButton('移出组（1）')!.disabled).toBe(false)
  })

  it('lead 是组里唯一成员时可以移出（与服务端 lead_must_transfer_first 同口径）', async () => {
    await render({
      ids: ['a', 'b', 'c'],
      groups: [{ id: 'g2', name: '文档', channelIds: ['1'], leadChannelId: '1', attention: false }],
      actions: actionsOf()
    })
    await clickRow('1', { ctrlKey: true })
    expect(barButton('移出组（1）')!.disabled).toBe(false)
  })

  it('移出：确认面文案与组卡片同源，确认后执行动作并清选', async () => {
    const actions = actionsOf()
    await render({ actions })
    await clickRow('2', { ctrlKey: true })
    await act(async () => { barButton('移出组（1）')!.click() })
    const sheet = container.querySelector('.session-pane__bar .run-sheet')!
    expect(sheet.textContent).toContain('把 CH-2 移出「验收」')
    await act(async () => {
      sheet.querySelector<HTMLButtonElement>('.run-sheet__confirm')!.click()
    })
    expect(actions.removeFromGroups).toHaveBeenCalledWith(['2'])
    expect(bar()).toBeNull()
  })

  it('确认面取消：回到动作行，焦点回到「移出组」', async () => {
    await render({ actions: actionsOf() })
    await clickRow('2', { ctrlKey: true })
    await act(async () => { barButton('移出组（1）')!.click() })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.run-sheet .secondary-button')!.click()
    })
    expect(container.querySelector('.run-sheet')).toBeNull()
    const remove = barButton('移出组（1）')!
    expect(document.activeElement).toBe(remove)
    expect(pickedChannels()).toEqual(['2'])
  })

  it('移出失败：确认面收起、提示错误、选集保留', async () => {
    const actions = actionsOf({
      removeFromGroups: vi.fn().mockRejectedValue(new Error('组员正在交接，稍后再试'))
    })
    await render({ actions })
    await clickRow('2', { ctrlKey: true })
    await act(async () => { barButton('移出组（1）')!.click() })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.run-sheet__confirm')!.click()
    })
    expect(container.querySelector('.run-sheet')).toBeNull()
    const hint = container.querySelector('.session-pane__bar-hint')!
    expect(hint.className).toContain('is-danger')
    expect(hint.textContent).toContain('组员正在交接')
    expect(pickedChannels()).toEqual(['2'])
  })

  it('Esc 清选（确认面开着时不清，由确认面自己接管 Esc）', async () => {
    await render({ actions: actionsOf() })
    await clickRow('3', { ctrlKey: true })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(bar()).toBeNull()

    await clickRow('2', { ctrlKey: true })
    await act(async () => { barButton('移出组（1）')!.click() })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    // 确认面收起，但选集还在——Esc 一次只收一层。
    expect(container.querySelector('.run-sheet')).toBeNull()
    expect(pickedChannels()).toEqual(['2'])
  })

  it('键盘：Ctrl+空格切换、Shift+空格选到此行，空格默认行为被取消', async () => {
    const onSelect = vi.fn()
    await render({ actions: actionsOf(), onSelect })
    const toggleAllowed = rowOf('3').dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true, cancelable: true })
    )
    await act(async () => {})
    expect(toggleAllowed).toBe(false)
    expect(pickedChannels()).toEqual(['3'])

    const rangeAllowed = rowOf('5').dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true, cancelable: true })
    )
    await act(async () => {})
    expect(rangeAllowed).toBe(false)
    expect(pickedChannels()).toEqual(['3', '4', '5'])
    expect(onSelect).not.toHaveBeenCalled()
    // keyup 同样被取消：修饰键空格不落成 click。
    const keyupAllowed = rowOf('5').dispatchEvent(
      new KeyboardEvent('keyup', { key: ' ', shiftKey: true, bubbles: true, cancelable: true })
    )
    expect(keyupAllowed).toBe(false)
  })

  it('席位离开名册时选集收缩，掉光后浮动条消失', async () => {
    await render({ actions: actionsOf() })
    await clickRow('3', { ctrlKey: true })
    expect(bar()).toBeTruthy()
    // CH-3（第三个会话 c）离池：选集里没有别人，浮动条一并消失。
    await render({ ids: ['a', 'b'], actions: actionsOf() })
    expect(bar()).toBeNull()
  })

  it('没有 selectionActions：不渲染复选框，修饰键点击照常打开会话', async () => {
    const onSelect = vi.fn()
    await render({ onSelect })
    expect(container.querySelector('.session-row__pick')).toBeNull()
    await clickRow('3', { ctrlKey: true })
    expect(onSelect).toHaveBeenCalledWith('3')
    expect(bar()).toBeNull()
  })
})
