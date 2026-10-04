import { describe, expect, it } from 'vitest'
import { batchLaunchNotification } from '../src/domain/batch-launch-notification'
import type { AgentLaunchPlan } from '../src/domain/agent-launch'
const plan = (patch: Partial<AgentLaunchPlan> = {}): AgentLaunchPlan => ({ id: 'plan-a', state: 'running', startedAt: 100, items: [{ channelId: '1', stage: 'composer', message: 'submitted', submitted: true, creation: 'new', composerId: 'new-composer' }], ...patch })
describe('batch notification outcome semantics', () => {
  it('submission and binding progress do not claim Agent readiness or trigger a completion toast', () => {
    const draft = batchLaunchNotification(plan(), { workspaceId: 'a', runId: 'r' }, true, 200)
    expect(draft).toMatchObject({ attention: 'activity', announce: false, state: 'active' })
    expect(draft.detail).toContain('协议在岗 0 个'); expect(draft.detail).toContain('等待绑定')
  })
  it('partial failure keeps accepted creation visible and warns against indiscriminate repeat creation', () => {
    const draft = batchLaunchNotification(plan({ state: 'failed', finishedAt: 300, items: [{ channelId: '1', stage: 'done', message: 'on duty', creation: 'new', submitted: true },
      { channelId: '2', stage: 'failed', message: 'binding timeout', creation: 'new', submitted: true }] }), { workspaceId: 'a', runId: 'r' }, true, 400)
    expect(draft).toMatchObject({ title: '1 个会话已接入，1 个未就绪', tone: 'warning', announce: true, occurredAt: 300 })
    expect(draft.detail).toContain('重复创建前'); expect(draft.detail).toContain('binding timeout')
  })
  it('reusing existing duty sessions neither claims new creation nor starts an account automation result', () => {
    const draft = batchLaunchNotification(plan({ state: 'done', finishedAt: 200, items: [{ channelId: '1', stage: 'done', message: 'existing', creation: 'existing' }] }), {}, true, 300)
    expect(draft).toMatchObject({ title: '1 个已有会话保持可用', attention: 'activity', announce: false })
    expect(draft.detail).toContain('没有新增创建或触发账号自动化')
  })
  it('failure diagnostics are capped and redacted without passing prompts, account credentials or raw requests', () => {
    const draft = batchLaunchNotification(plan({ state: 'failed', items: Array.from({ length: 32 }, (_, index) => ({ channelId: String(index), stage: 'failed' as const, message: `Bearer synthetic-secret ${'x'.repeat(1_000)}` })) }), {}, false, 300)
    expect(draft.detail).not.toContain('synthetic-secret'); expect(draft.detail!.length).toBeLessThanOrEqual(3_800)
    expect(draft.target).toBeUndefined(); expect(draft.announce).toBe(false)
  })
})
