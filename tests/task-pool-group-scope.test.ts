import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { InMemoryTaskPoolRepository } from '../src/infrastructure/task-pool/in-memory-task-pool-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'

/**
 * 任务按协作组作用域（任务书 I4 / §4.2 / §7）：同一会话池 run 内两个组各自规划任务，
 * 成员只见本组；解散只取消本组；成员出组释放其租约与验收。
 */

const allowAllAgents = { assertAgentAuthorized: () => undefined }
const RUN = 'session-run:ws:run-pool'
const GROUP_A = 'team-group:ws:aaaaaaaa-0000-0000-0000-000000000001'
const GROUP_B = 'team-group:ws:bbbbbbbb-0000-0000-0000-000000000002'

function agent(repository: InMemoryTaskPoolRepository, session: string, groupId: string | undefined, capabilities: string[], slotId = `slot-${session}`) {
  return new TaskAgentService(repository, { agentSessionId: `ws:${session}:gen`, runId: RUN, slotId, capabilities, groupId }, allowAllAgents)
}

function twoGroups() {
  const repository = new InMemoryTaskPoolRepository()
  const leadA = agent(repository, 'lead-a', GROUP_A, ['coordination', 'planning', 'code'])
  const builderA = agent(repository, 'builder-a', GROUP_A, ['code'])
  const reviewerA = agent(repository, 'reviewer-a', GROUP_A, ['qa'])
  const leadB = agent(repository, 'lead-b', GROUP_B, ['coordination', 'planning', 'code'])
  const builderB = agent(repository, 'builder-b', GROUP_B, ['code'])
  const [taskA] = leadA.plan([{ key: 'a-impl', title: 'A 组实现', requiredCapabilities: ['code'] }])
  const [taskB] = leadB.plan([{ key: 'b-impl', title: 'B 组实现', requiredCapabilities: ['code'] }])
  return { repository, leadA, builderA, reviewerA, leadB, builderB, taskA: taskA!, taskB: taskB! }
}

describe('task pool · 协作组作用域', () => {
  it('plans tasks with the planner group and keeps every agent-facing view inside its own group', () => {
    const { repository, leadA, builderA, reviewerA, leadB, builderB, taskA, taskB } = twoGroups()
    expect(taskA.groupId).toBe(GROUP_A)
    expect(taskB.groupId).toBe(GROUP_B)

    expect(builderA.listAvailable().map((task) => task.id)).toEqual([taskA.id])
    expect(builderB.listAvailable().map((task) => task.id)).toEqual([taskB.id])
    expect(leadA.listBoard().map((view) => view.task.id)).toEqual([taskA.id])
    expect(leadB.listBoard().map((view) => view.task.id)).toEqual([taskB.id])
    expect(() => builderA.getTask(taskB.id)).toThrowError(expect.objectContaining({ code: 'task_not_found' }))
    // 显式领取别组任务：任务存在但不在本组作用域。
    expect(() => builderA.claim(taskB.id)).toThrowError(expect.objectContaining({ code: 'task_group_mismatch' }))
    // 隐式领取只落到本组任务。
    expect(builderA.claim()?.task.id).toBe(taskA.id)
    expect(builderA.listMine().map((view) => view.task.id)).toEqual([taskA.id])
    expect(builderB.listMine()).toEqual([])

    // 验收作用域：A 组的提交只对 A 组 reviewer 可见；B 组 reviewer 领不到。
    builderA.start(taskA.id)
    builderA.submit(taskA.id, 'diff + tests')
    const reviewerB = agent(repository, 'reviewer-b', GROUP_B, ['qa'])
    expect(reviewerA.listReviews().map((view) => view.task.id)).toEqual([taskA.id])
    expect(reviewerB.listReviews()).toEqual([])
    expect(reviewerB.claimReview()).toBeNull()
    expect(() => reviewerB.claimReview(taskA.id)).toThrowError(expect.objectContaining({ code: 'task_group_mismatch' }))
    expect(reviewerA.claimReview()?.task.id).toBe(taskA.id)

    // 任务 key 仍以 run 为唯一域：跨组同名 key 被拒绝，而不是悄悄建出两条同键任务。
    expect(() => leadB.plan([{ key: 'a-impl', title: '撞键' }])).toThrowError(expect.objectContaining({ code: 'duplicate_task_key' }))
    // 依赖只能指向同组任务。
    expect(() => leadB.plan([{ key: 'b-next', title: '跨组依赖', dependsOn: ['a-impl'] }]))
      .toThrowError(expect.objectContaining({ code: 'missing_dependency' }))
  })

  it('keeps legacy run-level tasks (no group) invisible to grouped agents and vice versa', () => {
    const repository = new InMemoryTaskPoolRepository()
    const [legacyTask] = transactTaskPool(repository, (pool) => pool.plan(RUN, [{ key: 'legacy', title: 'run 级任务', requiredCapabilities: ['code'] }]))
    const legacyAgent = agent(repository, 'legacy', undefined, ['code', 'coordination', 'planning'])
    const grouped = agent(repository, 'grouped', GROUP_A, ['code', 'coordination', 'planning'])
    expect(legacyAgent.listAvailable().map((task) => task.id)).toEqual([legacyTask!.id])
    expect(grouped.listAvailable()).toEqual([])
    expect(grouped.listBoard()).toEqual([])
    expect(() => grouped.claim(legacyTask!.id)).toThrowError(expect.objectContaining({ code: 'task_group_mismatch' }))
    expect(legacyAgent.claim()?.task.id).toBe(legacyTask!.id)
  })

  it('closeGroup cancels only the dissolved group and leaves the other group untouched', () => {
    const { repository, builderA, taskA, taskB } = twoGroups()
    builderA.claim(taskA.id)
    builderA.start(taskA.id)
    const service = new TaskPoolService(repository, { getActiveRunId: () => RUN })
    const cancelled = service.closeGroup(RUN, GROUP_A, 'group_dissolved')
    expect(cancelled.map((task) => task.id)).toEqual([taskA.id])
    const state = repository.load()
    expect(state.tasks[taskA.id]).toMatchObject({ status: 'cancelled', failureReason: 'group_dissolved' })
    expect(state.attempts[state.tasks[taskA.id]!.currentAttemptId!]).toMatchObject({ status: 'cancelled', leaseToken: undefined })
    expect(state.tasks[taskB.id]?.status).toBe('queued')
    // 幂等：再解散一次没有可取消的任务。
    expect(service.closeGroup(RUN, GROUP_A)).toEqual([])
  })

  it('releaseAgentWork requeues a leaving member\'s attempt, clears its slot targeting and frees its review lease', () => {
    const { repository, leadA, builderA, reviewerA, taskA } = twoGroups()
    // 定向给 builderA 的第二条任务：出组后定向必须清空，否则组内无人能再领。
    const [targeted] = leadA.plan([{ key: 'a-targeted', title: '定向任务', requiredCapabilities: ['code'], targetSlotId: builderA.identity.slotId }])
    builderA.claim(taskA.id)
    builderA.start(taskA.id)
    builderA.submit(taskA.id, 'output')
    reviewerA.claimReview(taskA.id)
    const otherBuilder = agent(repository, 'builder-a2', GROUP_A, ['code'])
    // 定向任务对组内其他席位不可领：出组前 otherBuilder 隐式领取拿不到任何任务。
    expect(otherBuilder.claim()).toBeNull()
    expect(repository.load().tasks[targeted!.id]?.status).toBe('queued')

    const service = new TaskPoolService(repository, { getActiveRunId: () => RUN })
    // reviewer 出组：其验收租约回 queued，任务仍在 review。
    expect(service.releaseAgentWork({ agentSessionId: reviewerA.identity.agentSessionId, slotId: reviewerA.identity.slotId, reason: 'member_left' }))
      .toEqual([taskA.id])
    let state = repository.load()
    expect(state.tasks[taskA.id]?.status).toBe('review')
    expect(state.reviews[state.tasks[taskA.id]!.currentReviewId!]).toMatchObject({ status: 'queued', reviewerSessionId: undefined, leaseToken: undefined })
    expect(state.events.at(-1)).toMatchObject({ type: 'review.released_by_membership', taskId: taskA.id, detail: 'member_left' })

    // builder 领走定向任务后出组：attempt cancelled、任务回 queued、定向清空 → 组内其他成员可领。
    const leaseResult = transactTaskPool(repository, (pool) => pool.leaseTask(targeted!.id, {
      runId: RUN, agentSessionId: builderA.identity.agentSessionId, slotId: builderA.identity.slotId, capabilities: ['code'], groupId: GROUP_A
    }))
    expect(leaseResult.task.status).toBe('leased')
    expect(service.releaseAgentWork({ agentSessionId: builderA.identity.agentSessionId, slotId: builderA.identity.slotId, reason: 'member_left' }))
      .toEqual([targeted!.id])
    state = repository.load()
    expect(state.tasks[targeted!.id]).toMatchObject({ status: 'queued', assigneeSessionId: undefined, targetSlotId: undefined, failureReason: 'member_left' })
    expect(state.attempts[leaseResult.attempt.id]).toMatchObject({ status: 'cancelled', error: 'member_left', leaseToken: undefined })
    expect(state.events.at(-1)).toMatchObject({ type: 'lease.released_by_membership', taskId: targeted!.id })
    expect(otherBuilder.claim()?.task.id).toBe(targeted!.id)
    // 没有可释放的工作时静默返回空，不推进 revision。
    const revision = repository.load().revision
    expect(service.releaseAgentWork({ agentSessionId: builderA.identity.agentSessionId, reason: 'member_left' })).toEqual([])
    expect(repository.load().revision).toBe(revision)
  })

  it('persists group_id through the SQLite repository and adds the column to a pre-group database idempotently', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-task-pool-group-')), 'pool.sqlite3')
    // 先造一个没有 group_id 列的旧库。
    const seeded = new SqliteTaskPoolRepository(path)
    transactTaskPool(seeded, (pool) => pool.plan(RUN, [{ key: 'legacy', title: 'legacy' }]))
    seeded.close()
    const old = new DatabaseSync(path)
    old.exec('DROP INDEX IF EXISTS idx_tasks_run_group_status')
    old.exec('ALTER TABLE tasks DROP COLUMN group_id')
    old.close()

    const migrated = new SqliteTaskPoolRepository(path)
    const second = new SqliteTaskPoolRepository(path)
    try {
      expect(Object.values(migrated.load().tasks).map((task) => task.groupId)).toEqual([undefined])
      const [grouped] = transactTaskPool(migrated, (pool) => pool.plan(RUN, [{ key: 'grouped', title: 'grouped' }], GROUP_A))
      expect(grouped?.groupId).toBe(GROUP_A)
      const reloaded = second.load()
      expect(reloaded.tasks[grouped!.id]?.groupId).toBe(GROUP_A)
      expect(Object.values(reloaded.tasks).find((task) => task.key === 'legacy')?.groupId).toBeUndefined()
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        expect((database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('group_id')
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_run_group_status'").all()).toHaveLength(1)
      } finally {
        database.close()
      }
    } finally {
      second.close()
      migrated.close()
    }
  })
})
