import { describe, expect, it } from 'vitest'
import { membershipTransferNotification } from '../src/domain/membership-transfer-notification'
import type { MembershipTransferOutcome } from '../src/domain/team-handoff'
import { notificationTeam } from './notification-source-fixtures'

const outcome: MembershipTransferOutcome = { transfer: { groupId: 'group-a', fromSlotId: 'from', toSlotId: 'to', toChannelId: '2', roleName: '架构实现', transferredLead: true, releasedTaskIds: ['a', 'b'],
  failover: { id: 'migration-a', workspaceId: 'workspace-a', runId: 'run-a', slotId: 'from', roleName: '架构实现', fromChannelId: '1', fromAgentSessionId: 'old-session',
    status: 'completed', reason: 'manual_membership_transfer', taskIds: [], detectedAt: 100, updatedAt: 200, completedAt: 200 } } }
describe('identity transfer results keep optional context effects separate', () => {
  it('an actual context failure does not erase the confirmed role/lead/task release or advertise retrying the migration', () => {
    const draft = membershipTransferNotification({ ...outcome, contextHandoff: { ok: false, error: 'Bearer sensitive-test' } }, notificationTeam())
    expect(draft).toMatchObject({ tone: 'warning', attention: 'notice', state: 'resolved', scope: { workspaceId: 'workspace-a', runId: 'run-a', groupId: 'group-a' } })
    expect(draft.title).toContain('身份已迁移')
    expect(draft.detail).toContain('释放 2 个任务，主控身份随迁')
    expect(draft.detail).toContain('不会自动回滚或重复迁移'); expect(draft.detail).not.toContain('sensitive-test')
    expect(draft.announce).toBe(false)
  })
  it('identity-only or transport-untracked acceptance never asserts the attached documents were read', () => {
    expect(membershipTransferNotification(outcome, notificationTeam()).title).toBe('成员身份迁移已完成')
    const draft = membershipTransferNotification({ ...outcome, contextHandoff: { ok: true, result: { targetChannelId: '2', held: false, transcriptPath: '/t', commandId: 'accepted-only', issuedAt: 200 } } }, notificationTeam())
    expect(draft.detail).toContain('受理不等于已取走或已读完')
    expect(draft.detail).not.toContain('/t')
    expect(draft.target).toMatchObject({ kind: 'run', runId: 'run-a', groupId: 'group-a' })
  })
})
