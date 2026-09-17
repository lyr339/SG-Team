// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MembershipTransferOptions, MembershipTransferOutcome, MembershipTransferResult } from '../src/domain/team-handoff'
import { ManualHandoffDialog } from '../src/renderer/src/team/ManualHandoffDialog'

const leadTransfer: MembershipTransferOptions = {
  runId: 'run-a',
  groupId: 'team-group:ws:g1',
  groupName: '接口重构',
  sourceSlotId: 'slot-lead',
  sourceRoleName: '主控协调',
  sourceChannelId: '1',
  transfersLead: true,
  candidates: [{
    slotId: 'slot-solo-2',
    channelId: '2',
    roleName: '独立会话',
    avatarId: 'researcher',
    online: true,
    impact: '在线独立席位：入组通知随它的下一次轮询到达'
  }]
}

const memberTransfer: MembershipTransferOptions = {
  runId: 'run-a',
  groupId: 'team-group:ws:g1',
  groupName: '接口重构',
  sourceSlotId: 'slot-builder',
  sourceRoleName: '架构实现',
  sourceChannelId: '2',
  transfersLead: false,
  candidates: [{
    slotId: 'slot-solo-7',
    channelId: '7',
    roleName: '独立会话',
    online: false,
    impact: '当前离线：通知与上下文会在其通道排队，等新会话上线后生效'
  }]
}

function transferResult(overrides: Partial<MembershipTransferResult> = {}): MembershipTransferResult {
  return {
    groupId: 'team-group:ws:g1',
    fromSlotId: 'slot-builder',
    toSlotId: 'slot-solo-7',
    toChannelId: '7',
    roleName: '架构实现',
    transferredLead: false,
    failover: {
      id: 'team-handoff:membership:test', workspaceId: 'ws', runId: 'run-a',
      slotId: 'slot-builder', roleName: '架构实现', fromChannelId: '2', fromAgentSessionId: 'agent-2',
      toChannelId: '7', toAgentSessionId: 'agent-7',
      status: 'completed', reason: 'manual_membership_transfer', taskIds: [],
      detectedAt: 1, updatedAt: 1, completedAt: 1
    },
    releasedTaskIds: [],
    ...overrides
  }
}

describe('ManualHandoffDialog', () => {
  it('announces that the lead identity travels with the membership for an effective lead source', () => {
    const html = renderToStaticMarkup(
      <ManualHandoffDialog options={leadTransfer} busy={false} error="" onClose={() => {}} onConfirm={async () => undefined} />
    )
    expect(html).toContain('迁移成员身份：主控协调 · 协作组「接口重构」')
    expect(html).toContain('CH-1 是本组有效 lead，lead 身份随迁')
  })

  it('offers offline seats too and the context handoff checked by default', () => {
    const html = renderToStaticMarkup(
      <ManualHandoffDialog options={memberTransfer} busy={false} error="" onClose={() => {}} onConfirm={async () => undefined} />
    )
    expect(html).toContain('同时交接上下文文档')
    expect(html).toMatch(/<input type="checkbox" checked=""/)
    expect(html).toContain('把 CH-2 的 Cursor 会话转录与拾光会话记录路径作为一条消息排进接手者队列')
    expect(html).toContain('当前离线：通知与上下文会在其通道排队')
    // 离线目标不禁用：radio 只在 busy 时禁用。
    expect(html).not.toMatch(/<input type="radio"[^>]*disabled/)
  })
})

describe('ManualHandoffDialog · 确认后的结果页', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  async function confirmWith(outcome: MembershipTransferOutcome): Promise<ReturnType<typeof vi.fn>> {
    const onConfirm = vi.fn(async () => outcome)
    await act(async () => {
      root.render(<ManualHandoffDialog options={memberTransfer} busy={false} error="" onClose={() => {}} onConfirm={onConfirm} onOpenSession={() => {}} />)
    })
    const confirm = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认迁移')!
    await act(async () => { confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) })
    return onConfirm
  }

  it('passes the checkbox state through and shows both the transfer and the queued context documents', async () => {
    const onConfirm = await confirmWith({
      transfer: transferResult({ releasedTaskIds: ['task-1', 'task-2'] }),
      contextHandoff: {
        ok: true,
        result: { targetChannelId: '7', held: false, transcriptPath: '/t/composer.jsonl', recordPath: '/h/CH-2.md', commandId: 'c', issuedAt: 1 }
      }
    })
    expect(onConfirm).toHaveBeenCalledWith({ toSlotId: 'slot-solo-7', includeContext: true })
    const status = container.querySelector('[role="status"]')!
    expect(status.textContent).toContain('组身份已迁移给 CH-7（架构实现）')
    expect(status.textContent).toContain('2 项任务已释放回队列')
    expect(status.textContent).toContain('上下文文档已排进 CH-7 的队列')
    expect(status.textContent).toContain('/t/composer.jsonl')
    expect(status.textContent).toContain('/h/CH-2.md')
    expect(Array.from(container.querySelectorAll('button')).map((button) => button.textContent)).toContain('打开 CH-7')
  })

  it('says the lead moved when the transfer carried the lead identity', async () => {
    await confirmWith({ transfer: transferResult({ transferredLead: true }) })
    const status = container.querySelector('[role="status"]')!
    expect(status.textContent).toContain('组身份与 lead 已迁移给 CH-7（架构实现）')
  })

  it('keeps the transfer result and surfaces a failed context delivery as a warning', async () => {
    await confirmWith({
      transfer: transferResult(),
      contextHandoff: { ok: false, error: 'CH-2 尚未绑定 Cursor Composer，找不到它的上下文文档' }
    })
    const warning = container.querySelector('.handoff-done p.is-warning')!
    expect(warning.textContent).toContain('上下文文档未投递：CH-2 尚未绑定 Cursor Composer')
    expect(warning.textContent).toContain('成员身份迁移不受影响')
  })
})
