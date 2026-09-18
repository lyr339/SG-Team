import { useEffect, useState } from 'react'
import { formatRelativeClock } from '../format'
import { AccountActionsMenu } from '../settings/AccountActionsMenu'
import { MenuSelect } from '../lobby/MenuSelect'
import { SEAT_STATE_LABEL, type PoolGroup, type PoolGroupMember } from './pool-view'

const NO_LEAD = ''

export interface GroupCardProps {
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
  /** 保存组目标；返回是否成功（成功即收起编辑器，失败由页面提示条说明）。 */
  onUpdateGoal: (goal: string) => Promise<boolean>
  onDissolve: () => void
  onOpenSession?: (channelId: string) => void
}

/**
 * 协作组卡片：名称 / 目标 / 成员（角色 + CH-N + 状态点 + lead 徽标）/ 任务计数。
 * active 组可操作（加人、移出、交接、换 lead、改目标、解散——破坏性动作由页面统一确认）；
 * 已解散的组只读展示 24 小时。离线成员行直接给出「交接 / 移出」两个决定，不再藏在展开里。
 */
export function GroupCard({
  group,
  busy,
  ended,
  focused,
  onAddMembers,
  onRemoveMember,
  onTransferMembership,
  onSetLead,
  onUpdateGoal,
  onDissolve,
  onOpenSession
}: GroupCardProps): React.JSX.Element {
  const [editingGoal, setEditingGoal] = useState<string>()
  const dissolved = group.status === 'dissolved'
  const disabled = busy

  // 组解散 / 池结束时收起编辑器，避免对不可改的组悬着一个表单。
  useEffect(() => {
    if (dissolved || ended) setEditingGoal(undefined)
  }, [dissolved, ended])

  const counters = group.counters
  const hasTasks = counters.open + counters.review + counters.done > 0

  return (
    <article
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
                  onSelect: () => setEditingGoal(group.goal)
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
            void onUpdateGoal(editingGoal.trim()).then((ok) => {
              if (ok) setEditingGoal(undefined)
            })
          }}
        >
          <textarea
            aria-label="组目标"
            rows={2}
            value={editingGoal}
            maxLength={8_000}
            disabled={disabled}
            autoFocus
            onChange={(event) => setEditingGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setEditingGoal(undefined)
              }
            }}
          />
          <footer>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => setEditingGoal(undefined)}>取消</button>
            <button type="submit" className="primary-button" disabled={disabled}>保存目标</button>
          </footer>
        </form>
      ) : (
        <p className={`group-card__goal${group.goal ? '' : ' is-empty'}`} title={group.goal || undefined}>
          {group.goal || (dissolved ? '未填写组目标' : '未填写组目标——在「⋯」里补一句，成员简报会带上它')}
        </p>
      )}

      {group.members.length ? (
        <ul className="group-card__members">
          {group.members.map((member) => {
            const leadBlocked = member.isLead && group.members.length > 1
            const offline = member.state === 'offline'
            return (
              <li key={member.slotId} className={`group-card-member${offline ? ' is-offline' : ''}`}>
                <i className={`seat-dot is-${member.state}`} role="img" title={SEAT_STATE_LABEL[member.state]} aria-label={SEAT_STATE_LABEL[member.state]} />
                {onOpenSession ? (
                  <button type="button" className="group-card-member__who" title={`打开 CH-${member.channelId} 的会话`} onClick={() => onOpenSession(member.channelId)}>
                    <strong>CH-{member.channelId}</strong>
                    <small>{member.roleName}</small>
                    {member.isLead ? <em className="group-card-member__lead">lead</em> : null}
                  </button>
                ) : (
                  <span className="group-card-member__who">
                    <strong>CH-{member.channelId}</strong>
                    <small>{member.roleName}</small>
                    {member.isLead ? <em className="group-card-member__lead">lead</em> : null}
                  </span>
                )}
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

      {!dissolved && group.members.length ? (
        <footer className="group-card__foot">
          {!ended ? (
            <label className="group-card__lead">
              <span>lead</span>
              <MenuSelect
                ariaLabel={`「${group.name}」的 lead`}
                value={group.leadSlotId ?? NO_LEAD}
                disabled={disabled}
                menuMinWidth={200}
                options={[
                  { value: NO_LEAD, label: '无 lead' },
                  ...group.members.map((member) => ({ value: member.slotId, label: `CH-${member.channelId} · ${member.roleName}` }))
                ]}
                onChange={(value) => onSetLead(value || null)}
              />
            </label>
          ) : null}
          {hasTasks ? (
            <span className="group-card__counters" title="本组任务板：未完成 / 待验收 / 已完成">
              {counters.open ? <em className="is-open">进行 {counters.open}</em> : null}
              {counters.review ? <em className="is-review">验收 {counters.review}</em> : null}
              {counters.done ? <em className="is-done">完成 {counters.done}</em> : null}
            </span>
          ) : null}
        </footer>
      ) : null}
    </article>
  )
}
