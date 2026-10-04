// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyTaskPoolSnapshot } from '../src/domain/task-pool'
import { emptyTeamCollaborationSnapshot } from '../src/domain/team-collaboration'
import { GroupContextPanel, type GroupContextPanelProps } from '../src/renderer/src/team/GroupContextPanel'
import { groupContextView } from '../src/renderer/src/team/group-context-view'
import { pooledTeam } from './run-fixtures'

describe('in-session team task creation and draft lifecycle', () => {
  let root: Root, container: HTMLDivElement
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.querySelectorAll('.menu-select__menu').forEach((node) => node.remove())
  })
  const fixture = () => {
    const team = pooledTeam(
      ['waiting', 'waiting'],
      [
        {
          name: '接口组',
          members: [
            { channelId: '1', roleTemplateKey: 'lead', roleName: '主控' },
            { channelId: '2', roleTemplateKey: 'builder', roleName: '实现' }
          ],
          leadChannelId: '1'
        }
      ]
    )
    const view = groupContextView(
      team,
      '1',
      emptyTaskPoolSnapshot(),
      emptyTeamCollaborationSnapshot(team.activeRun!.id)
    )
    return { team, view }
  }
  const render = async (
    view: GroupContextPanelProps['view'],
    onPlanTask = vi.fn<GroupContextPanelProps['onPlanTask']>(async () => {})
  ) => {
    const props = { view, onPlanTask, onOpenSession: vi.fn(), onManageGroup: vi.fn() }
    await act(async () => root.render(<GroupContextPanel key={view.scopeKey} {...props} />))
    return props
  }
  const button = (name: string) => {
    const el = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (el) => el.textContent === name
    )
    if (!el) throw Error(`Missing ${name}`)
    return el
  }
  const click = async (el: HTMLElement) => {
    await act(async () => el.click())
  }
  const input = async (value: string) => {
    const el = container.querySelector<HTMLInputElement>('input[name="task-title"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('requires a title, focuses the invalid field and submits only the current group with the chosen draft', async () => {
    const f = fixture(),
      props = await render(f.view)
    await click(button('新增任务'))
    await click(button('创建任务'))
    expect(props.onPlanTask).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('名称')
    expect(document.activeElement).toBe(container.querySelector('input'))
    await input('验证组隔离')
    await click(button('创建任务'))
    expect(props.onPlanTask).toHaveBeenCalledOnce()
    expect(props.onPlanTask.mock.calls[0]).toEqual([
      f.view.group!.group.id,
      expect.objectContaining({ title: '验证组隔离', key: expect.stringContaining('operator:') })
    ])
    expect(container.querySelector('form')).toBeNull()
    expect(document.activeElement).toBe(button('新增任务'))
  })
  it('retains a rejected draft and uses the same stable key for a same-payload retry', async () => {
    const f = fixture(),
      save = vi.fn<GroupContextPanelProps['onPlanTask']>(async () => {
        throw Error('临时不可用')
      })
    await render(f.view, save)
    await click(button('新增任务'))
    await input('保留草稿')
    await click(button('创建任务'))
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('保留草稿')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('临时不可用')
    await click(button('创建任务'))
    expect(save.mock.calls[0]?.[1]).toEqual(save.mock.calls[1]?.[1])
  })
  it('guards same-frame duplicate submits while preserving the unsaved draft when merely folded', async () => {
    const f = fixture()
    let finish!: () => void
    const save = vi.fn<GroupContextPanelProps['onPlanTask']>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await render(f.view, save)
    await click(button('新增任务'))
    await input('一次提交')
    await act(async () => {
      const form = container.querySelector('form')!
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(save).toHaveBeenCalledOnce()
    expect(button('创建中…').disabled).toBe(true)
    await act(async () => finish())
    await click(button('新增任务'))
    await input('未提交的草稿')
    await click(button('收起草稿'))
    await click(button('新增任务'))
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('未提交的草稿')
  })
  it('does not let a late success in an old group clear a new scope draft', async () => {
    const f = fixture()
    let finish!: () => void
    const save = vi.fn<GroupContextPanelProps['onPlanTask']>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await render(f.view, save)
    await click(button('新增任务'))
    await input('旧组任务')
    await click(button('创建任务'))
    const other = { ...f.view, scopeKey: 'another-run:another-group' }
    await render(other)
    await click(button('新增任务'))
    await input('新组草稿')
    await act(async () => finish())
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('新组草稿')
  })
  it('stops planning and closes a draft when the pool ends', async () => {
    const f = fixture()
    await render(f.view)
    await click(button('新增任务'))
    await input('尚未提交')
    await render({ ...f.view, mutable: false })
    expect(container.querySelector('form')).toBeNull()
    expect([...container.querySelectorAll('button')].some((el) => el.textContent === '新增任务')).toBe(false)
    expect(container.textContent).toContain('只读')
    expect(container.querySelectorAll('.group-context__members .is-ended')).toHaveLength(2)
    expect(container.querySelector('.group-context__members .is-working, .group-context__members .is-waiting')).toBeNull()
  })
})
