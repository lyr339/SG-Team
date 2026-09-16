// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRequest } from '../src/domain/agent-launch'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { CreateIndependentSessionsInput } from '../src/shared/desktop-api'
import { RunPage, type RunPageProps } from '../src/renderer/src/run/RunPage'
import { desktopSnapshot } from '../src/renderer/src/preview/mock-data'
import { independentTeam, teamRun } from './run-fixtures'

const donePlan = { id: 'plan:test', state: 'done' as const, items: [], startedAt: Date.now(), finishedAt: Date.now() + 1 }
const detected = { id: 'wedge-demo', name: 'wedge-demo', path: '/Users/demo/projects/wedge-demo' }

describe('RunPage（一个工程一个会话池；阶段 2 · 2B 起没有团队模式）', () => {
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

  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('button')]
  const buttonNamed = (label: string): HTMLButtonElement => {
    const button = buttons().find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`button "${label}" not found in: ${buttons().map((b) => b.textContent?.trim()).join(' | ')}`)
    return button
  }
  // 确认面与提示条住在可折叠插槽里；收起后内容会为过渡再停留一会（inert），只有展开的插槽算"显示中"。
  const sheet = (): HTMLElement | null => container.querySelector('.run-slot.is-open [role="alertdialog"]')
  const status = (): HTMLElement | null => container.querySelector('.run-slot.is-open .run-feedback')
  const click = async (button: HTMLButtonElement): Promise<void> => { await act(async () => button.click()) }

  const render = async (team: TeamControlSnapshot, overrides: Partial<RunPageProps> = {}) => {
    const handlers = {
      onLaunchAgentSessions: vi.fn(async (_requests: AgentLaunchRequest[]) => donePlan),
      onCreateIndependentSessions: vi.fn(async (_input: CreateIndependentSessionsInput) => donePlan),
      onChooseIndependentWorkspace: vi.fn(async () => undefined),
      onEndActiveRun: vi.fn(async () => {}),
      onOpenSessions: vi.fn()
    }
    await act(async () => root.render(
      <RunPage
        team={team}
        detectedWorkspace={detected}
        cursorModels={desktopSnapshot.cursorModels ?? []}
        cdpAutoHealEnabled={false}
        {...handlers}
        {...overrides}
      />
    ))
    return handlers
  }

  describe('头部与席位', () => {
    it('renders the pool with per-seat state labels and a batch summary; there is no mode switch', async () => {
      await render(independentTeam(['waiting', 'working', 'offline', 'unconfirmed']))
      expect(container.querySelector('.run-header__eyebrow')?.textContent).toBe('独立批次')
      expect(container.querySelector('.run-mode-switch')).toBeNull()
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('待命 1 · 执行中 1')
      const badges = [...container.querySelectorAll('.run-seat__badge')].map((node) => node.className.replace('run-seat__badge ', ''))
      expect(badges).toEqual(['is-waiting', 'is-working', 'is-offline', 'is-unconfirmed'])
      expect(container.textContent).toContain('尚无工具调用证据')
      expect(container.querySelector('.run-batch__count')?.textContent).toBe('2/ 4 在岗')
      // 有席位尚无运行证据：先确认再开放重建。
      expect(buttonNamed('补齐会话（2）').disabled).toBe(true)
      expect(container.textContent).toContain('正在确认离线会话的运行状态')
      expect(buttonNamed('结束批次').disabled).toBe(false)
    })

    it('shows every seat on duty when all are waiting', async () => {
      await render(independentTeam(['waiting', 'waiting']))
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('待命 2/2')
      expect(container.querySelector('.run-batch__count')?.textContent).toBe('2/ 2 在岗')
      expect(buttons().some((button) => button.textContent?.startsWith('补齐会话'))).toBe(false)
    })
  })

  describe('结束批次（软守卫）', () => {
    it('同一拍重复结束只发一次 IPC，失败后释放互斥并允许重试', async () => {
      let reject!: (reason: Error) => void
      const onEndActiveRun = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
      await render(independentTeam(['offline']), { onEndActiveRun })
      const end = buttonNamed('结束批次')
      await act(async () => { end.click(); end.click() })
      expect(onEndActiveRun).toHaveBeenCalledTimes(1)
      expect(buttonNamed('结束中…').disabled).toBe(true)
      await act(async () => { reject(new Error('临时失败')) })
      expect(buttonNamed('结束批次').disabled).toBe(false)
      await click(buttonNamed('结束批次'))
      expect(onEndActiveRun).toHaveBeenCalledTimes(2)
      await act(async () => { reject(new Error('临时失败')) })
    })

    it('批量创建在途时阻止结束与新建，不依赖本页 busy 状态', async () => {
      const handlers = await render(independentTeam(['offline']), { agentLaunchPlan: { ...donePlan, state: 'running' } })
      expect(buttonNamed('结束批次').disabled).toBe(true)
      expect(buttonNamed('结束并新建批次').disabled).toBe(true)
      await click(buttonNamed('结束批次'))
      expect(handlers.onEndActiveRun).not.toHaveBeenCalled()
    })

    it('confirms before ending a batch with live sessions, then reports the fence consequence', async () => {
      const { onEndActiveRun } = await render(independentTeam(['waiting', 'waiting']))
      await click(buttonNamed('结束批次'))
      expect(onEndActiveRun).not.toHaveBeenCalled()
      expect(sheet()?.textContent).toContain('结束当前独立批次')
      expect(sheet()?.textContent).toContain('2 个会话仍在线或待确认')
      expect(sheet()?.textContent).toContain('下一次轮询（最长 60 秒）收到结束指令并自行退出')
      await click(buttonNamed('确认结束'))
      expect(onEndActiveRun).toHaveBeenCalledTimes(1)
      expect(sheet()).toBeNull()
      expect(status()?.textContent).toContain('独立批次已结束；旧会话会在下一次轮询自行退出。')
    })

    it('ends an all-offline batch immediately and surfaces failures inline', async () => {
      const onEndActiveRun = vi.fn(async () => { throw new Error('运行状态已变化，请刷新后重试') })
      await render(independentTeam(['offline', 'offline']), { onEndActiveRun })
      await click(buttonNamed('结束批次'))
      expect(sheet()).toBeNull()
      expect(onEndActiveRun).toHaveBeenCalledTimes(1)
      expect(status()?.className).toContain('is-error')
      expect(status()?.textContent).toContain('运行状态已变化')
    })

    it('disables ending an already ended run', async () => {
      await render(independentTeam(['waiting'], 'completed'))
      expect(buttonNamed('结束批次').disabled).toBe(true)
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('批次已结束')
      expect(container.textContent).toContain('本批次已结束，可以直接开始新批次')
    })
  })

  describe('补齐 / 新建 / 换工程', () => {
    it('tops up the existing batch on the same workspace instead of creating a new run', async () => {
      const { onCreateIndependentSessions, onLaunchAgentSessions } = await render(independentTeam(['offline', 'offline']))
      await click(buttonNamed('补齐会话（2）'))
      expect(onLaunchAgentSessions).toHaveBeenCalledTimes(1)
      expect(onLaunchAgentSessions.mock.calls[0]?.[0].map((request) => request.channelId)).toEqual(['1', '2'])
      expect(onCreateIndependentSessions).not.toHaveBeenCalled()
    })

    it('guards "结束并新建批次" once while sessions are live; confirm opens the configurator and creating does not ask again', async () => {
      const { onCreateIndependentSessions } = await render(independentTeam(['waiting', 'waiting']))
      expect(container.textContent).not.toContain('会话数量')
      await click(buttonNamed('结束并新建批次'))
      expect(sheet()?.textContent).toContain('新建独立批次')
      expect(sheet()?.textContent).toContain('2 个会话仍在线或待确认')
      await click(buttonNamed('取消'))
      expect(container.textContent).not.toContain('会话数量')

      await click(buttonNamed('结束并新建批次'))
      await click(buttonNamed('确认新建'))
      expect(container.textContent).toContain('会话数量')
      expect(container.querySelector('.run-slot.is-open .run-banner')?.textContent).toContain('正在配置新的独立批次：创建后当前独立批次结束')
      // 头部本身不变：状态芯片仍是当前运行的。
      expect(container.querySelector('.run-header .run-state-chip')?.textContent).toBe('待命 2/2')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      expect(onCreateIndependentSessions.mock.calls[0]?.[0]).toMatchObject({ workspacePath: detected.path })
      expect(onCreateIndependentSessions.mock.calls[0]?.[0].sessions).toHaveLength(3)
    })

    it('"放弃" returns from the configurator to the current run', async () => {
      await render(independentTeam(['offline']))
      await click(buttonNamed('结束并新建批次'))
      expect(sheet()).toBeNull()
      expect(container.textContent).toContain('会话数量')
      await click(buttonNamed('放弃'))
      expect(container.textContent).not.toContain('会话数量')
      expect(container.querySelector('.run-batch__count')?.textContent).toBe('0/ 1 在岗')
    })

    it('an ended batch starts a new run (never reuses retired session tokens)', async () => {
      const { onCreateIndependentSessions, onLaunchAgentSessions } = await render(independentTeam(['offline'], 'completed'))
      await click(buttonNamed('新建批次'))
      expect(sheet()).toBeNull()
      expect(container.querySelector('.run-slot.is-open .run-banner')?.textContent).toContain('在下方选好数量与模型后创建')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      expect(onLaunchAgentSessions).not.toHaveBeenCalled()
    })

    it('Cursor switched project: the new batch targets the detected workspace and is guarded once', async () => {
      const next = { id: 'project-b', name: '新工程 B', path: '/projects/b' }
      const { onCreateIndependentSessions } = await render(independentTeam(['waiting']), { detectedWorkspace: next })
      expect(container.textContent).toContain('Cursor 当前打开的不是本批次的工程')
      await click(buttonNamed('结束并新建批次'))
      expect(sheet()?.textContent).toContain('在「新工程 B」新建批次')
      await click(buttonNamed('确认新建'))
      expect(container.querySelector('.run-field__value code')?.textContent).toBe('/projects/b')
      expect(container.textContent).toContain('Cursor 已切换工程：新批次将创建到「新工程 B」')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(onCreateIndependentSessions).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/projects/b' }))
    })

    it('adjusts the session count within 1–16', async () => {
      await render(independentTeam(['offline'], 'completed'))
      await click(buttonNamed('新建批次'))
      const output = (): string => container.querySelector('output')?.textContent ?? ''
      expect(output()).toBe('3')
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')!)
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')!)
      expect(output()).toBe('1')
      expect(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')?.disabled).toBe(true)
      expect(buttonNamed('创建 1 个独立会话')).toBeTruthy()
      expect(container.querySelectorAll('.run-seat')).toHaveLength(1)
    })
  })

  describe('无活跃运行', () => {
    it('goes straight to the batch configurator and creates without any confirmation', async () => {
      const { onCreateIndependentSessions } = await render(emptyTeamControlSnapshot())
      expect(container.textContent).toContain('开始一次运行')
      expect(container.textContent).toContain('Cursor 当前打开的工程')
      expect(container.textContent).not.toContain('旧团队运行已归档')
      expect(container.querySelector('.run-header')).toBeNull()
      expect(container.textContent).toContain('会话数量')
      expect(container.querySelectorAll('.run-seat')).toHaveLength(3)
      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
    })

    it('treats an archived legacy team run as no run: start page with one explanatory note, creating asks nothing (2B)', async () => {
      const { onCreateIndependentSessions, onEndActiveRun } = await render(teamRun('waiting', 'completed'))
      expect(container.textContent).toContain('开始一次运行')
      expect(container.querySelector('.run-start__note')?.textContent).toContain('旧团队运行已归档')
      expect(container.querySelector('.run-start__note')?.textContent).toContain('独立批次')
      expect(container.querySelector('.run-header')).toBeNull()
      expect(container.textContent).not.toContain('主控协调')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      expect(onEndActiveRun).not.toHaveBeenCalled()
    })

    it('waits for a workspace before offering the seats when Cursor has no project open', async () => {
      await render(emptyTeamControlSnapshot(), { detectedWorkspace: undefined })
      expect(container.textContent).toContain('先在 Cursor 中打开一个工程')
      expect(container.textContent).toContain('Cursor 工程识别完成后即可配置独立会话')
      expect(buttons().some((button) => button.textContent?.startsWith('创建'))).toBe(false)
    })
  })
})
