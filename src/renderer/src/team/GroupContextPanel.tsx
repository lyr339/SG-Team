import { useEffect, useRef, useState } from 'react'
import type { PlanTaskInput, TaskStatus } from '../../../domain/task-pool'
import { teamMessageReceiptStage, isOrphanedReceipt } from '../../../domain/team-collaboration'
import type { GroupContextView } from './group-context-view'
import { AgentAvatar } from '../AgentAvatar'
import { MenuSelect } from '../lobby/MenuSelect'
import { formatRelativeClock } from '../format'
import { seatStateOf, SEAT_STATE_LABEL } from '../run/pool-view'
import { MessageContent } from '../MessageContent'
import { GroupCollaborationEntry } from './GroupCollaborationEntry'
import type { GroupCommunicationSummary } from './collaboration-map-view'

const TASK_LABEL: Record<TaskStatus, string> = {
  queued: '待领取',
  leased: '已领取',
  running: '执行中',
  review: '待验收',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}
const RECEIPT_LABEL = {
  queued: '待送达',
  notified: '已投递',
  read: '已读',
  acknowledged: '已确认',
  responded: '已回复',
  uncertain: '待核对',
  failed: '投递失败'
} as const

export interface GroupContextPanelProps {
  view: GroupContextView
  onOpenSession: (channelId: string) => void
  onManageGroup: (groupId?: string) => void
  onPlanTask: (groupId: string, task: PlanTaskInput) => Promise<void>
  communication?: GroupCommunicationSummary
  onOpenCollaboration?: (groupId: string) => void
}

/** Existing team/task services own mutations. This panel owns only local drafts, folds and scoped projections. */
export function GroupContextPanel({
  view,
  onOpenSession,
  onManageGroup,
  onPlanTask,
  communication,
  onOpenCollaboration
}: GroupContextPanelProps): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [taskLimit, setTaskLimit] = useState(40)
  const [messageLimit, setMessageLimit] = useState(30)
  const titleRef = useRef<HTMLInputElement>(null)
  const createRef = useRef<HTMLButtonElement>(null)
  const wasCreating = useRef(false)
  const busy = useRef(false)
  const mounted = useRef(true)
  const requestKey = useRef<{ payload: string; key: string } | undefined>(undefined)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (creating) titleRef.current?.focus()
    else if (wasCreating.current) createRef.current?.focus({ preventScroll: true })
    wasCreating.current = creating
  }, [creating])
  useEffect(() => {
    if (!view.mutable) setCreating(false)
  }, [view.mutable])
  const group = view.group
  if (!group)
    return (
      <section className="group-context group-context--empty">
        <h2>当前是独立会话</h2>
        <p>将现有会话组成协作组，即可在这里查看共同目标、任务和组内消息。</p>
        <button type="button" className="primary-button" onClick={() => onManageGroup()}>
          {view.canCreateGroup ? '组建协作组' : '查看运行'}
        </button>
      </section>
    )
  const members = group.members
  const memberLabel = (slotId: string) => {
    const member = members.find((item) => item.slot.id === slotId)
    return member
      ? `${member.role.name} · CH-${member.binding?.channelId ?? member.slot.channelId ?? '?'}`
      : '原组员'
  }
  const submit = async (): Promise<void> => {
    if (busy.current || !view.mutable) return
    if (!title.trim()) {
      setError('先填写任务名称')
      titleRef.current?.focus()
      return
    }
    if (target && !members.some((member) => member.slot.id === target)) {
      setError('所选成员已离组，请重新选择')
      return
    }
    const fields = { title: title.trim(), acceptance: acceptance.trim(), targetSlotId: target || undefined }
    const payload = JSON.stringify(fields)
    if (requestKey.current?.payload !== payload)
      requestKey.current = { payload, key: `operator:${crypto.randomUUID()}` }
    const task: PlanTaskInput = { ...fields, key: requestKey.current.key }
    busy.current = true
    setSaving(true)
    setError('')
    try {
      const existing = view.tasks.find((candidate) => candidate.key === task.key)
      if (!existing) await onPlanTask(group.group.id, task)
      if (!mounted.current) return
      setCreating(false)
      setTitle('')
      setAcceptance('')
      setTarget('')
      requestKey.current = undefined
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '任务未创建，草稿已保留')
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }
  return (
    <section className="group-context" aria-label={`协同组「${group.group.name}」`}>
      <header className="group-context__head">
        <div>
          <span className="group-context__eyebrow">协作组</span>
          <h2>{group.group.name}</h2>
        </div>
        <button type="button" className="run-link" onClick={() => onManageGroup(group.group.id)}>
          管理组
        </button>
      </header>
      <p className="group-context__meta">
        {members.length} 位成员<span>{view.planningLabel}</span>
        {!view.mutable ? <span>已结束 · 只读</span> : null}
      </p>
      <section className="group-context__section">
        <h3>共同目标</h3>
        <p className={group.group.goal ? 'group-context__goal' : 'group-context__goal is-empty'}>
          {group.group.goal
            ? group.group.goal.length > 220
              ? `${group.group.goal.slice(0, 220)}…`
              : group.group.goal
            : '尚未填写目标，可在管理组中补充。'}
        </p>
        {group.group.goal.length > 220 ? (
          <details className="group-context__goal-details">
            <summary>展开完整目标</summary>
            <p className="group-context__goal">{group.group.goal}</p>
          </details>
        ) : null}
      </section>
      {onOpenCollaboration ? <GroupCollaborationEntry groupName={group.group.name} members={members.length} summary={communication}
        onOpen={() => onOpenCollaboration(group.group.id)} /> : null}
      <section className="group-context__section">
        <h3>组内成员</h3>
        <ul className="group-context__members">
          {members.map((member) => {
            const channel = member.binding?.channelId ?? member.slot.channelId
            return (
              <li key={member.slot.id}>
                <button type="button" disabled={!channel} onClick={() => channel && onOpenSession(channel)}>
                  <AgentAvatar avatarId={member.slot.avatarId} name={member.role.name} size="sm" />
                  <span>
                    <strong>{member.role.name}</strong>
                    <small>
                      CH-{channel ?? '?'}
                      {member.slot.id === group.effectiveLeadSlotId ? ' · 主控' : ''}
                    </small>
                  </span>
                  <em className={view.mutable ? `is-${seatStateOf(member)}` : 'is-ended'}>
                    {view.mutable ? SEAT_STATE_LABEL[seatStateOf(member)] : '批次已结束'}
                  </em>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
      <section className="group-context__section">
        <header className="group-context__section-head">
          <h3 title="最近创建的任务在前">
            组任务 <small>{view.tasks.length}</small>
          </h3>
          {view.mutable ? (
            <button
              ref={createRef}
              type="button"
              className="run-link"
              aria-expanded={creating}
              onClick={() => setCreating(!creating)}
              disabled={saving}
            >
              新增任务
            </button>
          ) : null}
        </header>
        {creating ? (
          <form
            className="group-context__task-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label>
              任务名称
              <input
                ref={titleRef}
                name="task-title"
                autoComplete="off"
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={saving || !view.mutable}
                placeholder="例如：补齐接口边界测试…"
              />
            </label>
            <label>
              验收标准
              <textarea
                name="task-acceptance"
                rows={3}
                maxLength={8000}
                value={acceptance}
                onChange={(event) => setAcceptance(event.target.value)}
                disabled={saving || !view.mutable}
                placeholder="怎样判断这项任务已经完成…"
              />
            </label>
            <label>
              执行成员
              <MenuSelect
                ariaLabel="执行成员"
                value={target}
                disabled={saving || !view.mutable}
                options={[
                  { value: '', label: '由协作组分配' },
                  ...members.map((member) => ({ value: member.slot.id, label: memberLabel(member.slot.id) }))
                ]}
                onChange={setTarget}
              />
            </label>
            {error ? (
              <p role="alert" className="group-context__error">
                {error}
              </p>
            ) : null}
            <footer>
              <button
                type="button"
                className="secondary-button"
                disabled={saving}
                onClick={() => setCreating(false)}
              >
                收起草稿
              </button>
              <button type="submit" className="primary-button" disabled={saving || !view.mutable}>
                {saving ? '创建中…' : '创建任务'}
              </button>
            </footer>
          </form>
        ) : null}
        {view.tasks.length ? (
          <div className="group-context__tasks">
            {view.tasks.slice(0, taskLimit).map((task) => (
              <details key={task.id} className={`group-context__task is-${task.status}`}>
                <summary>
                  <span>{task.title}</span>
                  <em>{TASK_LABEL[task.status]}</em>
                </summary>
                <div>
                  {task.title.length > 90 ? (
                    <p>
                      <strong>完整任务名称</strong>
                      {task.title}
                    </p>
                  ) : null}
                  {task.assigneeSessionId ? (
                    <small>
                      执行：
                      {memberLabel(
                        members.find((member) => member.binding?.agentSessionId === task.assigneeSessionId)
                          ?.slot.id ?? ''
                      )}
                    </small>
                  ) : task.targetSlotId ? (
                    <small>指定成员：{memberLabel(task.targetSlotId)}</small>
                  ) : (
                    <small>由协作组分配</small>
                  )}
                  {task.description ? <p>{task.description}</p> : null}
                  {task.acceptance ? (
                    <p>
                      <strong>验收标准</strong>
                      {task.acceptance}
                    </p>
                  ) : null}
                  {task.result ? (
                    <p>
                      <strong>结果</strong>
                      {task.result}
                    </p>
                  ) : null}
                  {task.failureReason ? <p className="group-context__error">{task.failureReason}</p> : null}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p className="group-context__empty">
            尚无组任务。可由主控或具备规划权限的成员规划，也可由你直接创建。
          </p>
        )}
        {view.tasks.length > taskLimit ? (
          <button type="button" className="run-link" onClick={() => setTaskLimit((value) => value + 40)}>
            显示更多任务（剩余 {view.tasks.length - taskLimit}）
          </button>
        ) : null}
      </section>
      <section className="group-context__section">
        <header className="group-context__section-head">
          <h3>
            协作记录 <small>{view.messages.length}</small>
          </h3>
          {(communication?.pending ?? view.pendingReplies) ? (
            <small className="group-context__pending">组员待回应 {communication?.pending ?? view.pendingReplies}</small>
          ) : null}
        </header>
        {view.messages.length ? (
          <ol className="group-context__messages">
            {view.messages.slice(-messageLimit).map((message) => (
              <li key={message.id}>
                <header>
                  <strong>
                    {message.sender.type === 'operator'
                      ? message.kind === 'notice'
                        ? '拾光系统'
                        : '操作端'
                      : memberLabel(message.sender.slotId)}
                  </strong>
                  <time
                    dateTime={new Date(message.createdAt).toISOString()}
                    title={new Date(message.createdAt).toLocaleString()}
                  >
                    {formatRelativeClock(message.createdAt)}
                  </time>
                </header>
                <small className="group-context__recipient">
                  发给{' '}
                  {message.recipient.type === 'operator' ? '操作端' : memberLabel(message.recipient.slotId)}
                </small>
                <MessageContent text={message.content} />
                <small>
                  {isOrphanedReceipt(message.receipt)
                    ? '成员已离组 · 无需回应'
                    : RECEIPT_LABEL[teamMessageReceiptStage(message.receipt)]}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="group-context__empty">组员之间的指令、问题与回应会在这里同步，切换会话不影响记录。</p>
        )}
        {view.messages.length > messageLimit ? (
          <button type="button" className="run-link" onClick={() => setMessageLimit((value) => value + 30)}>
            查看更早的记录（{view.messages.length - messageLimit}）
          </button>
        ) : null}
      </section>
    </section>
  )
}
