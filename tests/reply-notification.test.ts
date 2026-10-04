import { describe, expect, it } from 'vitest'
import { reduceReplyNotifications } from '../src/domain/reply-notification'
import { reduceOperatorMessages } from '../src/domain/team-message-notification'
describe('human notification reading is independent of agent transport', () => {
  it('equal words in different associated replies remain different identities, and replay stays quiet', () => {
    const fact = { key: 'stable-anchor-1', entryId: 'reply:1', at: 100, scope: { sessionId: 'real-session', channelId: '1' }, name: '实现 · CH-1', failed: false }
    const first = reduceReplyNotifications(undefined, { key: 'reply-source:1', facts: [fact], now: 200 }, true, 1)
    expect(first.drafts).toHaveLength(0)
    const next = reduceReplyNotifications(first.state, { key: first.state.key, facts: [fact, { ...fact, key: 'stable-anchor-2', entryId: 'reply:2' }], now: 300 }, false, 2)
    expect(next.drafts).toHaveLength(1); expect(next.drafts[0]?.target).toMatchObject({ entryId: 'reply:2' })
    expect(next.drafts[0]?.announce).toBe(false)
  })
  it('user-directed collaboration restores to the center, without pretending it wrote read/response receipts', () => {
    const fact = { id: 'message-1', kind: 'question' as const, at: 100, sender: '主控', subject: '确认方向', scope: { runId: 'real-run', groupId: 'real-group' } }
    const input = { key: 'operator-source:1', facts: [fact], now: 200 }
    const first = reduceOperatorMessages(undefined, input, true, 1)
    expect(first.drafts[0]).toMatchObject({ attention: 'notice', announce: false, target: { kind: 'collaboration', messageId: 'message-1' } })
    expect(first.drafts[0]?.detail).toContain('不会改写 Agent')
    expect(reduceOperatorMessages(first.state, input, false, 2).drafts).toHaveLength(0)
    const next = reduceOperatorMessages(first.state, { ...input, facts: [...input.facts, { ...fact, id: 'message-2' }] }, false, 3)
    expect(next.drafts[0]?.announce).toBe(true)
  })
})
