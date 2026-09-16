import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SeatRotationService, type SeatRotationPorts } from '../src/application/seat-rotation-service'
import { SeatRotationSettingsStore } from '../src/application/seat-rotation-settings-store'
import type { AgentLaunchPlan } from '../src/domain/agent-launch'
import type { AgentSession } from '../src/domain/agent-session'
import {
  DEFAULT_SEAT_ROTATION_SETTINGS,
  SEAT_ROTATION_COOLDOWN_MS,
  SEAT_ROTATION_GLOBAL_SPACING_MS,
  SEAT_ROTATION_IDLE_MS,
  SEAT_ROTATION_QUIET_MS,
  isSeatIdle,
  isSeatRotationNoticeVisible,
  lastConversationActivityAt,
  normalizeSeatRotationSettings,
  seatRotationNoticeLabel,
  seatRotationVerdict,
  type SeatRotationNotice,
  type SeatRotationSeatFacts,
  type SeatRotationSettings
} from '../src/domain/seat-rotation'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { SessionHandoffContext } from '../src/domain/session-handoff'
import { emptyTeamControlSnapshot, type TeamControlSnapshot, type TeamMemberView, type TeamRunStatus } from '../src/domain/team-control'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

const T0 = 1_700_000_000_000

function facts(overrides: Partial<SeatRotationSeatFacts> = {}): SeatRotationSeatFacts {
  return {
    channelId: '1',
    solo: true,
    hasSessionToken: true,
    online: true,
    waiting: true,
    connectionPhase: 'waiting',
    queueDepth: 0,
    composerId: 'composer-old',
    composerBubbleCount: 450,
    streaming: false,
    ...overrides
  }
}

function verdict(overrides: Partial<Parameters<typeof seatRotationVerdict>[0]> = {}) {
  return seatRotationVerdict({
    settings: { ...DEFAULT_SEAT_ROTATION_SETTINGS },
    runStatus: 'running',
    facts: facts(),
    idleSince: T0 - SEAT_ROTATION_IDLE_MS,
    channel: { consecutiveFailures: 0 },
    busy: false,
    now: T0,
    ...overrides
  })
}

describe('seat-rotation · 设置归一化', () => {
  it('默认开、阈值 400；缺字段按默认，只有显式 false 才关', () => {
    expect(normalizeSeatRotationSettings(undefined)).toEqual({ enabled: true, bubbleThreshold: 400 })
    expect(normalizeSeatRotationSettings({})).toEqual({ enabled: true, bubbleThreshold: 400 })
    expect(normalizeSeatRotationSettings({ enabled: false })).toEqual({ enabled: false, bubbleThreshold: 400 })
    expect(normalizeSeatRotationSettings({ enabled: 'yes' })).toEqual({ enabled: true, bubbleThreshold: 400 })
  })

  it('阈值按 50 步进取整并夹在 [100, 2000]', () => {
    expect(normalizeSeatRotationSettings({ bubbleThreshold: 430 }).bubbleThreshold).toBe(450)
    expect(normalizeSeatRotationSettings({ bubbleThreshold: 10 }).bubbleThreshold).toBe(100)
    expect(normalizeSeatRotationSettings({ bubbleThreshold: 99_999 }).bubbleThreshold).toBe(2_000)
    expect(normalizeSeatRotationSettings({ bubbleThreshold: Number.NaN }).bubbleThreshold).toBe(400)
    expect(normalizeSeatRotationSettings({ bubbleThreshold: '500' }).bubbleThreshold).toBe(400)
  })
})

describe('seat-rotation · 空闲判定', () => {
  it('长轮询中、队列空、无待回复、不等用户、正文没在流 = 空闲', () => {
    expect(isSeatIdle(facts())).toBe(true)
  })

  it('keepalive 推理间隙（waiting=false、相位 keepalive）也算空闲，否则 60s 永远凑不齐', () => {
    expect(isSeatIdle(facts({ waiting: false, connectionPhase: 'keepalive' }))).toBe(true)
  })

  it('处理中 / 待同步回复 / 有排队 / 等用户决策 / 正文流式 / 离线 都不算空闲', () => {
    expect(isSeatIdle(facts({ waiting: false, connectionPhase: 'processing' }))).toBe(false)
    expect(isSeatIdle(facts({ waiting: false, connectionPhase: 'need_reply_sync' }))).toBe(false)
    expect(isSeatIdle(facts({ pendingOutboundId: 'out-1' }))).toBe(false)
    expect(isSeatIdle(facts({ queueDepth: 1 }))).toBe(false)
    expect(isSeatIdle(facts({ awaitingUser: true }))).toBe(false)
    expect(isSeatIdle(facts({ streaming: true }))).toBe(false)
    expect(isSeatIdle(facts({ online: false }))).toBe(false)
    // 裸 waiting=false 且相位不在协议内（如 reviving / 空）也不算
    expect(isSeatIdle(facts({ waiting: false, connectionPhase: '' }))).toBe(false)
  })
})

describe('seat-rotation · 决策', () => {
  it('全部条件成立才轮换，返回触发时的气泡数', () => {
    expect(verdict()).toEqual({ rotate: true, bubbleCount: 450 })
  })

  it('逐条拒绝原因', () => {
    expect(verdict({ settings: { enabled: false, bubbleThreshold: 400 } })).toEqual({ rotate: false, reason: 'disabled' })
    for (const status of ['draft', 'ready', 'launching', 'attention', 'paused', 'completed'] as TeamRunStatus[]) {
      expect(verdict({ runStatus: status })).toEqual({ rotate: false, reason: 'run_not_running' })
    }
    expect(verdict({ runStatus: undefined })).toEqual({ rotate: false, reason: 'run_not_running' })
    expect(verdict({ facts: facts({ solo: false }) })).toEqual({ rotate: false, reason: 'not_solo' })
    expect(verdict({ facts: facts({ hasSessionToken: false }) })).toEqual({ rotate: false, reason: 'no_session_token' })
    expect(verdict({ facts: facts({ composerId: undefined }) })).toEqual({ rotate: false, reason: 'no_composer' })
    expect(verdict({ facts: facts({ composerBubbleCount: 399 }) })).toEqual({ rotate: false, reason: 'below_threshold' })
    expect(verdict({ facts: facts({ composerBubbleCount: undefined }) })).toEqual({ rotate: false, reason: 'below_threshold' })
    expect(verdict({ channel: { consecutiveFailures: 2 } })).toEqual({ rotate: false, reason: 'channel_disabled' })
    expect(verdict({ channel: { consecutiveFailures: 0, lastAttemptAt: T0 - SEAT_ROTATION_COOLDOWN_MS + 1 } }))
      .toEqual({ rotate: false, reason: 'cooldown' })
    expect(verdict({ channel: { consecutiveFailures: 1, lastAttemptAt: T0 - SEAT_ROTATION_COOLDOWN_MS } })).toEqual({ rotate: true, bubbleCount: 450 })
    expect(verdict({ facts: facts({ queueDepth: 2 }) })).toEqual({ rotate: false, reason: 'not_idle' })
    expect(verdict({ idleSince: undefined })).toEqual({ rotate: false, reason: 'idle_too_short' })
    expect(verdict({ idleSince: T0 - SEAT_ROTATION_IDLE_MS + 1 })).toEqual({ rotate: false, reason: 'idle_too_short' })
    // 静默守卫：通道 10 分钟内有过消息往来 = 用户还在聊，即便席位待命够久也不换
    expect(verdict({ facts: facts({ lastActivityAt: T0 - SEAT_ROTATION_QUIET_MS + 1 }) })).toEqual({ rotate: false, reason: 'recent_activity' })
    expect(verdict({ facts: facts({ lastActivityAt: T0 - SEAT_ROTATION_QUIET_MS }) })).toEqual({ rotate: true, bubbleCount: 450 })
    // 全局间隔：任何通道刚轮换过，其他通道也要等
    expect(verdict({ lastGlobalAttemptAt: T0 - SEAT_ROTATION_GLOBAL_SPACING_MS + 1 })).toEqual({ rotate: false, reason: 'global_spacing' })
    expect(verdict({ lastGlobalAttemptAt: T0 - SEAT_ROTATION_GLOBAL_SPACING_MS })).toEqual({ rotate: true, bubbleCount: 450 })
    // 连续空闲够了，但此刻正处于 keepalive 间隙：等下一次进入 check_messages 再换
    expect(verdict({ facts: facts({ waiting: false, connectionPhase: 'keepalive' }) })).toEqual({ rotate: false, reason: 'not_in_poll' })
    expect(verdict({ busy: true })).toEqual({ rotate: false, reason: 'busy' })
  })

  it('默认值：连续待命 5 分钟、静默 10 分钟、全局间隔 2 分钟', () => {
    expect(SEAT_ROTATION_IDLE_MS).toBe(5 * 60_000)
    expect(SEAT_ROTATION_QUIET_MS).toBe(10 * 60_000)
    expect(SEAT_ROTATION_GLOBAL_SPACING_MS).toBe(2 * 60_000)
  })

  it('时间线最近活动：取用户消息 / 回复 / 投递时刻的最大值，静默消息不算，空时间线为 undefined', () => {
    const entry = (overrides: Partial<ConversationEntry>): ConversationEntry => ({
      id: 'e', channelId: '1', role: 'user', text: 't', timestamp: 1_000, status: 'complete', source: 'desktop', ...overrides
    })
    expect(lastConversationActivityAt(undefined)).toBeUndefined()
    expect(lastConversationActivityAt([])).toBeUndefined()
    expect(lastConversationActivityAt([entry({ timestamp: 1_000 }), entry({ id: 'r', role: 'assistant', timestamp: 2_500 })])).toBe(2_500)
    // 排队消息晚于入队才投递：以投递时刻为准
    expect(lastConversationActivityAt([entry({ timestamp: 1_000, deliveredAt: 9_000 })])).toBe(9_000)
    // 内部协作通知（静默）不代表用户在聊
    expect(lastConversationActivityAt([entry({ timestamp: 1_000 }), entry({ id: 's', timestamp: 50_000, silent: true })])).toBe(1_000)
  })

  it('阈值等于气泡数即触发；自定义阈值生效', () => {
    expect(verdict({ facts: facts({ composerBubbleCount: 400 }) })).toEqual({ rotate: true, bubbleCount: 400 })
    expect(verdict({ settings: { enabled: true, bubbleThreshold: 1_000 } })).toEqual({ rotate: false, reason: 'below_threshold' })
  })
})

describe('seat-rotation · 名册提示', () => {
  const notice = (status: SeatRotationNotice['status']): SeatRotationNotice => ({ status, bubbleCount: 412, at: T0, message: 'm' })

  it('成功提示只在冷却期内可见；进行中 / 失败 / 已停用一直可见', () => {
    expect(isSeatRotationNoticeVisible(undefined, T0)).toBe(false)
    expect(isSeatRotationNoticeVisible(notice('done'), T0 + SEAT_ROTATION_COOLDOWN_MS - 1)).toBe(true)
    expect(isSeatRotationNoticeVisible(notice('done'), T0 + SEAT_ROTATION_COOLDOWN_MS)).toBe(false)
    expect(isSeatRotationNoticeVisible(notice('rotating'), T0 + SEAT_ROTATION_COOLDOWN_MS * 3)).toBe(true)
    expect(isSeatRotationNoticeVisible(notice('failed'), T0 + SEAT_ROTATION_COOLDOWN_MS * 3)).toBe(true)
    expect(isSeatRotationNoticeVisible(notice('disabled'), T0 + SEAT_ROTATION_COOLDOWN_MS * 3)).toBe(true)
  })

  it('文案', () => {
    expect(seatRotationNoticeLabel(notice('rotating'))).toBe('自动轮换中')
    expect(seatRotationNoticeLabel(notice('done'))).toBe('已自动轮换 · 412 气泡')
    expect(seatRotationNoticeLabel(notice('partial'))).toBe('已轮换 · 未交接上下文')
    expect(seatRotationNoticeLabel(notice('failed'))).toBe('自动轮换失败')
    expect(seatRotationNoticeLabel(notice('disabled'))).toBe('自动轮换已停用')
    // 未交接上下文要一直提醒到被替换 / run 结束（新会话缺上一段的上下文）
    expect(isSeatRotationNoticeVisible(notice('partial'), T0 + SEAT_ROTATION_COOLDOWN_MS * 3)).toBe(true)
  })
})

describe('SeatRotationSettingsStore', () => {
  it('缺文件按默认；保存归一化后原子写回；坏文件按默认', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-seat-rotation-')), 'seat-rotation.json')
    const store = new SeatRotationSettingsStore(path)
    expect(store.load()).toEqual({ enabled: true, bubbleThreshold: 400 })
    expect(store.save({ enabled: false, bubbleThreshold: 730 })).toEqual({ enabled: false, bubbleThreshold: 750 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, settings: { enabled: false, bubbleThreshold: 750 } })
    expect(store.load()).toEqual({ enabled: false, bubbleThreshold: 750 })
    writeFileSync(path, '{ not json', 'utf8')
    expect(store.load()).toEqual({ enabled: true, bubbleThreshold: 400 })
  })
})

// ---------------------------------------------------------------------------
// 服务编排

function session(channelId: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `sg-channel:${channelId}`,
    channelId,
    generation: 0,
    displayName: `独立席 ${channelId}`,
    roleName: '独立席',
    roleTemplateKey: 'solo',
    status: 'waiting',
    currentTask: '',
    queueDepth: 0,
    connectionPhase: 'waiting',
    online: true,
    connected: true,
    waiting: true,
    composerId: 'composer-old',
    composerBubbleCount: 450,
    workingFiles: [],
    healthEvidence: [],
    ...overrides
  }
}

function member(channelId: string, solo: boolean): TeamMemberView {
  return {
    slot: { id: `slot-${channelId}`, runId: 'run-1', roleId: 'role', name: `独立席 ${channelId}`, avatarId: 'a', channelId, solo, order: 0, createdAt: 1, updatedAt: 1 },
    role: { id: 'role', runId: 'run-1', key: 'solo', templateKey: 'solo', name: '独立执行', mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0 },
    binding: {
      id: `b-${channelId}`, workspaceId: 'ws', runId: 'run-1', slotId: `slot-${channelId}`, channelId, agentSessionId: `a-${channelId}`, generation: 'g',
      installedAt: 1, launchDetail: '', acknowledgedAt: 1, lastCheckInNote: '', composerBindingKey: 'k', composerId: 'composer-old', sessionToken: `token-${channelId}`
    },
    readiness: 'active'
  }
}

interface Harness {
  service: SeatRotationService
  state: {
    now: number
    sessions: AgentSession[]
    streaming: Set<string>
    runStatus: TeamRunStatus | undefined
    runId: string
    tokens: Map<string, string>
    settings: SeatRotationSettings
    relaunchKey: string | undefined
    launchPlan: (channelId: string) => AgentLaunchPlan
    launchRunning: boolean
    deliverError?: string
    contextError?: string
    transcriptMissing?: boolean
    /** 通道时间线（静默守卫的事实源）；缺省为空。 */
    conversations: Map<string, ConversationEntry[]>
  }
  calls: {
    relaunch: Array<{ channelId: string; options: { allowIdleOnline?: boolean } }>
    deliver: Array<{ channelId: string; target: string; note?: string; holdSessionToken?: string; composerId?: string }>
    launch: string[][]
    launchOrigins: Array<AgentLaunchPlan['origin']>
    notices: Array<{ channelId: string; notice: SeatRotationNotice | undefined }>
    errors: unknown[]
    /** 每次评估读一次设置：用它数评估次数。 */
    settingsReads: number
  }
  snapshot(): DesktopSnapshot
  evaluate(): void
  /** 模拟 DesktopSessionService 推送一帧快照给订阅者。 */
  push(): void
  flush(): Promise<void>
}

function harness(options: { members?: TeamMemberView[] } = {}): Harness {
  const state: Harness['state'] = {
    now: T0,
    sessions: [session('1')],
    streaming: new Set(),
    runStatus: 'running',
    runId: 'run-1',
    tokens: new Map([['1', 'token-1']]),
    settings: { ...DEFAULT_SEAT_ROTATION_SETTINGS },
    relaunchKey: 'new-binding-key',
    launchPlan: (channelId) => ({
      id: 'plan', state: 'done', startedAt: state.now, finishedAt: state.now,
      items: [{ channelId, stage: 'done', message: '会话已就绪', composerId: 'composer-new' }]
    }),
    launchRunning: false,
    conversations: new Map()
  }
  const calls: Harness['calls'] = { relaunch: [], deliver: [], launch: [], launchOrigins: [], notices: [], errors: [], settingsReads: 0 }
  const listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  const snapshot = (): DesktopSnapshot => ({
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: state.sessions,
    conversations: {},
    protocolIssues: [],
    liveAgentResponses: Object.fromEntries([...state.streaming].map((channelId) => [
      channelId, { id: `live-${channelId}`, channelId, text: '…', status: 'streaming' as const, startedAt: state.now, updatedAt: state.now }
    ])),
    updatedAt: state.now
  })
  const teamSnapshot = (): TeamControlSnapshot => {
    const run = {
      id: state.runId, workspaceId: 'ws', name: '独立会话', goal: '', templateId: 'independent-session-v1',
      status: state.runStatus ?? 'completed', createdAt: 1, updatedAt: 1
    }
    const members = options.members ?? [member('1', true)]
    return {
      ...emptyTeamControlSnapshot(),
      activeWorkspaceId: 'ws',
      runs: [run],
      activeRun: state.runStatus ? run : undefined,
      members,
      // 绑定的会话令牌与 currentSessionToken 同源（state.tokens），run 归属跟随当前 run
      bindings: members.flatMap((candidate) => candidate.binding
        ? [{ ...candidate.binding, runId: state.runId, sessionToken: state.tokens.get(candidate.binding.channelId) }]
        : [])
    }
  }
  const ports: SeatRotationPorts = {
    sessions: {
      getSnapshot: snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      currentSessionToken: (channelId) => state.tokens.get(channelId),
      noteSeatRotation: (channelId, notice) => calls.notices.push({ channelId, notice })
    },
    team: {
      getSnapshot: teamSnapshot,
      prepareComposerRelaunch: (channelId, opts) => {
        calls.relaunch.push({ channelId, options: opts })
        if (!state.relaunchKey) return undefined
        // 轮换后：令牌换新、绑定的 composer 清空（与仓储层行为一致）
        state.tokens.set(channelId, `token-${channelId}-rotated`)
        state.sessions = state.sessions.map((candidate) => (
          candidate.channelId === channelId ? { ...candidate, composerId: undefined, composerBubbleCount: undefined } : candidate
        ))
        return state.relaunchKey
      }
    },
    handoff: {
      context: (channelId): SessionHandoffContext => {
        if (state.contextError) throw new Error(state.contextError)
        return {
          channelId,
          displayName: `独立席 ${channelId}`,
          composerId: 'composer-old',
          transcript: state.transcriptMissing ? undefined : { path: `/tmp/composer-old.jsonl`, exists: true, resolution: 'workspace' },
          holdSupported: true,
          userMessageCount: 3,
          assistantMessageCount: 3
        }
      },
      deliverFrom: (source, target, note, opts) => {
        calls.deliver.push({
          channelId: source.channelId, target: target.kind, note, holdSessionToken: opts?.holdSessionToken, composerId: source.composerId
        })
        if (state.deliverError) throw new Error(state.deliverError)
        return { targetChannelId: source.channelId, held: true, transcriptPath: '/tmp/composer-old.jsonl', commandId: 'cmd', issuedAt: state.now }
      }
    },
    launcher: {
      launch: async (requests, onProgress, options) => {
        calls.launch.push(requests)
        calls.launchOrigins.push(options?.origin)
        const plan = state.launchPlan(requests[0]!)
        onProgress?.(plan)
        return plan
      },
      getPlan: () => state.launchRunning
        ? { id: 'manual', state: 'running', startedAt: state.now, items: [{ channelId: '9', stage: 'trigger', message: '' }] }
        : undefined
    },
    conversationsOf: (channelId) => state.conversations.get(channelId),
    settings: () => { calls.settingsReads += 1; return state.settings },
    now: () => state.now,
    onerror: (error) => calls.errors.push(error),
    tickMs: 60 * 60_000
  }
  const service = new SeatRotationService(ports)
  return {
    service,
    state,
    calls,
    snapshot,
    evaluate: () => service.evaluate(snapshot()),
    push: () => { for (const listener of listeners) listener(snapshot()) },
    flush: () => new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('SeatRotationService', () => {
  it('连续待命满 60s 后按顺序轮换：解析上下文 → 轮换令牌 → 旧令牌保持位交接 → 一键建会话 → 已轮换', async () => {
    const h = harness()
    h.evaluate()
    expect(h.calls.relaunch).toHaveLength(0)
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS - 1
    h.evaluate()
    expect(h.calls.relaunch).toHaveLength(0)
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    expect(h.service.rotatingChannelId()).toBe('1')
    await h.flush()
    expect(h.calls.relaunch).toEqual([{ channelId: '1', options: { allowIdleOnline: true } }])
    // 上下文在令牌轮换前解析（轮换后绑定的 composer 已清空）；保持位用的是旧令牌
    expect(h.calls.deliver).toEqual([{
      channelId: '1', target: 'self', note: expect.stringContaining('自动轮换：上一段会话已累计 450 个气泡'),
      holdSessionToken: 'token-1', composerId: 'composer-old'
    }])
    expect(h.calls.launch).toEqual([['1']])
    // 标记来源：装配层据此不触发「会话创建后自动处理账号」（奥仔 / 加固 / 换号）
    expect(h.calls.launchOrigins).toEqual(['seat-rotation'])
    expect(h.calls.notices.map((entry) => entry.notice?.status)).toEqual(['rotating', 'done'])
    expect(h.calls.notices.at(-1)?.notice).toMatchObject({ status: 'done', bubbleCount: 450, at: T0 + SEAT_ROTATION_IDLE_MS })
    expect(h.service.rotatingChannelId()).toBeUndefined()
  })

  it('冷却期内不再轮换；同一时刻只轮换一个席位；launcher 有手动任务时不触发', async () => {
    const h = harness({ members: [member('1', true), member('2', true)] })
    h.state.sessions = [session('1'), session('2')]
    h.state.tokens.set('2', 'token-2')
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.state.launchRunning = true
    h.evaluate()
    expect(h.calls.relaunch).toHaveLength(0)
    h.state.launchRunning = false
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch.map((call) => call.channelId)).toEqual(['1'])
    // CH-1 刚轮换完，CH-2 条件齐备，但全局间隔未到：不连发
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch.map((call) => call.channelId)).toEqual(['1'])
    h.state.now += SEAT_ROTATION_GLOBAL_SPACING_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch.map((call) => call.channelId)).toEqual(['1', '2'])
    // 两个都在冷却期内：即便 bubbleCount 依旧超阈值、待命也够久，也不再触发
    h.state.sessions = [session('1', { composerId: 'composer-new', composerBubbleCount: 900 }), session('2', { composerId: 'composer-new-2', composerBubbleCount: 900 })]
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS + SEAT_ROTATION_COOLDOWN_MS - 1
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(2)
    // CH-1 冷却结束（CH-2 还差 2 分钟）→ 只有 CH-1 再次轮换
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS + SEAT_ROTATION_COOLDOWN_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch.map((call) => call.channelId)).toEqual(['1', '2', '1'])
  })

  it('静默守卫：通道 10 分钟内有过消息往来就不轮换（用户正在这个通道上聊），静默满 10 分钟才换', async () => {
    const h = harness()
    const entry = (id: string, role: ConversationEntry['role'], timestamp: number): ConversationEntry => ({
      id, channelId: '1', role, text: 't', timestamp, status: 'complete', source: role === 'user' ? 'desktop' : 'cursor'
    })
    // 用户 T0 发消息、T0+20s 收到回复；席位随即待命
    h.state.conversations.set('1', [entry('u1', 'user', T0), entry('a1', 'assistant', T0 + 20_000)])
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS + 60_000
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(0)
    h.state.now = T0 + 20_000 + SEAT_ROTATION_QUIET_MS - 1
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(0)
    h.state.now = T0 + 20_000 + SEAT_ROTATION_QUIET_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(1)
  })

  it('换了 Composer 后从零计时：新会话刚待命不会立刻被再次轮换', async () => {
    const h = harness()
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(1)
    // 冷却期过后新 Composer 也超阈值，但待命计时刚从它绑定那一刻重新开始
    h.state.now += SEAT_ROTATION_COOLDOWN_MS
    h.state.sessions = [session('1', { composerId: 'composer-new', composerBubbleCount: 500 })]
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(1)
    h.state.now += SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(2)
  })

  it('席位在决策与轮换之间开始干活（prepareComposerRelaunch 拒绝）：放弃本次，不投递、不建会话、不计失败，重新计时', async () => {
    const h = harness()
    h.state.relaunchKey = undefined
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(1)
    expect(h.calls.deliver).toHaveLength(0)
    expect(h.calls.launch).toHaveLength(0)
    expect(h.calls.notices).toHaveLength(0)
    expect(h.service.rotatingChannelId()).toBeUndefined()
    // 待命计时已重置：紧接着评估不会再试，要再等满 60s
    h.state.relaunchKey = 'k2'
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(1)
    h.state.now += SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(2)
  })

  it('找不到上下文文档 / 没有令牌：不轮换令牌，记一次失败', async () => {
    const h = harness()
    h.state.transcriptMissing = true
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(0)
    expect(h.calls.launch).toHaveLength(0)
    expect(h.calls.notices.at(-1)?.notice).toMatchObject({ status: 'failed', message: expect.stringContaining('找不到上下文文档') })
  })

  it('交接投递失败不回滚令牌：仍然建新会话，结论为 partial（未交接上下文）并一直提醒', async () => {
    const h = harness()
    h.state.deliverError = '队列写入失败'
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.launch).toEqual([['1']])
    expect(h.calls.errors).toHaveLength(1)
    expect(h.calls.notices.at(-1)?.notice).toMatchObject({
      status: 'partial',
      message: expect.stringContaining('上下文交接消息没有投出去：队列写入失败')
    })
  })

  it('建会话失败时的说明如实区分交接消息是否已在队列中', async () => {
    const h = harness()
    h.state.launchPlan = (channelId) => ({
      id: 'plan', state: 'failed', startedAt: h.state.now, finishedAt: h.state.now,
      items: [{ channelId, stage: 'failed', message: '超时' }]
    })
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.notices.at(-1)?.notice?.message).toContain('上下文交接消息已在队列中等待新会话')

    const g = harness()
    g.state.deliverError = '队列写入失败'
    g.state.launchPlan = h.state.launchPlan
    g.evaluate()
    g.state.now = T0 + SEAT_ROTATION_IDLE_MS
    g.evaluate()
    await g.flush()
    expect(g.calls.notices.at(-1)?.notice?.message).toContain('上下文交接消息也未投出去：队列写入失败')
    expect(g.calls.notices.at(-1)?.notice?.message).not.toContain('已在队列中')
  })

  it('设置关闭时撤下名册上已结束的轮换提示；重新开启解除冷却 / 停用', async () => {
    const h = harness()
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.notices.at(-1)?.notice?.status).toBe('done')
    h.state.settings = { enabled: false, bubbleThreshold: 400 }
    h.service.refreshSettings()
    expect(h.calls.notices.at(-1)).toEqual({ channelId: '1', notice: undefined })
    // 关闭期间只跟踪待命计时，不轮换
    h.state.sessions = [session('1', { composerId: 'composer-new', composerBubbleCount: 900 })]
    h.state.now += SEAT_ROTATION_COOLDOWN_MS
    h.service.refreshSettings()
    h.state.now += SEAT_ROTATION_IDLE_MS
    h.service.refreshSettings()
    await h.flush()
    expect(h.calls.launch).toHaveLength(1)
    // 重新开启：冷却已清，待命计时（同一 composer 持续空闲）满足 → 立刻轮换
    h.state.settings = { enabled: true, bubbleThreshold: 400 }
    h.service.refreshSettings()
    await h.flush()
    expect(h.calls.launch).toHaveLength(2)
  })

  it('建会话失败记一次失败并进入冷却；连续两次失败后停用该通道，重新开启设置后恢复', async () => {
    const h = harness()
    h.state.launchPlan = (channelId) => ({
      id: 'plan', state: 'failed', startedAt: h.state.now, finishedAt: h.state.now,
      items: [{ channelId, stage: 'failed', message: 'Cursor 调试端口未就绪', code: 'cdp_unavailable' }]
    })
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.notices.at(-1)?.notice).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('自动轮换失败：Cursor 调试端口未就绪')
    })
    // 失败后旧会话已退出（fake 里 composer 清空）；用户手动重建后又到阈值 → 冷却期过后第二次尝试
    h.state.sessions = [session('1', { composerId: 'composer-manual', composerBubbleCount: 460 })]
    h.state.now += SEAT_ROTATION_COOLDOWN_MS
    h.evaluate()
    h.state.now += SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.launch).toHaveLength(2)
    expect(h.calls.notices.at(-1)?.notice).toMatchObject({
      status: 'disabled',
      message: expect.stringContaining('连续 2 次失败，该通道的自动轮换已停用')
    })
    // 停用后即便再满足条件也不动
    h.state.sessions = [session('1', { composerId: 'composer-manual-2', composerBubbleCount: 470 })]
    h.state.now += SEAT_ROTATION_COOLDOWN_MS
    h.evaluate()
    h.state.now += SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.launch).toHaveLength(2)
    // 关掉再开：清除停用与名册提示，立刻按新状态评估
    h.state.settings = { enabled: false, bubbleThreshold: 400 }
    h.service.refreshSettings()
    h.state.settings = { enabled: true, bubbleThreshold: 400 }
    h.state.launchPlan = (channelId) => ({
      id: 'plan', state: 'done', startedAt: h.state.now, finishedAt: h.state.now,
      items: [{ channelId, stage: 'done', message: '会话已就绪' }]
    })
    h.service.refreshSettings()
    await h.flush()
    // 先撤下名册上的「已停用」提示，再因待命计时未被打断（同一个 composer 持续空闲）立刻轮换成功
    const cleared = h.calls.notices.findIndex((entry) => entry.notice === undefined)
    expect(cleared).toBeGreaterThan(0)
    expect(h.calls.notices.slice(cleared + 1).filter((entry) => entry.notice).map((entry) => entry.notice?.status)).toEqual(['rotating', 'done'])
    expect(h.calls.launch).toHaveLength(3)
  })

  it('团队席位 / 无 solo 标记的席位不轮换；run 不在 running 不轮换；正文流式中不算空闲', async () => {
    const h = harness({ members: [member('1', false)] })
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(0)

    const g = harness()
    g.state.runStatus = 'completed'
    g.evaluate()
    g.state.now = T0 + SEAT_ROTATION_IDLE_MS
    g.evaluate()
    await g.flush()
    expect(g.calls.relaunch).toHaveLength(0)

    const s = harness()
    s.evaluate()
    s.state.streaming.add('1')
    s.state.now = T0 + SEAT_ROTATION_IDLE_MS / 2
    s.evaluate()
    s.state.streaming.delete('1')
    s.state.now = T0 + SEAT_ROTATION_IDLE_MS
    s.evaluate()
    await s.flush()
    // 流式期间空闲计时被打断，从流式结束（T0+60s）重新开始
    expect(s.calls.relaunch).toHaveLength(0)
    s.state.now = T0 + SEAT_ROTATION_IDLE_MS * 2 - 1
    s.evaluate()
    await s.flush()
    expect(s.calls.relaunch).toHaveLength(0)
    s.state.now = T0 + SEAT_ROTATION_IDLE_MS * 2
    s.evaluate()
    await s.flush()
    expect(s.calls.relaunch).toHaveLength(1)
  })

  it('keepalive 间隙计入连续待命，但只在 check_messages 调用栈内触发', async () => {
    const h = harness()
    h.evaluate()
    h.state.sessions = [session('1', { waiting: false, connectionPhase: 'keepalive' })]
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(0)
    h.state.sessions = [session('1')]
    h.state.now += 1_000
    h.evaluate()
    await h.flush()
    expect(h.calls.relaunch).toHaveLength(1)
  })

  it('run 切换清空待命计时与冷却 / 停用记录', async () => {
    const h = harness()
    h.evaluate()
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    expect(h.calls.launch).toHaveLength(1)
    h.state.runId = 'run-2'
    h.state.sessions = [session('1', { composerId: 'composer-run2', composerBubbleCount: 500 })]
    h.evaluate()
    await h.flush()
    expect(h.calls.launch).toHaveLength(1)
    h.state.now += SEAT_ROTATION_IDLE_MS
    h.evaluate()
    await h.flush()
    // 新 run 里不受上一 run 冷却期影响
    expect(h.calls.launch).toHaveLength(2)
  })

  it('start() 订阅快照推送并做首次评估，推送按最小间隔节流（流式期 ~10Hz 不能跟着帧率取团队快照）；stop() 后不再评估', async () => {
    const h = harness()
    h.service.start()
    expect(h.calls.settingsReads).toBe(1)
    // 同一秒内连推多帧只评估一次
    for (let i = 0; i < 10; i += 1) {
      h.state.now += 50
      h.push()
    }
    expect(h.calls.settingsReads).toBe(1)
    h.state.now = T0 + 1_000
    h.push()
    expect(h.calls.settingsReads).toBe(2)
    // 首次评估在 T0 记下待命起点；60s 后的推送触发轮换
    h.state.now = T0 + SEAT_ROTATION_IDLE_MS
    h.push()
    await h.flush()
    expect(h.calls.launch).toHaveLength(1)
    h.service.stop()
    h.state.now += SEAT_ROTATION_COOLDOWN_MS + SEAT_ROTATION_IDLE_MS
    h.state.sessions = [session('1', { composerId: 'composer-new', composerBubbleCount: 900 })]
    h.service.refreshSettings()
    await h.flush()
    expect(h.calls.launch).toHaveLength(1)
  })
})
