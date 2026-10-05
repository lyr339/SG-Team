import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { TeamControlService } from '../src/application/team-control-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { TeamGroupService } from '../src/application/team-group-service'
import { GroupEffectsNotifications } from '../src/application/notifications/group-effects-notifications'
import type { GroupEffectsFrame } from '../src/domain/group-effects'
import { notificationSourceHarness, notificationFrame } from './notification-source-fixtures'
export function groupEffectsFixture(observing = true) {
  const directory = mkdtempSync(join(tmpdir(), 'sg-group-effects-')),
    path = join(directory, 'business.sqlite')
  const repository = new SqliteTeamControlRepository(path),
    taskRepository = new SqliteTaskPoolRepository(path),
    messages = new SqliteTeamCollaborationRepository(path)
  const sent: unknown[] = []
  const bridge = {
    sent,
    getSnapshot: () => notificationFrame({ sessions: [] }),
    subscribe: () => () => {},
    sendMessage: vi.fn((input) => {
      sent.push(input)
      return { commandId: `fixture-${sent.length}` }
    })
  }
  const control = new TeamControlService(repository, bridge)
  let initial: import('../src/domain/team-control').TeamControlSnapshot
  try {
    initial = control.createSessionPool({
      workspaceId: 'fixture-workspace',
      workspaceName: 'isolated fixture',
      workspacePath: '/fixture-no-cursor',
      members: ['1', '2', '3', '4'].map((channelId) => ({
        channelId,
        roleTemplateKey: 'solo',
        avatarId: 'lead',
        skills: [],
        solo: true
      }))
    })
    control.recordInstallation({
      workspaceId: initial.activeWorkspaceId!,
      runId: initial.activeRun!.id,
      generation: 'fixture',
      agents: initial.members.map((member, index) => ({
        workspaceId: initial.activeWorkspaceId!,
        runId: initial.activeRun!.id,
        agentSessionId: `${initial.activeWorkspaceId}:ch-${index + 1}:fixture`,
        channelId: String(index + 1),
        generation: 'fixture',
        capabilities: []
      }))
    })
  } catch (error) {
    control.dispose()
    messages.close()
    taskRepository.close()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  const runId = initial.activeRun!.id,
    slots = initial.members.map((member) => member.slot.id)
  const tasks = new TaskPoolService(taskRepository, control),
    errors = vi.fn(),
    frames: GroupEffectsFrame[] = [],
    h = notificationSourceHarness(join(directory, 'notifications.sqlite'))
  let source: GroupEffectsNotifications | undefined
  const observer = {
    observe: (frame: GroupEffectsFrame) => {
      frames.push(structuredClone(frame))
      source?.observe(frame)
    },
    unavailable: () => h.owner.reportHistoryGap()
  }
  const service = new TeamGroupService(repository, control, tasks, messages, bridge, {
    now: Date.now,
    onerror: errors,
    ...(observing ? { effects: observer } : {})
  })
  if (observing) source = new GroupEffectsNotifications(h.owner, service.getEffectsOwnerId())
  const create = () =>
    service.createGroup({
      name: 'fixture group',
      goal: 'private original goal never in notification',
      members: [
        { slotId: slots[0]!, roleTemplateKey: 'lead' },
        { slotId: slots[1]!, roleTemplateKey: 'builder' }
      ],
      leadSlotId: slots[0]
    })
  const flush = async () => {
    await source?.flush()
    await h.owner.flush()
  }
  const close = async () => {
    await source?.close()
    await h.owner.close()
    tasks.stopWatcher()
    tasks.stopSweeper()
    control.dispose()
    messages.close()
    taskRepository.close()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
  return {
    directory,
    path,
    repository,
    taskRepository,
    messages,
    bridge,
    control,
    initial,
    runId,
    slots,
    tasks,
    errors,
    frames,
    h,
    service,
    observer,
    source,
    create,
    flush,
    close
  }
}
