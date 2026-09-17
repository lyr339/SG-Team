// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRequest } from '../src/domain/agent-launch'
import type { TeamControlSnapshot } from '../src/domain/team-control'
import type { CreateIndependentSessionsInput } from '../src/shared/desktop-api'
import { RunPage, type RunPageProps } from '../src/renderer/src/run/RunPage'
import type { RunGroupActions } from '../src/renderer/src/run/RunGroupsPanel'
import { desktopSnapshot } from '../src/renderer/src/preview/mock-data'
import { pooledTeam } from './run-fixtures'

const donePlan = { id: 'plan:test', state: 'done' as const, items: [], startedAt: Date.now(), finishedAt: Date.now() + 1 }
const detected = { id: 'wedge-demo', name: 'wedge-demo', path: '/Users/demo/projects/wedge-demo' }

/** 会话池：CH-1（lead）+ CH-2 成组「接口重构」；CH-3（lead）+ CH-4（离线）成组「验收」；CH-5 独立；另有一个刚解散的组。 */
function pool(status: 'running' | 'completed' = 'running') {
  return pooledTeam(
    ['waiting', 'working', 'waiting', 'offline', 'waiting'],
    [
      { name: '接口重构', goal: '收口查询路径', members: [
        { channelId: '1', roleTemplateKey: 'lead', roleName: '主控协调' },
        { channelId: '2', roleTemplateKey: 'builder', roleName: '架构实现' }
      ], leadChannelId: '1' },
      { name: '验收', members: [
        { channelId: '3', roleTemplateKey: 'lead', roleName: '主控协调' },
        { channelId: '4', roleTemplateKey: 'reviewer', roleName: '质量验证' }
      ], leadChannelId: '3', attention: true }
    ],
    { dissolved: { name: '文档整理' }, status }
  )
}

describe('RunGroupsPanel（会话池 · 协作组最小 UI）', () => {
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

  const groupsPanel = (): HTMLElement => {
    const panel = container.querySelector<HTMLElement>('.run-groups')
    if (!panel) throw new Error('groups panel not rendered')
    return panel
  }
  const card = (name: string): HTMLElement => {
    const found = [...container.querySelectorAll<HTMLElement>('.run-group')].find((node) => node.querySelector('.run-group__title strong')?.textContent === name)
    if (!found) throw new Error(`group card "${name}" not found`)
    return found
  }
  const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement => {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`button "${label}" not found in: ${[...scope.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`)
    return button
  }
  const click = async (button: HTMLButtonElement): Promise<void> => { await act(async () => button.click()) }
  const sheet = (): HTMLElement | null => container.querySelector('.run-groups [role="alertdialog"]')

  const render = async (team: TeamControlSnapshot, groupActions?: Partial<RunGroupActions>) => {
    const actions: RunGroupActions = {
      createGroup: vi.fn(async () => team),
      addGroupMembers: vi.fn(async () => team),
      removeGroupMember: vi.fn(async () => team),
      setGroupLead: vi.fn(async () => team),
      updateGroupGoal: vi.fn(async () => team),
      dissolveGroup: vi.fn(async () => team),
      ...groupActions
    }
    const props: RunPageProps = {
      team,
      detectedWorkspace: detected,
      cursorModels: desktopSnapshot.cursorModels ?? [],
      cdpAutoHealEnabled: false,
      groupActions: actions,
      onLaunchAgentSessions: vi.fn(async (_requests: AgentLaunchRequest[]) => donePlan),
      onCreateIndependentSessions: vi.fn(async (_input: CreateIndependentSessionsInput) => donePlan),
      onChooseIndependentWorkspace: vi.fn(async () => undefined),
      onEndActiveRun: vi.fn(async () => {}),
      onOpenSessions: vi.fn()
    }
    await act(async () => root.render(<RunPage {...props} />))
    return actions
  }

  it('shows grouped seats in the seat list with their group, and one card per group with lead / attention / dissolved marks', async () => {
    await render(pool())
    const seatRoles = [...container.querySelectorAll('.run-seat__who small')].map((node) => node.textContent)
    expect(seatRoles.some((text) => text?.includes('接口重构 · 主控协调'))).toBe(true)
    expect(seatRoles.some((text) => text?.includes('验收 · 质量验证'))).toBe(true)
    expect(container.querySelectorAll('.run-seat')).toHaveLength(5)

    expect(groupsPanel().querySelector('.run-section-head span')?.textContent).toBe('2 个组 · 1 个独立席位')
    const refactor = card('接口重构')
    expect(refactor.querySelector('.run-group__goal')?.textContent).toContain('收口查询路径')
    expect([...refactor.querySelectorAll('.run-group-member__who strong')].map((node) => node.textContent)).toEqual(['CH-1', 'CH-2'])
    expect(refactor.querySelector('.run-group-member__lead')?.closest('.run-group-member')?.textContent).toContain('CH-1')
    expect(refactor.querySelector<HTMLSelectElement>('.run-group__lead select')?.value).toBe(refactor.querySelector<HTMLSelectElement>('.run-group__lead select')?.options[1]?.value)

    const acceptance = card('验收')
    expect(acceptance.classList.contains('is-attention')).toBe(true)
    expect(acceptance.querySelector('.run-group__tag')?.textContent).toBe('有成员离线')
    expect(acceptance.querySelector('.run-group__goal')?.textContent).toContain('未填写组目标')

    const dissolved = card('文档整理')
    expect(dissolved.classList.contains('is-dissolved')).toBe(true)
    expect(dissolved.querySelector('.run-group__tag')?.textContent).toContain('已解散')
    expect(dissolved.querySelectorAll('button')).toHaveLength(0)
  })

  it('creates a group from the drawer: name, goal, selected seats with roles and an optional lead', async () => {
    const actions = await render(pool())
    await click(buttonIn(groupsPanel(), '建组'))
    const drawer = container.querySelector<HTMLFormElement>('.run-group-drawer')!
    expect(drawer.getAttribute('aria-label')).toBe('建组')
    // 候选只有未入组的 CH-5。
    const rows = [...drawer.querySelectorAll('.run-group-drawer__member')]
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['CH-5'])
    const submit = buttonIn(drawer, '建组（0）')
    expect(submit.disabled).toBe(true)

    const setValue = async (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
        setter?.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue(drawer.querySelector<HTMLInputElement>('input[type="text"]')!, ' 验收二组 ')
    await setValue(drawer.querySelector<HTMLTextAreaElement>('textarea')!, '补齐组作用域测试')
    await click(rows[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]')! as unknown as HTMLButtonElement)
    const roleSelect = rows[0]!.querySelector<HTMLSelectElement>('select')!
    expect(roleSelect.disabled).toBe(false)
    expect(roleSelect.value).toBe('specialist')
    expect([...roleSelect.options].map((option) => option.value)).not.toContain('solo')
    await act(async () => {
      roleSelect.value = 'reviewer'
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(rows[0]!.querySelector<HTMLInputElement>('input[type="radio"]')! as unknown as HTMLButtonElement)
    await click(buttonIn(drawer, '建组（1）'))

    expect(actions.createGroup).toHaveBeenCalledTimes(1)
    const input = (actions.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(input).toMatchObject({ name: '验收二组', goal: '补齐组作用域测试' })
    expect(input.members).toHaveLength(1)
    expect(input.members[0]).toMatchObject({ roleTemplateKey: 'reviewer' })
    expect(input.leadSlotId).toBe(input.members[0].slotId)
    // 提交成功后抽屉收起。
    expect(container.querySelector('.run-group-drawer')).toBeNull()
  })

  it('confirms before removing a member or dissolving, blocks removing a lead while others remain, and switches lead without confirmation', async () => {
    const actions = await render(pool())
    const refactor = card('接口重构')
    const removeButtons = [...refactor.querySelectorAll<HTMLButtonElement>('.run-group-member button')]
    expect(removeButtons.map((button) => [button.textContent, button.disabled])).toEqual([['移出', true], ['移出', false]])
    expect(removeButtons[0]!.title).toContain('先指定新 lead')

    // 移出 CH-2：先确认，取消不调用；确认后调用。
    await click(removeButtons[1]!)
    expect(sheet()?.textContent).toContain('把 CH-2 移出「接口重构」')
    await click(buttonIn(sheet()!, '取消'))
    expect(actions.removeGroupMember).not.toHaveBeenCalled()
    await click(removeButtons[1]!)
    await click(buttonIn(sheet()!, '确认移出'))
    expect(actions.removeGroupMember).toHaveBeenCalledWith({ groupId: pool().groupIds[0], slotId: 'slot:solo-2' })

    // 解散：一次确认。
    await click(buttonIn(refactor, '解散'))
    expect(sheet()?.textContent).toContain('解散「接口重构」')
    await click(buttonIn(sheet()!, '确认解散'))
    expect(actions.dissolveGroup).toHaveBeenCalledWith({ groupId: pool().groupIds[0] })

    // 换 lead：下拉直接生效；选「无 lead」传 null。
    const leadSelect = refactor.querySelector<HTMLSelectElement>('.run-group__lead select')!
    await act(async () => {
      leadSelect.value = 'slot:solo-2'
      leadSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(actions.setGroupLead).toHaveBeenLastCalledWith({ groupId: pool().groupIds[0], slotId: 'slot:solo-2' })
    await act(async () => {
      leadSelect.value = ''
      leadSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(actions.setGroupLead).toHaveBeenLastCalledWith({ groupId: pool().groupIds[0], slotId: null })
  })

  it('adds members through the same drawer, edits the goal inline, and surfaces service errors in the panel', async () => {
    const actions = await render(pool(), {
      addGroupMembers: vi.fn(async () => { throw new Error('席位 slot:solo-5 已在其他协作组内') })
    })
    const acceptance = card('验收')
    await click(buttonIn(acceptance, '加人'))
    const drawer = container.querySelector<HTMLFormElement>('.run-group-drawer')!
    expect(drawer.getAttribute('aria-label')).toBe('向「验收」加人')
    expect(drawer.querySelector('input[type="text"]')).toBeNull()
    await click(drawer.querySelector<HTMLInputElement>('input[type="checkbox"]')! as unknown as HTMLButtonElement)
    await click(buttonIn(drawer, '加入（1）'))
    expect(actions.addGroupMembers).toHaveBeenCalledWith({ groupId: pool().groupIds[1], members: [{ slotId: 'slot:solo-5', roleTemplateKey: 'specialist' }] })
    // 失败：错误显示在协作组区，抽屉保持打开。
    expect(groupsPanel().querySelector('[role="alert"]')?.textContent).toContain('已在其他协作组内')
    expect(container.querySelector('.run-group-drawer')).not.toBeNull()
    await click(buttonIn(drawer, '取消'))
    expect(container.querySelector('.run-group-drawer')).toBeNull()

    await click(buttonIn(card('验收'), '改目标'))
    const textarea = card('验收').querySelector<HTMLTextAreaElement>('.run-group__goal-editor textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
      setter?.call(textarea, '先跑通验收脚本')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttonIn(card('验收'), '保存目标'))
    expect(actions.updateGroupGoal).toHaveBeenCalledWith({ groupId: pool().groupIds[1], goal: '先跑通验收脚本' })
  })

  it('keeps only cleanup actions once the pool has ended, and hides the panel without actions', async () => {
    await render(pool('completed'))
    expect([...groupsPanel().querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['解散', '移出', '移出', '解散', '移出', '移出'])
    expect(groupsPanel().querySelector('.run-group__lead')).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(
      <RunPage
        team={pool()}
        detectedWorkspace={detected}
        cursorModels={desktopSnapshot.cursorModels ?? []}
        cdpAutoHealEnabled={false}
        onLaunchAgentSessions={async () => donePlan}
        onCreateIndependentSessions={async () => donePlan}
        onChooseIndependentWorkspace={async () => undefined}
        onEndActiveRun={async () => {}}
        onOpenSessions={() => {}}
      />
    ))
    expect(container.querySelector('.run-groups')).toBeNull()
  })
})
