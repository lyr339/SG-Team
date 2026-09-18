// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRequest } from '../src/domain/agent-launch'
import type { TeamTask } from '../src/domain/task-pool'
import type { TeamControlSnapshot } from '../src/domain/team-control'
import type { CreateIndependentSessionsInput } from '../src/shared/desktop-api'
import { PoolPage, type PoolGroupActions, type PoolPageProps } from '../src/renderer/src/run/PoolPage'
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

describe('PoolPage · 协作组卡片网格', () => {
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
    // MenuSelect / 操作菜单的弹层挂在 body 上，逐用例清掉。
    document.body.querySelectorAll('.menu-select__menu, .account-actions-menu').forEach((node) => node.remove())
  })

  const groupsSection = (): HTMLElement => {
    const section = container.querySelector<HTMLElement>('.pool-groups')
    if (!section) throw new Error('groups section not rendered')
    return section
  }
  const card = (name: string): HTMLElement => {
    const found = [...container.querySelectorAll<HTMLElement>('.group-card')].find((node) => node.querySelector('.group-card__title strong')?.textContent === name)
    if (!found) throw new Error(`group card "${name}" not found`)
    return found
  }
  const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement => {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`button "${label}" not found in: ${[...scope.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`)
    return button
  }
  const click = async (element: Element): Promise<void> => { await act(async () => (element as HTMLElement).click()) }
  const sheet = (): HTMLElement | null => container.querySelector('[role="alertdialog"]')
  /** 打开卡片的「⋯」菜单并返回弹层（挂在 body）。 */
  const openMenu = async (scope: HTMLElement): Promise<HTMLElement> => {
    const trigger = scope.querySelector<HTMLButtonElement>('.account-actions-menu__trigger')
    if (!trigger) throw new Error('actions menu trigger not found')
    await click(trigger)
    const menu = document.body.querySelector<HTMLElement>('.account-actions-menu')
    if (!menu) throw new Error('actions menu not open')
    return menu
  }

  interface RenderOverrides {
    groupActions?: Partial<PoolGroupActions>
    taskPool?: PoolPageProps['taskPool']
    onOpenGroupComposer?: PoolPageProps['onOpenGroupComposer']
    onTransferMembership?: PoolPageProps['onTransferMembership']
    focusGroupId?: string
    withoutGroupActions?: boolean
  }

  const render = async (team: TeamControlSnapshot, overrides: RenderOverrides = {}) => {
    const actions: PoolGroupActions = {
      removeGroupMember: vi.fn(async () => team),
      setGroupLead: vi.fn(async () => team),
      updateGroupGoal: vi.fn(async () => team),
      dissolveGroup: vi.fn(async () => team),
      ...overrides.groupActions
    }
    const props: PoolPageProps = {
      team,
      detectedWorkspace: detected,
      cursorModels: desktopSnapshot.cursorModels ?? [],
      cdpAutoHealEnabled: false,
      ...(overrides.withoutGroupActions ? {} : { groupActions: actions }),
      taskPool: overrides.taskPool,
      onOpenGroupComposer: overrides.onOpenGroupComposer,
      onTransferMembership: overrides.onTransferMembership,
      focusGroupId: overrides.focusGroupId,
      onLaunchAgentSessions: vi.fn(async (_requests: AgentLaunchRequest[]) => donePlan),
      onCreateIndependentSessions: vi.fn(async (_input: CreateIndependentSessionsInput) => donePlan),
      onChooseIndependentWorkspace: vi.fn(async () => undefined),
      onEndActiveRun: vi.fn(async () => {}),
      onOpenSessions: vi.fn()
    }
    await act(async () => root.render(<PoolPage {...props} />))
    return actions
  }

  it('shows grouped seats in the seat list with their group, and one card per group with lead / attention marks', async () => {
    await render(pool())
    const seatRoles = [...container.querySelectorAll('.run-seat__who small')].map((node) => node.textContent)
    expect(seatRoles.some((text) => text?.includes('接口重构 · 主控协调'))).toBe(true)
    expect(seatRoles.some((text) => text?.includes('验收 · 质量验证'))).toBe(true)
    expect(container.querySelectorAll('.run-seat')).toHaveLength(5)

    expect(groupsSection().querySelector('.run-section-head span')?.textContent).toBe('2 个组 · 1 个独立会话')
    const refactor = card('接口重构')
    expect(refactor.querySelector('.group-card__goal')?.textContent).toContain('收口查询路径')
    expect([...refactor.querySelectorAll('.group-card-member__who strong')].map((node) => node.textContent)).toEqual(['CH-1', 'CH-2'])
    expect(refactor.querySelector('.group-card-member__lead')?.closest('.group-card-member')?.textContent).toContain('CH-1')
    expect(refactor.querySelector('.group-card__lead .menu-select__value')?.textContent).toContain('CH-1')

    const acceptance = card('验收')
    expect(acceptance.classList.contains('is-attention')).toBe(true)
    expect(acceptance.querySelector('.group-card__tag')?.textContent).toBe('成员离线')
    expect(acceptance.querySelector('.group-card__goal')?.textContent).toContain('未填写组目标')
  })

  it('keeps dissolved groups read-only inside the collapsed history section', async () => {
    await render(pool())
    const history = groupsSection().querySelector<HTMLDetailsElement>('.pool-groups__history')
    expect(history).not.toBeNull()
    expect(history!.querySelector('summary')?.textContent).toContain('1 个已解散的组')
    const dissolved = card('文档整理')
    expect(dissolved.classList.contains('is-dissolved')).toBe(true)
    expect(dissolved.querySelector('.group-card__tag')?.textContent).toContain('已解散')
    expect(dissolved.querySelectorAll('button')).toHaveLength(0)
  })

  it('confirms before removing a member or dissolving, blocks removing a lead while others remain, and switches lead without confirmation', async () => {
    const actions = await render(pool())
    const refactor = card('接口重构')
    const removeButtons = [...refactor.querySelectorAll<HTMLButtonElement>('.group-card-member__actions button')]
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

    // 解散在「⋯」菜单里：一次确认，确认按钮走红色。
    await click(buttonIn(await openMenu(card('接口重构')), '解散本组…'))
    expect(sheet()?.textContent).toContain('解散「接口重构」')
    expect(sheet()!.querySelector('.run-sheet__confirm')?.classList.contains('is-danger')).toBe(true)
    await click(buttonIn(sheet()!, '确认解散'))
    expect(actions.dissolveGroup).toHaveBeenCalledWith({ groupId: pool().groupIds[0] })

    // 换 lead：MenuSelect 直接生效；选「无 lead」传 null。
    const leadSelect = card('接口重构').querySelector<HTMLElement>('.group-card__lead .menu-select')!
    await click(leadSelect.querySelector('.menu-select__button')!)
    await click(buttonIn(document.body.querySelector('.menu-select__menu')!, 'CH-2 · 架构实现'))
    expect(actions.setGroupLead).toHaveBeenLastCalledWith({ groupId: pool().groupIds[0], slotId: 'slot:solo-2' })
    await click(leadSelect.querySelector('.menu-select__button')!)
    await click(buttonIn(document.body.querySelector('.menu-select__menu')!, '无 lead'))
    expect(actions.setGroupLead).toHaveBeenLastCalledWith({ groupId: pool().groupIds[0], slotId: null })
  })

  it('routes 建组 / 加人 to the app-level composer, offers 交接 for offline members, and edits the goal inline', async () => {
    const onOpenGroupComposer = vi.fn()
    const onTransferMembership = vi.fn()
    const actions = await render(pool(), { onOpenGroupComposer, onTransferMembership })

    await click(buttonIn(groupsSection().querySelector('.run-section-head')!, '建组'))
    expect(onOpenGroupComposer).toHaveBeenLastCalledWith({ kind: 'create' })
    await click(buttonIn(card('验收'), '加人'))
    expect(onOpenGroupComposer).toHaveBeenLastCalledWith({ kind: 'add', groupId: pool().groupIds[1], groupName: '验收' })

    // 离线成员（验收组 CH-4）多一个「交接…」；在线成员没有。
    const offlineRow = [...card('验收').querySelectorAll<HTMLElement>('.group-card-member')].find((row) => row.classList.contains('is-offline'))!
    await click(buttonIn(offlineRow, '交接…'))
    expect(onTransferMembership).toHaveBeenCalledWith('slot:solo-4')
    expect(card('接口重构').textContent).not.toContain('交接…')

    // 改目标在「⋯」菜单里：内联编辑器 + 保存。
    await click(buttonIn(await openMenu(card('验收')), '写目标'))
    const textarea = card('验收').querySelector<HTMLTextAreaElement>('.group-card__goal-editor textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
      setter?.call(textarea, '先跑通验收脚本')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttonIn(card('验收'), '保存目标'))
    expect(actions.updateGroupGoal).toHaveBeenCalledWith({ groupId: pool().groupIds[1], goal: '先跑通验收脚本' })
    expect(card('验收').querySelector('.group-card__goal-editor')).toBeNull()
  })

  it('shows the task board counters from the task pool snapshot', async () => {
    const snapshot = pool()
    const runId = snapshot.activeRun!.id
    const groupId = snapshot.groupIds[0]!
    const task = (id: string, status: TeamTask['status']): TeamTask => ({
      id, runId, key: id, title: id, description: '', acceptance: '', priority: 1,
      status, dependsOn: [], requiredCapabilities: [], maxAttempts: 3, attemptCount: 0, progress: 0,
      createdAt: 1, updatedAt: 1, groupId
    })
    const tasks = [task('t1', 'queued'), task('t2', 'running'), task('t3', 'review'), task('t4', 'done')]
    await render(snapshot, {
      taskPool: { tasks: Object.fromEntries(tasks.map((item) => [item.id, item])), taskOrder: tasks.map((item) => item.id) }
    })
    const counters = card('接口重构').querySelector('.group-card__counters')!
    expect(counters.textContent).toContain('进行 2')
    expect(counters.textContent).toContain('验收 1')
    expect(counters.textContent).toContain('完成 1')
    // 没有任务的组不显示计数区。
    expect(card('验收').querySelector('.group-card__counters')).toBeNull()
  })

  it('keeps only cleanup actions once the pool has ended, and hides the section without group actions', async () => {
    await render(pool('completed'))
    const acceptance = card('验收')
    // 结束后：不再加人 / 换 lead / 交接 / 改目标；菜单只剩解散，成员行只剩移出。
    expect([...acceptance.querySelectorAll('button')].some((button) => button.textContent?.trim() === '加人')).toBe(false)
    expect(acceptance.querySelector('.group-card__lead')).toBeNull()
    expect(acceptance.textContent).not.toContain('交接…')
    const menu = await openMenu(acceptance)
    expect([...menu.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['解散本组…'])

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(
      <PoolPage
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
    expect(container.querySelector('.pool-groups')).toBeNull()
  })

  it('flashes and reveals the focused group card when arriving from the session header chip', async () => {
    const snapshot = pool()
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
    await render(snapshot, { focusGroupId: snapshot.groupIds[1] })
    expect(card('验收').classList.contains('is-focused')).toBe(true)
    expect(scrolled.some((element) => element === card('验收'))).toBe(true)
    expect(card('接口重构').classList.contains('is-focused')).toBe(false)
  })
})
