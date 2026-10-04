import { describe, expect, it, vi } from 'vitest'
import { emptyTaskPoolSnapshot, type PlanTaskInput, type TeamTask } from '../src/domain/task-pool'
import { submitGroupTask } from '../src/renderer/src/team/group-task-submit'

const draft: PlanTaskInput = {
  key: 'stable-key',
  title: ' 检查隔离 ',
  acceptance: '明确证据',
  targetSlotId: 'slot-1'
}
function snapshot(overrides: Partial<TeamTask> = {}) {
  const task: TeamTask = {
    id: 'task-1',
    runId: 'run-1',
    groupId: 'group-1',
    key: 'stable-key',
    title: '检查隔离',
    description: '',
    acceptance: '明确证据',
    targetSlotId: 'slot-1',
    priority: 2,
    status: 'queued',
    dependsOn: [],
    requiredCapabilities: [],
    maxAttempts: 3,
    attemptCount: 0,
    progress: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
  return { ...emptyTaskPoolSnapshot(), runId: 'run-1', tasks: { [task.id]: task }, taskOrder: [task.id] }
}
describe('operator task submit receipt recovery', () => {
  it('verifies the authoritative saved task even when the original create receipt was lost', async () => {
    const saved = snapshot(),
      port = {
        planTeamGroupTasks: vi.fn(async () => {
          throw Error('IPC receipt lost')
        }),
        getTaskPoolSnapshot: vi.fn(async () => saved)
      }
    expect(await submitGroupTask(port, 'run-1', 'group-1', draft)).toBe(saved)
    expect(port.planTeamGroupTasks).toHaveBeenCalledWith({ groupId: 'group-1', tasks: [draft] })
  })
  it.each([
    { runId: 'old-run' },
    { groupId: 'foreign-group' },
    { key: 'other-key' },
    { title: 'conflicting title' },
    { acceptance: 'other acceptance' },
    { targetSlotId: 'other-slot' }
  ])('does not turn an unrelated or conflicting task into a successful save: %j', async (conflict) => {
    const port = {
      planTeamGroupTasks: vi.fn(async () => {
        throw Error('duplicate or denied')
      }),
      getTaskPoolSnapshot: vi.fn(async () => snapshot(conflict))
    }
    await expect(submitGroupTask(port, 'run-1', 'group-1', draft)).rejects.toThrow('duplicate or denied')
  })
  it('does not report success from an empty/native success response without a matching snapshot', async () => {
    const port = {
      planTeamGroupTasks: vi.fn(async () => []),
      getTaskPoolSnapshot: vi.fn(async () => emptyTaskPoolSnapshot())
    }
    await expect(submitGroupTask(port, 'run-1', 'group-1', draft)).rejects.toThrow('尚未确认')
  })
})
