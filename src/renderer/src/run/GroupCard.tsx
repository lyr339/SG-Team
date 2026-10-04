import { useEffect, useRef, useState, type Ref } from 'react'
import { formatRelativeClock } from '../format'
import { AgentAvatar } from '../AgentAvatar'
import type { TeamGroupPlanPolicy } from '../../../domain/team-control'
// 应用里唯一的「⋯」动作菜单——名字来自它的出生地（账号卡片），行为是通用的：触发器 + 弹层 + 进行中文案。
import { AccountActionsMenu } from '../settings/AccountActionsMenu'
import { MenuSelect } from '../lobby/MenuSelect'
import { SEAT_STATE_LABEL, type PoolGroup, type PoolGroupMember } from './pool-view'
import { GroupCollaborationEntry } from '../team/GroupCollaborationEntry'
import type { GroupCommunicationSummary } from '../team/collaboration-map-view'

const NO_LEAD = ''

export interface GroupCardProps {
  /** 卡片根元素：页面用它把会话头部跳转来的组滚入视野。 */
  ref?: Ref<HTMLElement>
  group: PoolGroup
  busy: boolean
  /** 池已结束：不再加人 / 换 lead / 改目标，仍可移出与解散以收拾残局。 */
  ended: boolean
  /** 从会话头部的组名跳转而来：卡片滚入视野并短暂点亮。 */
  focused?: boolean
  onAddMembers: () => void
  onRemoveMember: (member: PoolGroupMember) => void
  /** 离线成员的组身份迁移（交接给池内独立席位，可附带上下文）。 */
  onTransferMembership?: (member: PoolGroupMember) => void
  onSetLead: (slotId: string | null) => void
  onSetPlanPolicy?: (policy: TeamGroupPlanPolicy) => void
  /** 保存组目标；返回是否成功（成功即收起编辑器，失败由页面提示条说明）。 */
  onUpdateGoal: (goal: string) => Promise<boolean>
  onDissolve: () => void
  onOpenSession?: (channelId: string) => void
  communication?: GroupCommunicationSummary
  onOpenCollaboration?: () => void
}

/**
 * 协作组卡片：名称 / 目标 / 成员（角色 + CH-N + 状态点 + lead 徽标）/ 任务计数。
 * active 组可操作（加人、移出、交接、换 lead、改目标、解散——破坏性动作由页面统一确认）；
 * 已解散的组只读展示 24 小时。离线成员行直接给出「交接 / 移出」两个决定，不再藏在展开里。
 */
export function GroupCard({
  ref,
  group,
  busy,
  ended,
  focused,
  onAddMembers,
  onRemoveMember,
  onTransferMembership,
  onSetLead,
  onSetPlanPolicy,
  onUpdateGoal,
  onDissolve,
  onOpenSession,
  communication,
  onOpenCollaboration
}: GroupCardProps): React.JSX.Element {
  const [editingGoal, setEditingGoal] = useState<string>()
  const [savingGoal, setSavingGoal] = useState(false)
  const [goalError, setGoalError] = useState('')
  const savingRef = useRef(false)
  const goalEpoch = useRef(0)
  const dissolved = group.status === 'dissolved'
  const disabled = busy || savingGoal

  useEffect(() => () => { goalEpoch.current += 1 }, [group.id])

  // 组解散 / 池结束时收起编辑器，避免对不可改的组悬着一个表单。
  useEffect(() => {
    if (dissolved || ended) {
      goalEpoch.current += 1
      setEditingGoal(undefined); setGoalError(''); setSavingGoal(false); savingRef.current = false
    }
  }, [dissolved, ended])

  const counters = group.counters
  const hasTasks = counters.open + counters.review + counters.done + (counters.failed ?? 0) + (counters.cancelled ?? 0) > 0
  const editGoal = (): void => { setGoalError(''); setEditingGoal(group.goal) }
  const saveGoal = async (): Promise<void> => {
    if (editingGoal === undefined || disabled || savingRef.current || dissolved || ended) return
    savingRef.current = true; setSavingGoal(true); setGoalError('')
    const epoch = goalEpoch.current
    try {
      const ok = await onUpdateGoal(editingGoal.trim())
      if (epoch !== goalEpoch.current) return
      if (ok) setEditingGoal(undefined)
      else setGoalError('目标未保存，草稿已保留，请重试')
    } catch (error) {
      if (epoch === goalEpoch.current) setGoalError(error instanceof Error ? error.message : '目标保存失败，请重试')
    } finally {
      if (epoch === goalEpoch.current) { savingRef.current = false; setSavingGoal(false) }
    }
  }

  return (
    <article
      ref={ref}
      className={`group-card${dissolved ? ' is-dissolved' : ''}${group.attention ? ' is-attention' : ''}${focused ? ' is-focused' : ''}`}
      data-group-id={group.id}
      aria-label={`协作组「${group.name}」`}
    >
      <header className="group-card__head">
        <div className="group-card__title">
          <strong>{group.name}</strong>
          {dissolved ? (
            <em className="group-card__tag is-muted">已解散 · {formatRelativeClock(group.dissolvedAt ?? group.updatedAt)}</em>
          ) : group.attention ? (
            <em className="group-card__tag is-warning" title="有成员已确认离线：交接给其他席位，或移出组">成员离线</em>
          ) : (
            <em className="group-card__tag">{group.members.length} 名成员</em>
          )}
        </div>
        {!dissolved ? (
          <div className="group-card__head-actions">
            {!ended ? (
              <button type="button" className="run-link" disabled={disabled} onClick={onAddMembers}>加人</button>
            ) : null}
            <AccountActionsMenu
              label={`「${group.name}」的更多操作`}
              actions={[
                ...(!ended ? [{
                  key: 'goal',
                  label: group.goal ? '改目标' : '写目标',
                  disabled,
                  onSelect: editGoal
                }] : []),
                { key: 'dissolve', label: '解散本组…', disabled, onSelect: onDissolve }
              ]}
            />
          </div>
        ) : null}
      </header>

      {editingGoal !== undefined ? (
        <form
          className="group-card__goal-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void saveGoal()
          }}
        >
          <textarea
            aria-label="组目标"
            name="group-goal"
            autoComplete="off"
            rows={2}
            value={editingGoal}
            maxLength={8_000}
            disabled={disabled}
            autoFocus
            onChange={(event) => setEditingGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              // 多行输入：Enter 换行，⌘/Ctrl+Enter 保存，Esc 放弃——与会话输入框同一套键位。
              if (event.key === 'Escape') {
                event.stopPropagation()
                setEditingGoal(undefined)
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void saveGoal()
              }
            }}
          />
          <footer>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => setEditingGoal(undefined)}>取消</button>
            <button type="submit" className="primary-button" disabled={disabled}>{savingGoal ? '保存中…' : '保存目标'}</button>
          </footer>
          {goalError ? <p className="group-card__error" role="alert">{goalError}</p> : null}
        </form>
      ) : (
        <p className={`group-card__goal${group.goal ? '' : ' is-empty'}`} title={group.goal || undefined}>
          {group.goal || '未填写组目标'}
          {!group.goal && !dissolved && !ended ? <button type="button" className="run-link" disabled={disabled} onClick={editGoal}>补充目标</button> : null}
        </p>
      )}

      {onOpenCollaboration ? <GroupCollaborationEntry groupName={group.name} members={group.members.length} summary={communication} onOpen={onOpenCollaboration} /> : null}

      {group.members.length ? (
        <ul className="group-card__members">
          {group.members.map((member) => {
            const leadBlocked = member.isLead && group.members.length > 1
            const offline = member.state === 'offline'
            return (
              <li key={member.slotId} className={`group-card-member${offline ? ' is-offline' : ''}`}>
                <AgentAvatar avatarId={member.avatarId} name={member.roleName} size="sm" />
                {onOpenSession ? (
                  <button type="button" className="group-card-member__who" title={`打开 CH-${member.channelId} 的会话`} onClick={() => onOpenSession(member.channelId)}>
                    <strong>{member.roleName}</strong>
                    <small>CH-{member.channelId}</small>
                    {member.isLead ? <em className="group-card-member__lead">主控</em> : null}
                  </button>
                ) : (
                  <span className="group-card-member__who">
                    <strong>{member.roleName}</strong>
                    <small>CH-{member.channelId}</small>
                    {member.isLead ? <em className="group-card-member__lead">主控</em> : null}
                  </span>
                )}
                <span className={`group-card-member__state is-${member.state}`}>{SEAT_STATE_LABEL[member.state]}</span>
                {!dissolved ? (
                  <span className="group-card-member__actions">
                    {!ended && offline && onTransferMembership ? (
                      <button
                        type="button"
                        className="run-link"
                        disabled={disabled}
                        title="把组身份（组角色与 lead）交接给池内其他独立席位，可同时交接上下文文档"
                        onClick={() => onTransferMembership(member)}
                      >
                        交接…
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="run-link"
                      disabled={disabled || leadBlocked}
                      title={leadBlocked ? '它是本组 lead：先指定新 lead 再移出' : undefined}
                      onClick={() => onRemoveMember(member)}
                    >
                      移出
                    </button>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="group-card__empty">{dissolved ? '成员已全部恢复独立。' : '组内暂无成员：加人，或解散本组。'}</p>
      )}

      {group.members.length || hasTasks ? (
        <footer className="group-card__foot">
          {!ended && !dissolved && group.members.length ? (
            <label className="group-card__lead">
              <span>主控</span>
              <MenuSelect
                ariaLabel={`「${group.name}」的 lead`}
                value={group.leadSlotId ?? NO_LEAD}
                disabled={disabled}
                menuMinWidth={200}
                options={[
                  { value: NO_LEAD, label: '无主控' },
                  ...group.members.map((member) => ({ value: member.slotId, label: `CH-${member.channelId} · ${member.roleName}` }))
                ]}
                onChange={(value) => onSetLead(value || null)}
              />
            </label>
          ) : null}
          {!ended && !dissolved && group.members.length && !group.leadSlotId ? (
            <label className="group-card__policy">
              <span>任务规划</span>
              {onSetPlanPolicy ? <MenuSelect ariaLabel={`「${group.name}」的任务规划权限`}
                value={group.planPolicy ?? 'any_member'} disabled={disabled}
                options={[{ value: 'any_member', label: '成员可规划' }, { value: 'lead_only', label: '仅用户规划' }]}
                onChange={(value) => onSetPlanPolicy(value as TeamGroupPlanPolicy)} />
                : <span>{group.planPolicy === 'lead_only' ? '仅用户规划' : '成员可规划'}</span>}
            </label>
          ) : null}
          {hasTasks ? (
            <span className="group-card__counters" title="本组任务板：未完成 / 待验收 / 已完成">
              {counters.open ? <em className="is-open">待完成 {counters.open}</em> : null}
              {counters.review ? <em className="is-review">验收 {counters.review}</em> : null}
              {counters.done ? <em className="is-done">完成 {counters.done}</em> : null}
              {counters.failed ? <em className="is-failed">失败 {counters.failed}</em> : null}
              {counters.cancelled ? <em className="is-cancelled">已取消 {counters.cancelled}</em> : null}
            </span>
          ) : null}
        </footer>
      ) : null}
    </article>
  )
}
