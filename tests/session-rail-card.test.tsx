import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { LiveProcessState } from '../src/shared/desktop-api'
import { SessionRailCard } from '../src/renderer/src/SessionRailCard'

const session: AgentSession = {
  id: 'session-1',
  channelId: '1',
  generation: 1,
  displayName: '主控协调 · CH-1',
  roleName: '主控席',
  status: 'offline',
  currentTask: '',
  queueDepth: 2,
  connectionPhase: 'waiting',
  online: false,
  connected: false,
  waiting: false,
  deliveryMode: 'queued',
  workingFiles: [],
  healthEvidence: []
}

const NOW = Date.parse('2026-09-07T10:00:00+08:00')

describe('SessionRailCard（名册行）', () => {
  it('状态行常驻在卡片末行（Cursor 副标题同款）：生成中转圈 + 动词 · 对象；离线灰化为 Completed / Stopped，不撤下', () => {
    const liveProcess: LiveProcessState = { turn: 't', startedAt: NOW, updatedAt: NOW, generating: true, blocks: [
      { kind: 'tool', id: 'read', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', status: 'running',
        summary: `src/renderer/src/${'very-long-file-name-'.repeat(12)}.ts` }
    ] }
    const html = renderToStaticMarkup(<SessionRailCard session={{ ...session, online: true, status: 'running' }}
      liveProcess={liveProcess} selected onOpen={() => {}} draggable now={NOW} />)
    expect(html).toContain('session-row__activity is-read is-live')
    expect(html).toContain('session-row__activity-spinner')
    expect(html).not.toContain('session-row__activity-glyph')
    expect(html.indexOf('class="session-row__name"')).toBeLessThan(html.indexOf('class="session-row__activity is-read is-live"'))
    expect(html.indexOf('class="session-row__activity is-read is-live"')).toBeGreaterThan(html.indexOf('session-row__metrics'))
    expect(html).toContain('<strong>Reading</strong>')
    expect(html).toContain('session-row__activity-separator')
    expect(html).toContain(`${'very-long-file-name-'.repeat(12)}.ts`)
    expect(html).not.toContain('session-row__activity-icon')
    expect(html.match(/<button\b/g)).toHaveLength(1)
    expect(html).toContain('draggable="true"')
    // 离线：常驻但灰化，静态字形代替转圈；有终止证据说 Stopped，否则 Completed。
    const offline = renderToStaticMarkup(<SessionRailCard session={session} liveProcess={liveProcess} selected={false} onOpen={() => {}} />)
    expect(offline).toContain('session-row__activity is-other is-muted')
    expect(offline).toContain('<strong>Completed</strong>')
    expect(offline).toContain('session-row__activity-glyph')
    expect(offline).not.toContain('session-row__activity-spinner')
    expect(offline).not.toContain('Reading')
    const stopped = renderToStaticMarkup(<SessionRailCard session={{ ...session, status: 'stopped' }} selected={false} onOpen={() => {}} />)
    expect(stopped).toContain('<strong>Stopped</strong>')
    // 待命席位由 Cursor 侧事实给出 Thinking（探针实证：check_messages 被跳过、扫到轮询前的思考）。
    const standby = renderToStaticMarkup(<SessionRailCard session={{ ...session, online: true, status: 'waiting', waiting: true }}
      statusLine={{ composerId: 'c1', generating: true, composerStatus: 'generating', statusLine: { kind: 'thinking', label: 'Thinking' }, updatedAt: NOW }}
      selected={false} onOpen={() => {}} />)
    expect(standby).toContain('session-row__activity is-thinking is-live')
    expect(standby).toContain('<strong>Thinking</strong>')
  })
  it('离线行：灰色空心状态点、「已离线」、最近活性时间、排队徽记；上下文未知时只画光环轨道', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{ ...session, lastSeenAt: NOW - 42 * 60_000 }}
        selected={false}
        onOpen={() => {}}
        now={NOW}
      />
    )

    expect(html).toContain('session-row is-offline')
    expect(html).toContain('已离线')
    expect(html).toContain('排队 2')
    expect(html).not.toContain('42 分钟前')
    expect(html).toContain('开始 —')
    expect(html).toContain('结束 —')
    expect(html).toContain('session-row__ring-track')
    expect(html).not.toContain('session-row__ring-arc')
    expect(html).not.toContain('session-row__context')
    expect(html).toContain('上下文用量待读取')
    // 角色名与通道号拆成两段：名可截断、号用等宽数字。
    expect(html).toMatch(/<strong class="session-row__name">主控协调<\/strong><small class="session-row__channel">CH-1<\/small>/)
    expect(html).not.toContain('主控席 · CH-1')
  })

  it('保留上下文光环和悬停详情，移除重复百分比，保留实时增删', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          status: 'running',
          online: true,
          connected: true,
          connectionPhase: 'processing',
          contextUsage: { ratio: 0.72 },
          changes: { additions: 75, deletions: 17, files: 4 }
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('session-row is-active')
    expect(html).toContain('运行中')
    expect(html).toContain('session-row__ring is-afternoon')
    expect(html).toContain('stroke-dasharray="72 100"')
    expect(html).not.toContain('session-row__context')
    expect(html).not.toContain('>72%<')
    expect(html).toContain('上下文 72%')
    expect(html).toContain('session-row__changes')
    expect(html).toContain('+75')
    expect(html).toContain('−17')
    // 在线行不显示「N 分钟前」。
    expect(html).not.toContain('session-row__seen')
  })

  it('uses the recorded disconnect time as the end time, not the current clock', () => {
    const html = renderToStaticMarkup(<SessionRailCard session={{ ...session, startedAt: NOW - 60_000,
      disconnectedAt: NOW, lastSeenAt: NOW }} selected={false} onOpen={() => {}} now={NOW} />)
    expect(html).toContain('开始 09:59')
    expect(html).toContain('结束 10:00')
    expect(html).not.toContain('结束待确认')
  })

  it('does not show the stale disconnect time after reconnecting', () => {
    const html = renderToStaticMarkup(<SessionRailCard session={{ ...session, online: true,
      connected: true, status: 'waiting', disconnectedAt: NOW }} selected={false} onOpen={() => {}} now={NOW} />)
    expect(html).toContain('进行中')
    expect(html).not.toContain('结束 10:00')
  })

  it.each([[0.327, 'clear'], [0.6, 'afternoon'], [0.85, 'dusk']] as const)(
    'preserves context phase at ratio %s even when offline', (ratio, tone) => {
      const html = renderToStaticMarkup(<SessionRailCard session={{ ...session, contextUsage: { ratio } }}
        selected={false} onOpen={() => {}} />)
      expect(html).toContain('session-row is-offline')
      expect(html).toContain(`session-row__ring is-${tone}`)
      expect(html).toContain('session-row__ring-arc')
    }
  )

  it('模型只做身份：厂商色块 + 中性文字，选中态用 aria-current 表达', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{ ...session, modelName: 'Kimi K3', status: 'waiting', online: true, connected: true, waiting: true }}
        selected
        onOpen={() => {}}
      />
    )
    expect(html).toContain('session-row is-waiting is-selected')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('待命中')
    expect(html).toContain('session-row__model provider-moonshot')
    expect(html).toContain('Kimi K3')
    expect(html).toContain('Moonshot AI')
  })

  it('主控王冠来自有效主控状态而非静态角色模板；aria-label 汇总名 / 状态 / 上下文 / 排队', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          channelId: '2',
          displayName: '后端实现（临时主控） · CH-2',
          roleName: '后端席 · 临时主控',
          roleTemplateKey: 'backend',
          isEffectiveLead: true,
          online: true,
          connected: true,
          status: 'blocked',
          connectionPhase: 'approval',
          contextUsage: { ratio: 0.58 },
          queueDepth: 1
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('后端实现（临时主控）')
    expect(html).toContain('aria-label="主控"')
    expect(html).toContain('session-row is-attention')
    expect(html).toContain('等待拍板')
    // 状态行常驻：没有任何 Cursor 侧事实的在岗席位读作 Planning next moves，并进入 aria-label。
    expect(html).toContain('aria-label="后端实现（临时主控） CH-2，等待拍板，Planning next moves，上下文 58%，排队 1"')
  })

  it('侧栏行不重复渲染 token / 费用；用量只放在工作台顶部', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          usage: {
            composerId: 'comp-1',
            turns: 3,
            inputTokens: 12_168,
            outputTokens: 42,
            cacheReadTokens: 3_968,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0.0421,
            pricedModel: 'Claude Sonnet',
            lastTurnAt: 1_000
          }
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(html).not.toContain('session-usage')
    expect(html).not.toContain('12.2K')
  })

  it('可拖拽时在提示里说明；单独一行的组不可拖拽', () => {
    const draggable = renderToStaticMarkup(<SessionRailCard session={session} selected={false} onOpen={() => {}} draggable />)
    expect(draggable).toContain('draggable="true"')
    expect(draggable).toContain('拖动可调整同组内的顺序')
    const fixed = renderToStaticMarkup(<SessionRailCard session={session} selected={false} onOpen={() => {}} />)
    expect(fixed).toContain('draggable="false"')
    expect(fixed).not.toContain('拖动可调整')
  })

  it('席位自动轮换提示：与排队徽记同列；成功提示只在冷却期内显示，失败 / 停用一直显示；气泡数进悬停详情', () => {
    const online = { ...session, online: true, status: 'waiting' as const, waiting: true, queueDepth: 0, composerBubbleCount: 412 }
    const done = renderToStaticMarkup(<SessionRailCard
      session={{ ...online, seatRotation: { status: 'done', bubbleCount: 412, at: NOW - 60_000, message: '已自动轮换：上一段会话累计 412 个气泡' } }}
      selected={false} onOpen={() => {}} now={NOW} />)
    expect(done).toContain('session-row__rotation is-done')
    expect(done).toContain('已自动轮换 · 412 气泡')
    expect(done).toContain('title="已自动轮换：上一段会话累计 412 个气泡"')
    expect(done).toContain('会话体积 412 气泡')
    // 冷却期（10 分钟）过后成功提示撤下，气泡数仍在悬停详情里
    const expired = renderToStaticMarkup(<SessionRailCard
      session={{ ...online, seatRotation: { status: 'done', bubbleCount: 412, at: NOW - 11 * 60_000, message: 'm' } }}
      selected={false} onOpen={() => {}} now={NOW} />)
    expect(expired).not.toContain('session-row__rotation')
    expect(expired).toContain('会话体积 412 气泡')
    const failed = renderToStaticMarkup(<SessionRailCard
      session={{ ...online, seatRotation: { status: 'failed', bubbleCount: 412, at: NOW - 3 * 3_600_000, message: '自动轮换失败：Cursor 调试端口未就绪' } }}
      selected={false} onOpen={() => {}} now={NOW} />)
    expect(failed).toContain('session-row__rotation is-failed')
    expect(failed).toContain('自动轮换失败</span>')
    const disabled = renderToStaticMarkup(<SessionRailCard
      session={{ ...online, seatRotation: { status: 'disabled', bubbleCount: 412, at: NOW - 3 * 3_600_000, message: 'm' } }}
      selected={false} onOpen={() => {}} now={NOW} />)
    expect(disabled).toContain('session-row__rotation is-disabled')
    expect(disabled).toContain('自动轮换已停用')
    const rotating = renderToStaticMarkup(<SessionRailCard
      session={{ ...online, seatRotation: { status: 'rotating', bubbleCount: 412, at: NOW, message: 'm' } }}
      selected={false} onOpen={() => {}} now={NOW} />)
    expect(rotating).toContain('session-row__rotation is-rotating')
    expect(rotating).toContain('自动轮换中')
    // 新会话就绪但交接消息没投出去：橙色警示，且不随冷却期消失
    const partial = renderToStaticMarkup(<SessionRailCard
      session={{ ...online, seatRotation: { status: 'partial', bubbleCount: 412, at: NOW - 3 * 3_600_000, message: '上下文交接消息没有投出去' } }}
      selected={false} onOpen={() => {}} now={NOW} />)
    expect(partial).toContain('session-row__rotation is-partial')
    expect(partial).toContain('已轮换 · 未交接上下文')
    // 没有轮换记录、没有气泡数：两处都不出现
    const plain = renderToStaticMarkup(<SessionRailCard session={session} selected={false} onOpen={() => {}} now={NOW} />)
    expect(plain).not.toContain('session-row__rotation')
    expect(plain).not.toContain('会话体积')
  })
})
