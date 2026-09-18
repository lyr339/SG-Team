// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupComposer, type GroupComposerMode } from '../src/renderer/src/run/GroupComposer'
import type { UngroupedSeat } from '../src/renderer/src/run/pool-view'
import type { CreateTeamGroupInput, TeamGroupMembersInput } from '../src/shared/desktop-api'

const candidates: UngroupedSeat[] = [
  { slotId: 'slot:solo-2', channelId: '2', name: '独立席 2', state: 'waiting', avatarId: 'researcher' },
  { slotId: 'slot:solo-5', channelId: '5', name: '独立席 5', state: 'working', avatarId: 'architect' },
  { slotId: 'slot:solo-7', channelId: '7', name: '独立席 7', state: 'offline', avatarId: 'lead' }
]

describe('GroupComposer（建组 / 加人抽屉）', () => {
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
    document.body.querySelectorAll('.menu-select__menu').forEach((node) => node.remove())
  })

  const drawer = (): HTMLFormElement => {
    const form = container.querySelector<HTMLFormElement>('.group-composer')
    if (!form) throw new Error('composer not rendered')
    return form
  }
  const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement => {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`button "${label}" not found in: ${[...scope.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`)
    return button
  }
  const click = async (element: Element): Promise<void> => { await act(async () => (element as HTMLElement).click()) }
  const memberRows = (): HTMLElement[] => [...drawer().querySelectorAll<HTMLElement>('.group-composer__member')]
  const setValue = async (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
      setter?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const render = async (mode: GroupComposerMode, overrides: {
    busy?: boolean
    error?: string
    onClose?: () => void
    candidates?: UngroupedSeat[]
  } = {}) => {
    const handlers = {
      onClose: overrides.onClose ?? vi.fn(),
      onCreate: vi.fn<(input: CreateTeamGroupInput) => void>(),
      onAddMembers: vi.fn<(input: TeamGroupMembersInput) => void>()
    }
    await act(async () => root.render(
      <GroupComposer
        mode={mode}
        candidates={overrides.candidates ?? candidates}
        defaultName="组 2"
        busy={overrides.busy ?? false}
        error={overrides.error}
        onClose={handlers.onClose}
        onCreate={handlers.onCreate}
        onAddMembers={handlers.onAddMembers}
      />
    ))
    return handlers
  }

  it('prefills the default name, requires a name and at least one member, and snapshots the createGroup input', async () => {
    const { onCreate } = await render({ kind: 'create' })
    const nameInput = drawer().querySelector<HTMLInputElement>('input[type="text"]')!
    expect(nameInput.value).toBe('组 2')
    // 还没选成员：提交不可用。
    expect(buttonIn(drawer(), '建组（0）').disabled).toBe(true)

    // 勾选 CH-2 与 CH-5；名字清空后提交仍不可用。
    await click(memberRows()[0]!.querySelector('input[type="checkbox"]')!)
    await click(memberRows()[1]!.querySelector('input[type="checkbox"]')!)
    await setValue(nameInput, '  ')
    expect(buttonIn(drawer(), '建组（2）').disabled).toBe(true)
    await setValue(nameInput, ' 验收二组 ')
    await setValue(drawer().querySelector<HTMLTextAreaElement>('textarea')!, ' 补齐组作用域测试 ')

    // CH-5 的组内角色换成 reviewer（角色下拉不含 solo）。
    await click(memberRows()[1]!.querySelector('.menu-select__button')!)
    const roleMenu = document.body.querySelector<HTMLElement>('.menu-select__menu')!
    expect([...roleMenu.querySelectorAll('[role="option"] button')].map((option) => option.textContent?.trim())).not.toContain('独立会话')
    await click(buttonIn(roleMenu, '质量验证'))

    // lead 单选限定在已勾选成员里。
    await click(memberRows()[0]!.querySelector('input[type="radio"]')!)
    await click(buttonIn(drawer(), '建组（2）'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0]).toEqual({
      name: '验收二组',
      goal: '补齐组作用域测试',
      leadSlotId: 'slot:solo-2',
      planPolicy: undefined,
      members: [
        { slotId: 'slot:solo-2', roleTemplateKey: 'specialist' },
        { slotId: 'slot:solo-5', roleTemplateKey: 'reviewer' }
      ]
    })
  })

  it('drops the lead (and re-shows the plan policy) when its seat is unchecked, and only shows the policy toggle without a lead', async () => {
    const { onCreate } = await render({ kind: 'create', preselectedChannelIds: ['2', '5'] })
    // 预勾选来自名册多选。
    expect(memberRows().map((row) => (row.querySelector('input[type="checkbox"]') as HTMLInputElement).checked)).toEqual([true, true, false])

    // 默认无 lead：策略开关可见，默认「成员可规划」。
    expect(drawer().querySelector('.group-composer__policy')).not.toBeNull()
    await click(memberRows()[0]!.querySelector('input[type="radio"]')!)
    // 选了 lead：策略开关隐藏（有 lead 时规划权归 lead，策略不生效）。
    expect(drawer().querySelector('.group-composer__policy')).toBeNull()

    // lead 席位被取消勾选：lead 自动回到「无 lead」，策略开关回来。
    await click(memberRows()[0]!.querySelector('input[type="checkbox"]')!)
    expect((drawer().querySelector('.group-composer__lead-pick.is-none input') as HTMLInputElement).checked).toBe(true)
    expect(drawer().querySelector('.group-composer__policy')).not.toBeNull()

    // 关掉「成员可规划任务」：无 lead + lead_only（任务只能由用户创建）。
    await click(drawer().querySelector('.group-composer__policy input[type="checkbox"]')!)
    await click(buttonIn(drawer(), '建组（1）'))
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ leadSlotId: undefined, planPolicy: 'lead_only', members: [{ slotId: 'slot:solo-5', roleTemplateKey: 'specialist' }] })
  })

  it('add mode has no name / goal / lead / policy, and submits the target group with selected members', async () => {
    const { onAddMembers, onCreate } = await render({ kind: 'add', groupId: 'team-group:ws:g2', groupName: '验收' })
    expect(drawer().querySelector('#group-composer-title')?.textContent).toBe('向「验收」加人')
    expect(drawer().querySelector('input[type="text"]')).toBeNull()
    expect(drawer().querySelector('textarea')).toBeNull()
    expect(drawer().querySelector('input[type="radio"]')).toBeNull()
    expect(drawer().querySelector('.group-composer__policy')).toBeNull()

    await click(memberRows()[2]!.querySelector('input[type="checkbox"]')!)
    await click(buttonIn(drawer(), '加入（1）'))
    expect(onAddMembers).toHaveBeenCalledWith({ groupId: 'team-group:ws:g2', members: [{ slotId: 'slot:solo-7', roleTemplateKey: 'specialist' }] })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows the service error inline, closes on Escape / backdrop unless busy, and explains an empty candidate list', async () => {
    const onClose = vi.fn()
    await render({ kind: 'create' }, { error: '席位 slot:solo-5 已在其他协作组内', onClose })
    expect(drawer().querySelector('[role="alert"]')?.textContent).toContain('已在其他协作组内')

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    const backdrop = container.querySelector<HTMLElement>('.group-composer-backdrop')!
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(2)

    // busy 时不可关闭，提交按钮显示进行中。
    const busyClose = vi.fn()
    await render({ kind: 'create' }, { busy: true, onClose: busyClose })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(busyClose).not.toHaveBeenCalled()
    expect(buttonIn(drawer(), '处理中…').disabled).toBe(true)

    // 没有候选：说明去处。
    await render({ kind: 'add', groupId: 'g', groupName: '验收' }, { candidates: [] })
    expect(drawer().querySelector('.group-composer__empty')?.textContent).toContain('没有未入组的会话')
  })
})
