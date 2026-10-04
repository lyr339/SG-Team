import type { PlanTaskInput, TaskPoolSnapshot, TeamTask } from '../../../domain/task-pool'

export interface GroupTaskSubmitPort {
  planTeamGroupTasks(input: { groupId: string; tasks: PlanTaskInput[] }): Promise<TeamTask[]>
  getTaskPoolSnapshot(): Promise<TaskPoolSnapshot>
}

/** A lost IPC receipt must not create a second task or leave an already-saved draft permanently failing. */
export async function submitGroupTask(
  port: GroupTaskSubmitPort,
  runId: string,
  groupId: string,
  input: PlanTaskInput
): Promise<TaskPoolSnapshot> {
  let submitError: unknown
  try {
    await port.planTeamGroupTasks({ groupId, tasks: [input] })
  } catch (error) {
    submitError = error
  }
  const snapshot = await port.getTaskPoolSnapshot()
  const saved = Object.values(snapshot.tasks).find(
    (task) =>
      task.runId === runId &&
      task.groupId === groupId &&
      task.key === input.key &&
      task.title === input.title.trim() &&
      task.acceptance === (input.acceptance?.trim() ?? '') &&
      (task.targetSlotId ?? '') === (input.targetSlotId?.trim() ?? '')
  )
  if (!saved) {
    if (submitError) throw submitError
    throw new Error('尚未确认新任务已保存，草稿已保留，请重试')
  }
  return snapshot
}
