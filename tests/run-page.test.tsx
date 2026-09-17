// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRequest } from '../src/domain/agent-launch'
import type { CursorModelSelection } from '../src/domain/cursor-model'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { CreateIndependentSessionsInput } from '../src/shared/desktop-api'
import { RunPage, type RunPageProps } from '../src/renderer/src/run/RunPage'
import { desktopSnapshot } from '../src/renderer/src/preview/mock-data'
import { independentTeam, teamRun } from './run-fixtures'

const donePlan = { id: 'plan:test', state: 'done' as const, items: [], startedAt: Date.now(), finishedAt: Date.now() + 1 }
const detected = { id: 'wedge-demo', name: 'wedge-demo', path: '/Users/demo/projects/wedge-demo' }

describe('RunPage（一个工程一个活跃运行：团队 / 独立两种模式）', () => {
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
  const modeButton = (label: '团队' | '独立'): HTMLButtonElement => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('.run-mode-switch button')]
      .find((candidate) => candidate.querySelector('b')?.textContent === label)
    if (!button) throw new Error(`mode "${label}" not found`)
    return button
  }
  // 确认面与提示条住在可折叠插槽里；收起后内容会为过渡再停留一会（inert），只有展开的插槽算"显示中"。
  const sheet = (): HTMLElement | null => container.querySelector('.run-slot.is-open [role="alertdialog"]')
  const status = (): HTMLElement | null => container.querySelector('.run-slot.is-open .run-feedback')
  const click = async (button: HTMLButtonElement): Promise<void> => { await act(async () => button.click()) }

  const render = async (team: TeamControlSnapshot, overrides: Partial<RunPageProps> = {}) => {
    const handlers = {
      onChooseWorkspace: vi.fn(async () => {}),
      onReconfigure: vi.fn(async () => {}),
      onUpdateGoal: vi.fn(async () => team),
      onInstallMcp: vi.fn(async () => team),
      onLaunch: vi.fn(async () => team),
      onCreateNextRun: vi.fn(async () => ({ snapshot: team })),
      onLaunchAgentSessions: vi.fn(async (_requests: AgentLaunchRequest[]) => donePlan),
      onCreateIndependentSessions: vi.fn(async (_input: CreateIndependentSessionsInput) => donePlan),
      onChooseIndependentWorkspace: vi.fn(async () => undefined),
      onEndActiveRun: vi.fn(async () => {}),
      onOpenSessions: vi.fn(),
      onPersistModelSelection: vi.fn(async (_channelId: string, _selection: CursorModelSelection) => team)
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
    it('renders the team run with its mode, state chip and only the team seats', async () => {
      await render(teamRun('waiting', 'running'))
      expect(container.querySelector('.run-header__eyebrow')?.textContent).toBe('团队运行')
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('协作执行中')
      expect(modeButton('团队').getAttribute('aria-checked')).toBe('true')
      const seats = [...container.querySelectorAll('.run-seat__who strong')].map((node) => node.textContent)
      expect(seats.length).toBeGreaterThan(0)
      expect(container.querySelector('.run-seats .run-section-head span')?.textContent).toBe('全部在岗')
      expect(container.textContent).toContain('所有席位已在岗，无需创建会话')
      expect(container.textContent).not.toContain('独立席')
      expect(buttonNamed('结束运行').disabled).toBe(false)
    })

    it('renders an independent batch with per-seat state labels and a batch summary', async () => {
      await render(independentTeam(['waiting', 'working', 'offline', 'unconfirmed']))
      expect(container.querySelector('.run-header__eyebrow')?.textContent).toBe('独立批次')
      expect(modeButton('独立').getAttribute('aria-checked')).toBe('true')
      const badges = [...container.querySelectorAll('.run-seat__badge')].map((node) => node.className.replace('run-seat__badge ', ''))
      expect(badges).toEqual(['is-waiting', 'is-working', 'is-offline', 'is-unconfirmed'])
      expect(container.textContent).toContain('尚无工具调用证据')
      expect(container.querySelector('.run-batch__count')?.textContent).toBe('2/ 4 在岗')
      // 有席位尚无运行证据：先确认再开放重建。
      expect(buttonNamed('补齐会话（2）').disabled).toBe(true)
      expect(container.textContent).toContain('正在确认离线会话的运行状态')
    })
  })

  describe('结束运行（软守卫）', () => {
    it.each(['draft', 'ready'] as const)('未启动 %s 直接配置独立批次，不调用结束接口且仍可放弃', async (phase) => {
      const handlers = await render(teamRun('offline', phase))
      expect(buttonNamed('结束运行').disabled).toBe(true)
      await click(modeButton('独立'))
      if (sheet()) await click(buttonNamed('确认切换'))
      expect(container.textContent).toContain('创建后替换当前未启动的配置，无需先结束运行')
      await click(buttonNamed('结束运行'))
      expect(handlers.onEndActiveRun).not.toHaveBeenCalled()
      await click(buttonNamed('放弃'))
      expect(modeButton('团队').getAttribute('aria-checked')).toBe('true')
      await click(modeButton('独立'))
      if (sheet()) await click(buttonNamed('确认切换'))
      await click(buttonNamed('创建 3 个独立会话'))
      expect(handlers.onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      expect(handlers.onEndActiveRun).not.toHaveBeenCalled()
    })

    it('同一拍重复结束只发一次 IPC，失败后释放互斥并允许重试', async () => {
      let reject!: (reason: Error) => void
      const onEndActiveRun = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
      await render(independentTeam(['offline']), { onEndActiveRun })
      const end = buttonNamed('结束批次')
      await act(async () => { end.click(); end.click() })
      expect(onEndActiveRun).toHaveBeenCalledTimes(1)
      expect(modeButton('团队').disabled).toBe(true)
      await act(async () => { reject(new Error('临时失败')) })
      expect(buttonNamed('结束批次').disabled).toBe(false)
      await click(buttonNamed('结束批次'))
      expect(onEndActiveRun).toHaveBeenCalledTimes(2)
      await act(async () => { reject(new Error('临时失败')) })
    })

    it('批量创建在途时阻止模式切换和结束，不依赖本页 busy 状态', async () => {
      const handlers = await render(independentTeam(['offline']), { agentLaunchPlan: { ...donePlan, state: 'running' } })
      expect(buttonNamed('结束批次').disabled).toBe(true)
      expect(modeButton('团队').disabled).toBe(true)
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
    })
  })

  describe('模式切换（唯一入口：头部分段控件）', () => {
    it('asks once before switching a live batch to team mode; cancel keeps everything running', async () => {
      const { onChooseWorkspace } = await render(independentTeam(['waiting', 'working', 'unconfirmed', 'offline']))
      await click(modeButton('团队'))
      expect(onChooseWorkspace).not.toHaveBeenCalled()
      expect(sheet()?.textContent).toContain('切换到团队模式')
      expect(sheet()?.textContent).toContain('3 个会话仍在线或待确认')
      expect(sheet()?.textContent).toContain('随后进入组队流程')
      await click(buttonNamed('取消'))
      expect(sheet()).toBeNull()
      expect(onChooseWorkspace).not.toHaveBeenCalled()
      await click(modeButton('团队'))
      await click(buttonNamed('确认切换'))
      expect(onChooseWorkspace).toHaveBeenCalledTimes(1)
    })

    it('switches an ended or all-offline batch to team mode without asking', async () => {
      const ended = await render(independentTeam(['waiting'], 'completed'))
      await click(modeButton('团队'))
      expect(sheet()).toBeNull()
      expect(ended.onChooseWorkspace).toHaveBeenCalledTimes(1)

      const offline = await render(independentTeam(['offline']))
      await click(modeButton('团队'))
      expect(sheet()).toBeNull()
      expect(offline.onChooseWorkspace).toHaveBeenCalledTimes(1)
    })

    it('switching a live team run to independent opens the batch configurator after one confirmation, and creating does not ask again', async () => {
      const { onCreateIndependentSessions } = await render(teamRun('waiting', 'running'))
      await click(modeButton('独立'))
      expect(sheet()?.textContent).toContain('切换到独立模式')
      expect(sheet()?.textContent).toContain('切换会结束当前团队运行')
      await click(buttonNamed('确认切换'))
      expect(sheet()).toBeNull()
      expect(container.textContent).toContain('会话数量')
      expect(container.querySelector('.run-slot.is-open .run-banner')?.textContent).toContain('正在配置独立批次：创建后当前团队运行结束')
      expect(modeButton('独立').getAttribute('aria-checked')).toBe('true')
      // 头部本身不变：状态芯片仍是当前运行的，只有分段控件指向目标模式。
      expect(container.querySelector('.run-header .run-state-chip')?.textContent).toBe('协作执行中')
      expect(container.querySelector('.run-header__eyebrow')?.textContent).toBe('团队运行')

      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      expect(onCreateIndependentSessions.mock.calls[0]?.[0]).toMatchObject({ workspacePath: detected.path })
      expect(onCreateIndependentSessions.mock.calls[0]?.[0].sessions).toHaveLength(3)
    })

    it('creates an independent batch directly over a team run whose agents are all offline', async () => {
      const { onCreateIndependentSessions } = await render(teamRun('offline', 'running'))
      await click(modeButton('独立'))
      expect(sheet()).toBeNull()
      expect(container.textContent).toContain('会话数量')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
    })

    it('"放弃" returns from the configurator to the current run', async () => {
      await render(teamRun('offline', 'running'))
      await click(modeButton('独立'))
      expect(container.textContent).toContain('会话数量')
      await click(buttonNamed('放弃'))
      expect(container.textContent).not.toContain('会话数量')
      expect(modeButton('团队').getAttribute('aria-checked')).toBe('true')
    })
  })

  describe('独立批次：补齐 / 新建 / 换工程', () => {
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
      // 数量接着上一批（2 席）来。
      await click(buttonNamed('创建 2 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
    })

    it('an ended batch starts a new run (never reuses retired session tokens)', async () => {
      const { onCreateIndependentSessions, onLaunchAgentSessions } = await render(independentTeam(['offline'], 'completed'))
      await click(buttonNamed('新建批次'))
      expect(sheet()).toBeNull()
      await click(buttonNamed('创建 1 个独立会话'))
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
      await click(buttonNamed('创建 1 个独立会话'))
      expect(onCreateIndependentSessions).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/projects/b' }))
    })

    it('adjusts the session count within 1–16, by stepper or by typing the number', async () => {
      await render(independentTeam(['offline', 'offline', 'offline'], 'completed'))
      await click(buttonNamed('新建批次'))
      const field = (): HTMLInputElement => container.querySelector<HTMLInputElement>('.run-stepper input')!
      const typeCount = async (value: string): Promise<void> => {
        await act(async () => {
          field().focus()
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
          setter.call(field(), value)
          field().dispatchEvent(new Event('input', { bubbles: true }))
        })
      }
      expect(field().value).toBe('3')
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')!)
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')!)
      expect(field().value).toBe('1')
      expect(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')?.disabled).toBe(true)
      expect(buttonNamed('创建 1 个独立会话')).toBeTruthy()
      expect(container.querySelectorAll('.run-seat')).toHaveLength(1)

      // 直接输入：范围内的数字立即生效，不用点十几次。
      await typeCount('12')
      expect(container.querySelectorAll('.run-seat')).toHaveLength(12)
      expect(buttonNamed('创建 12 个独立会话')).toBeTruthy()
      // 输入过程中的空值不钳回去，离开输入框才回到当前数量。
      await typeCount('')
      expect(field().value).toBe('')
      expect(container.querySelectorAll('.run-seat')).toHaveLength(12)
      await act(async () => field().blur())
      expect(field().value).toBe('12')
      // 越界的输入在离开输入框时钳到边界。
      await typeCount('99')
      await act(async () => field().blur())
      expect(field().value).toBe('16')
      expect(buttonNamed('创建 16 个独立会话')).toBeTruthy()
    })

  })

  describe('会话配置：批次的一项属性，与目标工程、会话数量并列', () => {
    const COMPOSER_FAST = 'Fast · MAX Mode Off · Context 200K · Standard'
    const COMPOSER_SLOW = 'Fast Off · MAX Mode Off · Context 200K · Standard'
    const fable = desktopSnapshot.cursorModels!.find((model) => model.modelId === 'claude-fable-5')!
    const fableSelection = (): CursorModelSelection => ({ modelId: fable.modelId, displayName: fable.displayName, parameters: structuredClone(fable.parameters), maxMode: false })
    /** 给运行中批次的若干席位一份已持久化的模型配置（其余席位沿用 Cursor 当前模型）。 */
    const withSeatModels = (team: TeamControlSnapshot, models: Record<string, CursorModelSelection>): TeamControlSnapshot => {
      for (const member of team.members) {
        const selection = models[member.slot.channelId ?? '']
        if (selection) member.slot.modelSelection = selection
      }
      return team
    }
    const batchRow = (): HTMLElement | null => container.querySelector('.run-batch-config')
    const batchModel = (): string | undefined => container.querySelector('.run-batch-config__value strong > span')?.textContent ?? undefined
    const batchSummary = (): string | undefined => container.querySelector('.run-batch-config__value > small')?.textContent ?? undefined
    const batchNote = (): string | null => container.querySelector('.run-batch-config__note')?.textContent ?? null
    const batchTag = (): string | null => container.querySelector('.run-batch-config__tag')?.textContent ?? null
    const batchAction = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('.run-batch-config__action')!
    const seatSummaries = (): Array<string | null> => [...container.querySelectorAll('.run-seat__model small')].map((node) => node.textContent)
    const overrideChips = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.run-seat__override')]
    const dialogButton = (label: string): HTMLButtonElement => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.cursor-model-dialog button')].find((candidate) => candidate.textContent === label)
      if (!button) throw new Error(`dialog button "${label}" not found`)
      return button
    }

    it('配置批次：一行显示沿用 Cursor 当前模型的统一配置；「修改」一次改全部，之后新增的席位也沿用，创建时逐席位带上', async () => {
      const { onCreateIndependentSessions, onPersistModelSelection } = await render(emptyTeamControlSnapshot(), { startMode: 'independent' })
      // 预览目录里 Cursor 当前选中的是 Composer 2.5 · Fast：批次行标「Cursor 当前」，三席默认沿用；席位区不再有单独的统一入口。
      expect(batchRow()?.textContent).toContain('会话配置')
      expect(batchModel()).toBe('Composer 2.5')
      expect(batchTag()).toBe('Cursor 当前')
      expect(batchSummary()).toBe(COMPOSER_FAST)
      expect(batchAction().textContent).toBe('修改')
      expect(batchAction().getAttribute('aria-label')).toBe('修改全部 3 个席位的会话配置')
      expect(seatSummaries()).toEqual(Array(3).fill(COMPOSER_FAST))
      expect(container.querySelector('.run-seats__unify')).toBeNull()

      await click(batchAction())
      const dialog = document.querySelector('[role="dialog"]')!
      expect(dialog.getAttribute('aria-label')).toBe('全部席位 会话配置')
      expect(dialog.textContent).toContain('全部 3 个席位 · 模型与参数')
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="全部席位 弹层Fast Off"]')!)
      await click(dialogButton('应用到 3 个席位'))
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      // 配置批次阶段席位尚不存在：不落库，只进草稿。
      expect(onPersistModelSelection).not.toHaveBeenCalled()
      // 批次行换装：显式统一后不再标「Cursor 当前」，值块带一次性的换装动画类；每一行泛光晕确认。
      expect(batchTag()).toBeNull()
      expect(batchSummary()).toBe(COMPOSER_SLOW)
      expect(container.querySelector('.run-batch-config__value.is-swapped')).not.toBeNull()
      expect(seatSummaries()).toEqual(Array(3).fill(COMPOSER_SLOW))
      expect(container.querySelectorAll('.run-seat.is-synced')).toHaveLength(3)
      expect(overrideChips()).toHaveLength(0)

      // 统一之后再加两席：新席位沿用统一配置，而不是退回 Cursor 当前模型。
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="增加"]')!)
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="增加"]')!)
      expect(container.querySelectorAll('.run-seat')).toHaveLength(5)
      expect(seatSummaries()).toEqual(Array(5).fill(COMPOSER_SLOW))
      expect(batchAction().getAttribute('aria-label')).toBe('修改全部 5 个席位的会话配置')

      await click(buttonNamed('创建 5 个独立会话'))
      const sessions = onCreateIndependentSessions.mock.calls[0]?.[0].sessions ?? []
      expect(sessions).toHaveLength(5)
      expect(sessions.map((session) => session.modelSelection?.parameters.find((parameter) => parameter.id === 'fast')?.value)).toEqual(Array(5).fill('false'))
    })

    it('配置批次：单独改一席后该席标「单独配置」、批次行注明例外；点 × 恢复为统一配置', async () => {
      const { onPersistModelSelection } = await render(emptyTeamControlSnapshot(), { startMode: 'independent' })
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-2 会话"]')!)
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="CH-2 弹层Fast Off"]')!)
      await click(dialogButton('保存'))
      expect(seatSummaries()).toEqual([COMPOSER_FAST, COMPOSER_SLOW, COMPOSER_FAST])
      const chips = overrideChips()
      expect(chips).toHaveLength(1)
      expect(chips[0]!.closest('.run-seat')?.querySelector('.run-seat__channel')?.textContent).toBe('CH-2')
      expect(chips[0]!.getAttribute('title')).toBe(`恢复为统一配置：Composer 2.5 · ${COMPOSER_FAST}`)
      // 基线没变：仍是 Cursor 当前模型，只是多了一席例外。
      expect(batchTag()).toBe('Cursor 当前')
      expect(batchSummary()).toBe(COMPOSER_FAST)
      expect(batchNote()).toBe('另有 1 席单独配置')

      await click(container.querySelector<HTMLButtonElement>('button[aria-label="恢复 CH-2 为统一配置"]')!)
      expect(overrideChips()).toHaveLength(0)
      expect(batchNote()).toBeNull()
      expect(seatSummaries()).toEqual(Array(3).fill(COMPOSER_FAST))
      expect(onPersistModelSelection).not.toHaveBeenCalled()
    })

    it('运行中的批次：「修改」逐席位落库后才更新行，行内泛光晕，批次行随之换装', async () => {
      const persisted: string[] = []
      const team = independentTeam(['waiting', 'offline', 'offline'])
      await render(team, { onPersistModelSelection: vi.fn(async (channelId: string) => { persisted.push(channelId); return team }) })
      // 运行中的席位本就一致：基线是共同配置，不标「Cursor 当前」。
      expect(batchModel()).toBe('Composer 2.5')
      expect(batchTag()).toBeNull()
      await click(batchAction())
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="全部席位 弹层Fast Off"]')!)
      await click(dialogButton('应用到 3 个席位'))
      expect(persisted).toEqual(['1', '2', '3'])
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(container.querySelectorAll('.run-seat.is-synced')).toHaveLength(3)
      expect(batchSummary()).toBe(COMPOSER_SLOW)
      expect(seatSummaries()).toEqual(Array(3).fill(COMPOSER_SLOW))
    })

    it('运行中的批次：多数席位共用的配置是基线，少数席位标「单独配置」，恢复会把基线写回该席位', async () => {
      const team = withSeatModels(independentTeam(['waiting', 'waiting', 'waiting', 'offline']), { '2': fableSelection() })
      const onPersistModelSelection = vi.fn(async (_channelId: string, _selection: CursorModelSelection) => team)
      await render(team, { onPersistModelSelection })
      expect(batchModel()).toBe('Composer 2.5')
      // 运行中的批次：注脚同时点明例外席位数与「改动作用于下一次新建会话」。
      expect(batchNote()).toBe('另有 1 席单独配置 · 改动作用于下一次新建会话')
      const chips = overrideChips()
      expect(chips).toHaveLength(1)
      expect(chips[0]!.closest('.run-seat')?.querySelector('.run-seat__model strong')?.textContent).toBe('Claude Fable 5')

      await click(container.querySelector<HTMLButtonElement>('button[aria-label="恢复 CH-2 为统一配置"]')!)
      expect(onPersistModelSelection).toHaveBeenCalledTimes(1)
      expect(onPersistModelSelection.mock.calls[0]?.[0]).toBe('2')
      expect(onPersistModelSelection.mock.calls[0]?.[1]).toMatchObject({ modelId: 'composer-2.5' })
      expect(overrideChips()).toHaveLength(0)
      expect(batchNote()).toBe('改动作用于下一次新建会话')
      expect(seatSummaries()).toEqual(Array(4).fill(COMPOSER_FAST))
    })

    it('运行中的批次：恢复落库失败走页面提示条，该席仍标为单独配置', async () => {
      const team = withSeatModels(independentTeam(['waiting', 'waiting', 'waiting']), { '3': fableSelection() })
      await render(team, { onPersistModelSelection: vi.fn(async () => { throw new Error('写入席位配置失败') }) })
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="恢复 CH-3 为统一配置"]')!)
      expect(status()?.className).toContain('is-error')
      expect(status()?.textContent).toContain('写入席位配置失败')
      expect(overrideChips()).toHaveLength(1)
    })

    it('运行中的批次：各席分叉又没有多数时显示分布，动作变成「统一」，没有席位被标成例外', async () => {
      await render(withSeatModels(independentTeam(['waiting', 'waiting', 'waiting', 'waiting']), { '3': fableSelection(), '4': fableSelection() }))
      expect(container.querySelector('.run-batch-config.is-spread')).not.toBeNull()
      expect(batchModel()).toBe('各席配置不同')
      expect(batchSummary()).toBe('2 席 Composer 2.5 · 2 席 Claude Fable 5')
      expect(batchAction().textContent).toBe('统一')
      expect(overrideChips()).toHaveLength(0)
      // 「统一」弹层以第一席的现状起草。
      await click(batchAction())
      expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('全部席位 会话配置')
      expect(document.querySelector('.cursor-model-dialog .menu-select__button')?.textContent).toContain('Composer 2.5')
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="关闭会话配置"]')!)
    })

    it('新批次的会话数量也接着上一批来', async () => {
      const { onCreateIndependentSessions } = await render(independentTeam(['waiting', 'waiting', 'waiting', 'waiting', 'waiting']))
      await click(buttonNamed('结束并新建批次'))
      await click(buttonNamed('确认新建'))
      expect(container.querySelector<HTMLInputElement>('.run-stepper input')?.value).toBe('5')
      await click(buttonNamed('创建 5 个独立会话'))
      expect(onCreateIndependentSessions.mock.calls[0]?.[0].sessions).toHaveLength(5)
    })

    it('从团队切到独立用默认数量：团队席位是角色，不是并行会话', async () => {
      await render(teamRun('waiting', 'running'))
      await click(modeButton('独立'))
      if (sheet()) await click(buttonNamed('确认切换'))
      expect(container.querySelector<HTMLInputElement>('.run-stepper input')?.value).toBe('3')
    })

    it('新批次沿用上一批多数席位的配置，而不是每次都退回 Cursor 当前模型', async () => {
      const previous = withSeatModels(independentTeam(['waiting', 'waiting', 'waiting']), {
        '1': fableSelection(), '2': fableSelection(), '3': fableSelection()
      })
      const { onCreateIndependentSessions } = await render(previous)
      await click(buttonNamed('结束并新建批次'))
      await click(buttonNamed('确认新建'))
      expect(batchModel()).toBe('Claude Fable 5')
      expect(batchTag()).toBe('沿用上次')
      expect(overrideChips()).toHaveLength(0)

      await click(buttonNamed('创建 3 个独立会话'))
      const sessions = onCreateIndependentSessions.mock.calls[0]?.[0].sessions ?? []
      expect(sessions.map((session) => session.modelSelection?.modelId)).toEqual(Array(3).fill('claude-fable-5'))
    })

    it('配置批次：基线跟着多数席位走，不会留下一个谁都没在用的基线', async () => {
      await render(emptyTeamControlSnapshot(), { startMode: 'independent' })
      const step = async (label: '增加' | '减少'): Promise<void> => {
        await click(container.querySelector<HTMLButtonElement>(`.run-stepper button[aria-label="${label}"]`)!)
      }
      // 只留一席并改掉它：这一席就是本批次的配置，不该被标成相对某个幽灵基线的「单独配置」。
      await step('减少')
      await step('减少')
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-1 会话"]')!)
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="CH-1 弹层Fast Off"]')!)
      await click(dialogButton('保存'))
      expect(batchSummary()).toBe(COMPOSER_SLOW)
      expect(batchTag()).toBeNull()
      expect(overrideChips()).toHaveLength(0)

      // 再加一席（沿用 Cursor 当前模型）：两席各不相同又没有多数，显示分布并提供「统一」。
      await step('增加')
      expect(batchModel()).toBe('各席配置不同')
      expect(batchSummary()).toBe('Composer 2.5 · 参数各不相同')
      expect(batchAction().textContent).toBe('统一')
      expect(overrideChips()).toHaveLength(0)
    })

    it('运行中的批次：统一只写与目标不同的席位', async () => {
      const team = withSeatModels(independentTeam(['waiting', 'waiting', 'waiting', 'waiting']), { '2': fableSelection() })
      const persisted: string[] = []
      await render(team, { onPersistModelSelection: vi.fn(async (channelId: string) => { persisted.push(channelId); return team }) })
      // 基线就是另外三席共用的那份：原样应用一次，只有偏离的 CH-2 需要落库。
      await click(batchAction())
      await click(dialogButton('应用到 4 个席位'))
      expect(persisted).toEqual(['2'])
      expect(overrideChips()).toHaveLength(0)
    })

    it('运行中的批次：统一中途失败时弹层留在原地，并说清已经应用了几席', async () => {
      const team = withSeatModels(independentTeam(['waiting', 'waiting', 'waiting', 'waiting']), { '3': fableSelection(), '4': fableSelection() })
      let calls = 0
      await render(team, {
        onPersistModelSelection: vi.fn(async () => {
          calls += 1
          if (calls > 1) throw new Error('写入席位配置失败')
          return team
        })
      })
      expect(batchAction().textContent).toBe('统一')
      await click(batchAction())
      await click(dialogButton('应用到 4 个席位'))
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      expect(document.querySelector('.cursor-model-dialog [role="alert"]')?.textContent)
        .toBe('写入席位配置失败（2 席里已应用 1 席，其余保持原配置）')
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="关闭会话配置"]')!)
    })

    it('已结束的批次与团队运行都没有会话配置行，也不标单独配置', async () => {
      await render(independentTeam(['offline'], 'completed'))
      expect(batchRow()).toBeNull()
      await render(withSeatModels(teamRun('waiting', 'running'), { '2': fableSelection() }))
      expect(batchRow()).toBeNull()
      expect(overrideChips()).toHaveLength(0)
    })
  })

  describe('团队：主按钮由 preflight 决定', () => {
    it('opens the goal editor from the primary action and auto-launches when the saved goal completes preflight', async () => {
      const draft = teamRun('waiting', 'ready')
      draft.activeRun!.goal = ''
      const launched = { ...draft, activeRun: { ...draft.activeRun!, goal: '做一个登录页' }, preflight: { ...draft.preflight, canLaunch: true } }
      const onUpdateGoal = vi.fn(async () => launched)
      const { onLaunch } = await render(draft, { onUpdateGoal })
      await click(buttonNamed('填写团队目标'))
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="团队目标"]')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        setter.call(textarea, '做一个登录页')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await click(buttonNamed('保存目标'))
      expect(onUpdateGoal).toHaveBeenCalledWith('做一个登录页')
      expect(onLaunch).toHaveBeenCalledTimes(1)
      expect(status()?.textContent).toContain('目标已保存，团队启动指令已自动投递')
    })

    it('starts the next round directly once the run has completed', async () => {
      const { onCreateNextRun } = await render(teamRun('offline', 'completed'))
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('本轮已结束')
      // 已结束的运行不再提供会话创建。
      expect(container.querySelector('.run-seats .run-section-head span')?.textContent).toContain('运行已结束')
      expect(buttons().some((button) => button.textContent?.includes('一键创建会话'))).toBe(false)
      await click(buttonNamed('开始新一轮'))
      expect(sheet()).toBeNull()
      expect(onCreateNextRun).toHaveBeenCalledTimes(1)
    })

    it('offers "结束本轮并新建" only when an active run has every agent offline', async () => {
      const { onCreateNextRun } = await render(teamRun('offline', 'running'))
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('全部 Agent 离线')
      await click(buttonNamed('结束本轮并新建'))
      expect(sheet()).toBeNull()
      expect(onCreateNextRun).toHaveBeenCalledTimes(1)
    })

    it('runs the launch pipeline from the primary action when preflight is green', async () => {
      const ready = teamRun('waiting', 'ready')
      ready.preflight = { ...ready.preflight, canLaunch: true, mcpInstalled: true }
      const { onLaunch } = await render(ready)
      await click(buttonNamed('启动团队'))
      expect(onLaunch).toHaveBeenCalledTimes(1)
      expect(status()?.textContent).toContain('启动指令已投递')
    })
  })

  describe('无活跃运行', () => {
    it('offers both modes; team goes straight to the workspace picker', async () => {
      const { onChooseWorkspace } = await render(emptyTeamControlSnapshot())
      expect(container.textContent).toContain('开始一次运行')
      expect(container.textContent).toContain('Cursor 当前打开的工程')
      await click(buttonNamed('选择工程并组建团队'))
      expect(onChooseWorkspace).toHaveBeenCalledTimes(1)
    })

    it('independent start mode shows the batch configurator and creates without any confirmation', async () => {
      const onStartModeChange = vi.fn()
      const { onCreateIndependentSessions } = await render(emptyTeamControlSnapshot(), { startMode: 'independent', onStartModeChange })
      expect(container.textContent).toContain('会话数量')
      expect(container.querySelectorAll('.run-seat')).toHaveLength(3)
      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      await click(modeButton('团队'))
      expect(onStartModeChange).toHaveBeenCalledWith('team')
    })
  })
})
