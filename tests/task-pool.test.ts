import { describe, expect, it } from 'vitest'
import { TaskPoolAggregate, TaskPoolError } from '../src/domain/task-pool'

/** `online` = 此刻在岗的 agentSessionId；测试中增删即模拟席位上下线（阶段 2 · 2F）。 */
function fixture(online = new Set<string>()) {
  let now = 1_000
  let task = 0
  let attempt = 0
  let lease = 0
  const pool = new TaskPoolAggregate(undefined, {
    now: () => now,
    taskId: () => `task-${++task}`,
    attemptId: () => `attempt-${++attempt}`,
    leaseToken: () => `lease-${++lease}`,
    holderOnline: (agentSessionId) => online.has(agentSessionId)
  })
  return {
    pool,
    online,
    at: () => now,
    advance(ms: number) {
      now += ms
    }
  }
}

const DEFAULT_TTL_MS = 5 * 60_000

describe('TaskPoolAggregate', () => {
  it('rejects a cyclic plan atomically', () => {
    const { pool } = fixture()

    expect(() => pool.plan('run-1', [
      { key: 'a', title: 'A', dependsOn: ['b'] },
      { key: 'b', title: 'B', dependsOn: ['a'] }
    ])).toThrowError(TaskPoolError)

    expect(pool.snapshot().taskOrder).toEqual([])
    expect(pool.snapshot().revision).toBe(0)
  })

  it('enforces capabilities, dependencies, one active assignment and review gates', () => {
    const { pool } = fixture()
    const [implementation, verification] = pool.plan('run-1', [
      { key: 'impl', title: '实现', priority: 0, requiredCapabilities: ['code'] },
      { key: 'verify', title: '验证', dependsOn: ['impl'], requiredCapabilities: ['qa'] }
    ])

    expect(pool.leaseNext({ runId: 'run-1', agentSessionId: 'qa-1', capabilities: ['qa'] })).toBeNull()
    const leased = pool.leaseNext({ runId: 'run-1', agentSessionId: 'dev-1', capabilities: ['code'] })
    expect(leased?.task.id).toBe(implementation?.id)
    expect(() => pool.leaseNext({ runId: 'run-1', agentSessionId: 'dev-1', capabilities: ['code'] }))
      .toThrowError(/已经持有/)

    pool.startAttempt(leased!.attempt.id, leased!.leaseToken)
    pool.reportProgress(leased!.attempt.id, leased!.leaseToken, 70, '主体完成')
    pool.reportProgress(leased!.attempt.id, leased!.leaseToken, 30, '旧进度不能覆盖新进度')
    expect(pool.snapshot().attempts[leased!.attempt.id]?.progress).toBe(70)
    pool.submitForReview(leased!.attempt.id, leased!.leaseToken, 'diff + tests')

    expect(pool.leaseNext({ runId: 'run-1', agentSessionId: 'qa-1', capabilities: ['qa'] })).toBeNull()
    expect(() => pool.leaseReview({
      runId: 'run-1', agentSessionId: 'dev-1', slotId: 'slot-dev', taskId: implementation!.id
    })).toThrowError(/不能验收自己/)
    const review = pool.leaseReview({
      runId: 'run-1', agentSessionId: 'qa-1', slotId: 'slot-qa', taskId: implementation!.id
    })!
    expect(JSON.stringify(review)).toContain('review')
    pool.submitReview(review.review.id, review.leaseToken, 'accept', '单测、构建与边界检查通过')
    const qaLease = pool.leaseNext({ runId: 'run-1', agentSessionId: 'qa-1', capabilities: ['qa'] })
    expect(qaLease?.task.id).toBe(verification?.id)
  })

  it('fences stale agents and fails a task after the retry budget is exhausted', () => {
    const { pool, advance } = fixture()
    const [task] = pool.plan('run-1', [{ key: 'unstable', title: '不稳定任务', maxAttempts: 2 }])
    const first = pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-1', ttlMs: 5_000 })!
    advance(5_001)

    expect(() => pool.startAttempt(first.attempt.id, first.leaseToken)).toThrowError(/过期/)
    expect(pool.snapshot().tasks[task!.id]?.status).toBe('leased')
    expect(pool.reclaimExpired()).toEqual([task!.id])
    expect(pool.snapshot().tasks[task!.id]?.status).toBe('queued')
    expect(() => pool.reportProgress(first.attempt.id, first.leaseToken, 50)).toThrowError(/失效/)

    const second = pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-2', ttlMs: 5_000 })!
    advance(5_001)
    expect(pool.reclaimExpired()).toEqual([task!.id])
    expect(pool.snapshot().tasks[task!.id]?.status).toBe('failed')
    expect(pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-3' })).toBeNull()
  })

  it('requires a rejection reason and requeues review work within the retry budget', () => {
    const { pool } = fixture()
    const [task] = pool.plan('run-1', [{ key: 'review-me', title: '待验收', maxAttempts: 2 }])
    const leased = pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-1' })!
    pool.startAttempt(leased.attempt.id, leased.leaseToken)
    pool.submitForReview(leased.attempt.id, leased.leaseToken, '产物')

    expect(() => pool.reject(task!.id, 'reviewer-1', '')).toThrowError(/说明原因/)
    expect(pool.reject(task!.id, 'reviewer-1', '缺少回归测试').status).toBe('queued')
    expect(pool.snapshot().tasks[task!.id]?.failureReason).toBe('缺少回归测试')
  })

  it('requeues an expired review lease without losing the implementation output', () => {
    const { pool, advance } = fixture()
    const [task] = pool.plan('run-1', [{ key: 'review-expiry', title: '验收续租', maxAttempts: 2 }])
    const implementation = pool.leaseNext({ runId: 'run-1', agentSessionId: 'dev-1' })!
    pool.startAttempt(implementation.attempt.id, implementation.leaseToken)
    pool.submitForReview(implementation.attempt.id, implementation.leaseToken, '可验收产物')
    const firstReview = pool.leaseReview({
      runId: 'run-1', agentSessionId: 'qa-1', slotId: 'slot-qa', taskId: task!.id, ttlMs: 5_000
    })!
    advance(5_001)

    expect(pool.reclaimExpired()).toEqual([task!.id])
    expect(pool.snapshot().reviews[firstReview.review.id]).toMatchObject({ status: 'queued' })
    expect(pool.snapshot().attempts[implementation.attempt.id]).toMatchObject({ status: 'review', output: '可验收产物' })
    const secondReview = pool.leaseReview({
      runId: 'run-1', agentSessionId: 'qa-2', slotId: 'slot-qa-2', taskId: task!.id
    })
    expect(secondReview?.review).toMatchObject({ leaseCount: 2, reviewerSessionId: 'qa-2' })
  })

  it('allows stable task keys to be reused by different runs', () => {
    const { pool } = fixture()
    pool.plan('run-1', [{ key: 'build', title: '构建一' }])
    pool.plan('run-2', [{ key: 'build', title: '构建二' }])
    expect(pool.snapshot().taskOrder).toHaveLength(2)
  })

  it('在岗的 assignee：租约到期由服务端续租而不是回收（长命令期间不碰 MCP 也不丢任务）', () => {
    const { pool, advance, at } = fixture(new Set(['agent-1']))
    const [task] = pool.plan('run-1', [{ key: 'long-run', title: '长命令', maxAttempts: 2 }])
    const leased = pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-1', ttlMs: 5_000 })!
    pool.startAttempt(leased.attempt.id, leased.leaseToken)
    const taskUpdatedAt = pool.snapshot().tasks[task!.id]!.updatedAt
    const eventCount = pool.snapshot().events.length

    // 6 分钟没有任何 MCP 调用，但通道 presence 仍在岗（CDP runtimeActiveAt 在刷）。
    advance(360_000)
    expect(pool.reclaimExpired()).toEqual([])
    expect(pool.snapshot().tasks[task!.id]?.status).toBe('running')
    expect(pool.snapshot().attempts[leased.attempt.id]?.leaseExpiresAt).toBe(at() + DEFAULT_TTL_MS)
    // 自动续租不是任务进展：不写事件、不顶 task.updatedAt，但要 bump revision 才落盘。
    expect(pool.snapshot().events).toHaveLength(eventCount)
    expect(pool.snapshot().tasks[task!.id]?.updatedAt).toBe(taskUpdatedAt)

    // 续到期之前再清扫是纯读：不再写第二次。
    const revision = pool.snapshot().revision
    expect(pool.reclaimExpired()).toEqual([])
    expect(pool.snapshot().revision).toBe(revision)
  })

  it('在岗持有者自己写入时顺手续租：progress / submit 之前没有续租动作', () => {
    const { pool, advance, at } = fixture(new Set(['agent-1']))
    const [task] = pool.plan('run-1', [{ key: 'self-renew', title: '自续租' }])
    const leased = pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-1', ttlMs: 5_000 })!
    pool.startAttempt(leased.attempt.id, leased.leaseToken)
    advance(5_001) // 租约已过期，但清扫器还没跑到

    expect(pool.reportProgress(leased.attempt.id, leased.leaseToken, 60, '半程').progress).toBe(60)
    expect(pool.snapshot().attempts[leased.attempt.id]?.leaseExpiresAt).toBe(at() + DEFAULT_TTL_MS)
    expect(pool.snapshot().events.some((event) => event.type.includes('renew'))).toBe(false)
    expect(pool.submitForReview(leased.attempt.id, leased.leaseToken, '产物').status).toBe('review')
    expect(pool.snapshot().tasks[task!.id]?.status).toBe('review')
  })

  it('离线的 assignee：到期即回收，任务回队并可被另一个席位重新领取', () => {
    const { pool, online, advance } = fixture(new Set(['agent-1']))
    const [task] = pool.plan('run-1', [{ key: 'offline-owner', title: '掉线任务', maxAttempts: 2 }])
    const leased = pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-1', ttlMs: 5_000 })!
    pool.startAttempt(leased.attempt.id, leased.leaseToken)
    advance(360_000)
    expect(pool.reclaimExpired()).toEqual([]) // 还在岗：先续租

    // 席位确认离线（presence 三段窗口已判死）后再清扫：这时才回收。
    online.delete('agent-1')
    advance(DEFAULT_TTL_MS + 1)
    expect(pool.reclaimExpired()).toEqual([task!.id])
    expect(pool.snapshot().tasks[task!.id]?.status).toBe('queued')
    expect(pool.snapshot().attempts[leased.attempt.id]).toMatchObject({ status: 'failed', error: 'lease_expired' })
    // 离线的持有者即便拿着合法 token 也写不进去。
    expect(() => pool.reportProgress(leased.attempt.id, leased.leaseToken, 80)).toThrowError(/失效/)
    expect(pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-2' })?.task.id).toBe(task!.id)
  })

  it('验收租约同一口径：在岗的 reviewer 续租，离线才把验收放回队列', () => {
    const { pool, online, advance, at } = fixture(new Set(['qa-1']))
    const [task] = pool.plan('run-1', [{ key: 'review-presence', title: '验收在岗' }])
    const implementation = pool.leaseNext({ runId: 'run-1', agentSessionId: 'dev-1' })!
    pool.startAttempt(implementation.attempt.id, implementation.leaseToken)
    pool.submitForReview(implementation.attempt.id, implementation.leaseToken, '可验收产物')
    const review = pool.leaseReview({
      runId: 'run-1', agentSessionId: 'qa-1', slotId: 'slot-qa', taskId: task!.id, ttlMs: 5_000
    })!

    advance(5_001)
    expect(pool.reclaimExpired()).toEqual([])
    expect(pool.snapshot().reviews[review.review.id]).toMatchObject({ status: 'leased', reviewerSessionId: 'qa-1' })
    expect(pool.snapshot().reviews[review.review.id]!.leaseExpiresAt).toBe(at() + DEFAULT_TTL_MS)

    online.delete('qa-1')
    advance(DEFAULT_TTL_MS + 1)
    expect(pool.reclaimExpired()).toEqual([task!.id])
    expect(pool.snapshot().reviews[review.review.id]).toMatchObject({ status: 'queued' })
    expect(pool.snapshot().attempts[implementation.attempt.id]).toMatchObject({ status: 'review', output: '可验收产物' })
  })

  it('没有注入在岗判定时保持「到期即回收」：忘记接线不会变成永不过期', () => {
    const pool = new TaskPoolAggregate(undefined, { now: () => 1_000 })
    const [task] = pool.plan('run-1', [{ key: 'no-port', title: '无活性端口' }])
    const leased = pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-1', ttlMs: 5_000 })!
    expect(leased.leaseExpiresAt).toBe(6_000)
    const expired = new TaskPoolAggregate(pool.snapshot(), { now: () => 999_999 })
    expect(expired.reclaimExpired()).toEqual([task!.id])
  })

  it('returns defensive snapshots and monotonic event sequences', () => {
    const { pool } = fixture()
    const [task] = pool.plan('run-1', [{ key: 'safe', title: '安全快照' }])
    const snapshot = pool.snapshot()
    snapshot.tasks[task!.id]!.title = '外部篡改'

    expect(pool.snapshot().tasks[task!.id]?.title).toBe('安全快照')
    expect(pool.snapshot().events.map((event) => event.seq)).toEqual([1])
  })
})
