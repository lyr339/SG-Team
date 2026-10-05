import { describe, expect, it, vi } from 'vitest'
import { registerTeamMemoryInspectionIpc } from '../src/main/register-team-memory-inspection-ipc'
import { IPC } from '../src/shared/desktop-api'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { emptyTeamMemorySnapshot } from '../src/domain/team-memory'
const { handlers, trusted } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => unknown>(), trusted: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, input: unknown) => unknown) => handlers.set(name, fn),
    removeHandler: (name: string) => handlers.delete(name)
  }
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: trusted }))
describe('explicit memory source inspection remains read-only and scope fenced', () => {
  it('validates source identity before reading, strips no original record fields, and cannot review/propose via IPC', () => {
    trusted.mockReset()
    handlers.clear()
    const team = {
      ...emptyTeamControlSnapshot(),
      activeWorkspaceId: 'w',
      activeRun: {
        id: 'r',
        workspaceId: 'w',
        name: '',
        goal: '',
        templateId: 'independent-session-v1',
        status: 'running' as const,
        createdAt: 1,
        updatedAt: 1
      }
    }
    const snapshot = emptyTeamMemorySnapshot('w', 'r')
    snapshot.items.m = {
      id: 'm',
      workspaceId: 'w',
      runId: 'r',
      scope: 'run',
      kind: 'fact',
      title: 't',
      content: 'original body',
      status: 'proposed',
      version: 2,
      proposedBy: { type: 'operator' },
      sources: [],
      createdAt: 1,
      updatedAt: 1
    }
    const getSnapshot = vi.fn(() => snapshot),
      review = vi.fn(),
      dispose = registerTeamMemoryInspectionIpc(
        { getSnapshot, review } as never,
        () => team,
        () => undefined
      )
    try {
      const invoke = (input: unknown) => handlers.get(IPC.teamMemoryInspect)!({}, input)
      expect(invoke({ workspaceId: 'w', runId: 'r', memoryId: 'm', version: 2, action: 'accept' })).toMatchObject({
        item: { id: 'm', content: 'original body' }
      })
      expect(getSnapshot).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
      expect([...handlers.keys()]).toEqual([IPC.teamMemoryInspect])
      expect(() => invoke({ workspaceId: 'other', runId: 'r', memoryId: 'm', version: 2 })).toThrow('范围')
      expect(getSnapshot).toHaveBeenCalledOnce()
      expect(() => invoke({ workspaceId: 'w', runId: 'r', memoryId: 'm', version: 3 })).toThrow('范围')
      expect(review).not.toHaveBeenCalled()
      trusted.mockImplementationOnce(() => {
        throw Error('untrusted')
      })
      expect(() => invoke({ workspaceId: 'w', runId: 'r', memoryId: 'm', version: 2 })).toThrow('untrusted')
    } finally {
      dispose()
      expect(handlers.size).toBe(0)
    }
  })
})
