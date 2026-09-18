import { useState } from 'react'
import type { MembershipTransferCandidate, MembershipTransferOptions, MembershipTransferOutcome } from '../../../domain/team-handoff'
import { AgentAvatar } from '../AgentAvatar'

interface TransferMembershipDialogProps {
  options: MembershipTransferOptions
  busy: boolean
  error: string
  onClose: () => void
  /** 执行迁移；成功返回结果（弹窗据此显示结果页），失败由调用方写入 error 并返回 undefined。 */
  onConfirm: (input: { toSlotId: string; includeContext: boolean }) => Promise<MembershipTransferOutcome | undefined>
  onOpenSession?: (channelId: string) => void
}

/**
 * 成员身份迁移弹窗（阶段 2 · 2C）：把离线组内席位的组身份（组角色 + lead）移交给池内另一个
 * 独立席位；通道即席位，绑定与令牌不动。「同时交接上下文文档」把原席位的 Cursor 转录与拾光
 * 会话记录路径作为一条普通用户消息排进目标席位队列——上下文由主进程在迁移前解析、迁移成功
 * 后投递，两者结果分别显示。入口有两个：会话页的「交接」按钮（离线入组席位）与组卡片离线成员行的「交接…」。
 */
export function TransferMembershipDialog({ options, busy, error, onClose, onConfirm, onOpenSession }: TransferMembershipDialogProps): React.JSX.Element {
  const [selected, setSelected] = useState(options.candidates[0]?.slotId ?? '')
  const [includeContext, setIncludeContext] = useState(true)
  const [outcome, setOutcome] = useState<{ candidate: MembershipTransferCandidate; result: MembershipTransferOutcome }>()

  const confirm = async (): Promise<void> => {
    const candidate = options.candidates.find((item) => item.slotId === selected)
    if (!candidate) return
    const result = await onConfirm({ toSlotId: candidate.slotId, includeContext })
    if (result) setOutcome({ candidate, result })
  }

  return (
    <div className="handoff-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <header>
          <div>
            <strong id="handoff-title">迁移成员身份：{options.sourceRoleName} · 协作组「{options.groupName}」</strong>
            <span>{options.transfersLead ? `CH-${options.sourceChannelId ?? '?'} 是本组有效 lead，lead 身份随迁` : `CH-${options.sourceChannelId ?? '?'} 的组身份将移交给所选席位`}</span>
          </div>
          <button disabled={busy} aria-label="关闭迁移窗口" onClick={onClose}>×</button>
        </header>
        {outcome ? (
          <div className="handoff-done" role="status">
            <i aria-hidden="true">✓</i>
            <strong>
              {outcome.result.transfer.transferredLead
                ? `组身份与 lead 已迁移给 CH-${outcome.result.transfer.toChannelId ?? '?'}（${outcome.result.transfer.roleName}）`
                : `组身份已迁移给 CH-${outcome.result.transfer.toChannelId ?? '?'}（${outcome.result.transfer.roleName}）`}
            </strong>
            <p>
              目标席位会在下一次轮询收到入组通知并领取简报
              {outcome.result.transfer.releasedTaskIds.length
                ? `；原成员的 ${outcome.result.transfer.releasedTaskIds.length} 项任务已释放回队列`
                : ''}。
            </p>
            {outcome.result.contextHandoff ? (
              outcome.result.contextHandoff.ok ? (
                <>
                  <p>上下文文档已排进 CH-{outcome.result.contextHandoff.result.targetChannelId} 的队列，接手者下一次轮询即会阅读。</p>
                  <dl>
                    <div><dt>上下文文档</dt><dd><code>{outcome.result.contextHandoff.result.transcriptPath}</code></dd></div>
                    {outcome.result.contextHandoff.result.recordPath
                      ? <div><dt>拾光会话记录</dt><dd><code>{outcome.result.contextHandoff.result.recordPath}</code></dd></div>
                      : null}
                  </dl>
                </>
              ) : (
                <p className="is-warning">上下文文档未投递：{outcome.result.contextHandoff.error}。成员身份迁移不受影响。</p>
              )
            ) : null}
            <footer>
              {onOpenSession && outcome.result.transfer.toChannelId ? (
                <button onClick={() => { onOpenSession(outcome.result.transfer.toChannelId!); onClose() }}>打开 CH-{outcome.result.transfer.toChannelId}</button>
              ) : null}
              <button onClick={onClose}>完成</button>
            </footer>
          </div>
        ) : (
          <>
            <div className="handoff-candidates">
              {options.candidates.map((candidate) => (
                <label key={candidate.slotId}>
                  <input type="radio" name="handoff-candidate" value={candidate.slotId}
                    checked={selected === candidate.slotId} disabled={busy}
                    onChange={() => setSelected(candidate.slotId)} />
                  {candidate.avatarId
                    ? <AgentAvatar avatarId={candidate.avatarId} name={candidate.roleName} online={candidate.online} size="sm" />
                    : <i className="handoff-candidate-channel">CH{candidate.channelId ?? '?'}</i>}
                  <span><strong>{candidate.roleName} · CH-{candidate.channelId ?? '?'}</strong><small>{candidate.impact}</small></span>
                  <em>{candidate.online ? '在线' : '离线'}</em>
                </label>
              ))}
              {!options.candidates.length ? <p>池内没有未入组的独立席位可以接收；先移出或新建一个独立席位。</p> : null}
            </div>
            <label className="handoff-context-option">
              <input type="checkbox" checked={includeContext} disabled={busy} onChange={(event) => setIncludeContext(event.target.checked)} />
              <span>
                <strong>同时交接上下文文档</strong>
                <small>把 CH-{options.sourceChannelId ?? '?'} 的 Cursor 会话转录与拾光会话记录路径作为一条消息排进接手者队列，接手者读完后接续原席位的工作。</small>
              </span>
            </label>
            {error ? <p className="handoff-dialog-error">{error}</p> : null}
            <footer>
              <button disabled={busy} onClick={onClose}>取消</button>
              <button disabled={busy || !selected} onClick={() => void confirm()}>{busy ? '迁移中…' : '确认迁移'}</button>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}
