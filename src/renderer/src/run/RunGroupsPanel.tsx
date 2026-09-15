import { useEffect, useState } from 'react'
import { TEAM_ROLE_TEMPLATES } from '../../../domain/team-control'
import type {
  CreateTeamGroupInput,
  TeamGroupGoalInput,
  TeamGroupLeadInput,
  TeamGroupMemberRef,
  TeamGroupMembersInput
} from '../../../shared/desktop-api'
import { formatRelativeClock } from '../format'
import { ReplaceRunSheet } from './ReplaceRunSheet'
import {
  SEAT_STATE_LABEL,
  groupActionConsequence,
  type ReplaceRunConsequence,
  type RunGroup,
  type RunUngroupedSeat,
  type RunView
} from './run-view'

/** 协作组的六个操作：全部由主进程落库并投递成员关系通知，这里只拿回最新快照。 */
export interface RunGroupActions {
  createGroup: (input: CreateTeamGroupInput) => Promise<unknown>
  addGroupMembers: (input: TeamGroupMembersInput) => Promise<unknown>
  removeGroupMember: (input: TeamGroupMemberRef) => Promise<unknown>
  setGroupLead: (input: TeamGroupLeadInput) => Promise<unknown>
  updateGroupGoal: (input: TeamGroupGoalInput) => Promise<unknown>
  dissolveGroup: (input: { groupId: string }) => Promise<unknown>
}

interface RunGroupsPanelProps {
  view: RunView
  busy: boolean
  /** 池已结束：不再建组 / 加人 / 换 lead，仍可移出与解散以收拾残局。 */
  ended: boolean
  actions?: RunGroupActions
}

type Drawer = { kind: 'create' } | { kind: 'add'; group: RunGroup }

interface PendingConfirm {
  consequence: ReplaceRunConsequence
  perform: () => Promise<unknown>
}

const DEFAULT_ROLE_TEMPLATE = 'specialist'
/** 组内角色只从团队模板里选；solo 是独立席位的专属模板，不能作为组内角色。 */
const GROUP_ROLE_TEMPLATES = TEAM_ROLE_TEMPLATES.filter((template) => template.key !== 'solo')
const NO_LEAD = ''

interface MemberDraft {
  selected: boolean
  roleTemplateKey: string
}

/**
 * 会话池 · 协作组（阶段 1 最小 UI，只为实机验收；阶段 3 与会话名册合一重做）。
 * 组卡片：名称 / 目标 / 成员（角色 + CH-N + 状态点）/ lead / attention；操作：加人、移出、换 lead、改目标、解散。
 * 建组与加人共用一张抽屉；移出与解散各要一次确认（复用 ReplaceRunSheet 的结构与文案骨架）。
 */
export function RunGroupsPanel({ view, busy, ended, actions }: RunGroupsPanelProps): React.JSX.Element | null {
  const [drawer, setDrawer] = useState<Drawer | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [editingGoal, setEditingGoal] = useState<{ groupId: string; goal: string } | null>(null)

  const runId = view.run?.id
  useEffect(() => {
    setDrawer(null)
    setConfirm(null)
    setEditingGoal(null)
    setError('')
  }, [runId])

  if (!actions || view.mode !== 'independent') return null
  const disabled = busy || pending
  const active = view.groups.filter((group) => group.status === 'active')
  const dissolved = view.groups.filter((group) => group.status === 'dissolved')

  const perform = async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (pending) return false
    setPending(true)
    setError('')
    try {
      await operation()
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setPending(false)
    }
  }
  const ask = (consequence: ReplaceRunConsequence, operation: () => Promise<unknown>): void => {
    if (disabled) return
    setConfirm({ consequence, perform: operation })
  }

  return (
    <section className="run-groups" aria-label="协作组">
      <header className="run-section-head">
        <strong>协作组</strong>
        <span>{active.length ? `${active.length} 个组 · ${view.ungroupedSeats.length} 个独立席位` : '池内会话默认独立；随时可把几个会话组成一组协作'}</span>
        {!ended ? (
          <button
            type="button"
            className="run-link"
            disabled={disabled || !view.ungroupedSeats.length || drawer?.kind === 'create'}
            title={view.ungroupedSeats.length ? undefined : '没有未入组的席位'}
            onClick={() => { setDrawer({ kind: 'create' }); setConfirm(null) }}
          >
            建组
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="run-callout is-warning" role="alert">{error}</p>
      ) : null}

      {drawer ? (
        <GroupDrawer
          key={drawer.kind === 'add' ? `add:${drawer.group.id}` : 'create'}
          drawer={drawer}
          candidates={view.ungroupedSeats}
          disabled={disabled}
          onCancel={() => setDrawer(null)}
          onSubmit={async (input) => {
            const ok = await perform(() => drawer.kind === 'create'
              ? actions.createGroup(input)
              : actions.addGroupMembers({ groupId: drawer.group.id, members: input.members }))
            if (ok) setDrawer(null)
          }}
        />
      ) : null}

      {confirm ? (
        <ReplaceRunSheet
          consequence={confirm.consequence}
          busy={disabled}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { perform: operation } = confirm
            setConfirm(null)
            void perform(operation)
          }}
        />
      ) : null}

      {active.length || dissolved.length ? (
        <ul className="run-group-list">
          {[...active, ...dissolved].map((group) => (
            <li key={group.id} className={`run-group${group.status === 'dissolved' ? ' is-dissolved' : ''}${group.attention ? ' is-attention' : ''}`}>
              <header className="run-group__head">
                <div className="run-group__title">
                  <strong>{group.name}</strong>
                  {group.status === 'dissolved' ? (
                    <em className="run-group__tag is-muted">已解散 · {formatRelativeClock(group.dissolvedAt ?? group.updatedAt)}</em>
                  ) : group.attention ? (
                    <em className="run-group__tag is-warning">有成员离线</em>
                  ) : (
                    <em className="run-group__tag">{group.members.length} 名成员</em>
                  )}
                </div>
                {group.status === 'active' ? (
                  <div className="run-group__actions">
                    {!ended ? (
                      <button
                        type="button"
                        className="run-link"
                        disabled={disabled || !view.ungroupedSeats.length}
                        title={view.ungroupedSeats.length ? undefined : '没有未入组的席位'}
                        onClick={() => { setDrawer({ kind: 'add', group }); setConfirm(null) }}
                      >
                        加人
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="run-link is-danger"
                      disabled={disabled}
                      onClick={() => ask(groupActionConsequence({ kind: 'dissolve', group }), () => actions.dissolveGroup({ groupId: group.id }))}
                    >
                      解散
                    </button>
                  </div>
                ) : null}
              </header>

              {editingGoal?.groupId === group.id ? (
                <form
                  className="run-group__goal-editor"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void perform(() => actions.updateGroupGoal({ groupId: group.id, goal: editingGoal.goal })).then((ok) => {
                      if (ok) setEditingGoal(null)
                    })
                  }}
                >
                  <textarea
                    aria-label="组目标"
                    rows={2}
                    value={editingGoal.goal}
                    disabled={disabled}
                    onChange={(event) => setEditingGoal({ groupId: group.id, goal: event.target.value })}
                  />
                  <footer>
                    <button type="button" className="secondary-button" disabled={disabled} onClick={() => setEditingGoal(null)}>取消</button>
                    <button type="submit" className="primary-button" disabled={disabled}>保存目标</button>
                  </footer>
                </form>
              ) : (
                <p className={`run-group__goal${group.goal ? '' : ' is-empty'}`}>
                  {group.goal || '未填写组目标'}
                  {group.status === 'active' && !ended ? (
                    <button type="button" className="run-link" disabled={disabled} onClick={() => setEditingGoal({ groupId: group.id, goal: group.goal })}>改目标</button>
                  ) : null}
                </p>
              )}

              {group.members.length ? (
                <ul className="run-group__members">
                  {group.members.map((member) => {
                    const leadBlocked = member.isLead && group.members.length > 1
                    return (
                      <li key={member.slotId} className="run-group-member">
                        <i className={`run-group-member__dot is-${member.state}`} title={SEAT_STATE_LABEL[member.state]} aria-label={SEAT_STATE_LABEL[member.state]} />
                        <span className="run-group-member__who">
                          <strong>CH-{member.channelId}</strong>
                          <small>{member.roleName}</small>
                          {member.isLead ? <em className="run-group-member__lead">lead</em> : null}
                        </span>
                        {group.status === 'active' ? (
                          <button
                            type="button"
                            className="run-link"
                            disabled={disabled || leadBlocked}
                            title={leadBlocked ? '它是本组 lead：先指定新 lead 再移出' : undefined}
                            onClick={() => ask(groupActionConsequence({ kind: 'remove', group, member }), () => actions.removeGroupMember({ groupId: group.id, slotId: member.slotId }))}
                          >
                            移出
                          </button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="run-group__empty">{group.status === 'active' ? '组内暂无成员：加人，或解散本组。' : '成员已全部恢复独立。'}</p>
              )}

              {group.status === 'active' && !ended && group.members.length ? (
                <label className="run-group__lead">
                  <span>lead</span>
                  <select
                    aria-label={`「${group.name}」的 lead`}
                    value={group.leadSlotId ?? NO_LEAD}
                    disabled={disabled}
                    onChange={(event) => {
                      const slotId = event.target.value || null
                      void perform(() => actions.setGroupLead({ groupId: group.id, slotId }))
                    }}
                  >
                    <option value={NO_LEAD}>无 lead（只共享目标、消息与记忆）</option>
                    {group.members.map((member) => (
                      <option key={member.slotId} value={member.slotId}>CH-{member.channelId} · {member.roleName}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

interface GroupDrawerProps {
  drawer: Drawer
  candidates: RunUngroupedSeat[]
  disabled: boolean
  onCancel: () => void
  onSubmit: (input: CreateTeamGroupInput) => Promise<void>
}

/** 建组 / 加人抽屉：勾选未入组席位 + 每人一个组内角色模板；建组另有名称、目标与可空的 lead。 */
function GroupDrawer({ drawer, candidates, disabled, onCancel, onSubmit }: GroupDrawerProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [leadSlotId, setLeadSlotId] = useState(NO_LEAD)
  const [drafts, setDrafts] = useState<Record<string, MemberDraft>>({})
  const selected = candidates.filter((seat) => drafts[seat.slotId]?.selected)
  const creating = drawer.kind === 'create'
  const canSubmit = selected.length > 0 && (!creating || name.trim().length > 0)
  const effectiveLead = selected.some((seat) => seat.slotId === leadSlotId) ? leadSlotId : NO_LEAD

  const toggle = (slotId: string): void => {
    setDrafts((current) => {
      const draft = current[slotId] ?? { selected: false, roleTemplateKey: DEFAULT_ROLE_TEMPLATE }
      return { ...current, [slotId]: { ...draft, selected: !draft.selected } }
    })
  }
  const setRole = (slotId: string, roleTemplateKey: string): void => {
    setDrafts((current) => ({ ...current, [slotId]: { selected: current[slotId]?.selected ?? true, roleTemplateKey } }))
  }

  return (
    <form
      className="run-group-drawer"
      aria-label={creating ? '建组' : `向「${drawer.group.name}」加人`}
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSubmit || disabled) return
        void onSubmit({
          name: name.trim(),
          goal: goal.trim() || undefined,
          leadSlotId: effectiveLead || undefined,
          members: selected.map((seat) => ({ slotId: seat.slotId, roleTemplateKey: drafts[seat.slotId]!.roleTemplateKey }))
        })
      }}
    >
      <header className="run-section-head">
        <strong>{creating ? '新建协作组' : `向「${drawer.group.name}」加人`}</strong>
        <span>{creating ? '入组不重建会话：成员在下一次轮询收到入组通知并领取简报' : '新成员在下一次轮询收到入组通知'}</span>
      </header>
      {creating ? (
        <>
          <label className="run-group-drawer__field">
            <span>组名</span>
            <input type="text" value={name} maxLength={80} placeholder="例如：验收组" disabled={disabled} autoFocus onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="run-group-drawer__field">
            <span>组目标</span>
            <textarea rows={2} value={goal} maxLength={8_000} placeholder="一句话说清这组要做什么（可稍后改）" disabled={disabled} onChange={(event) => setGoal(event.target.value)} />
          </label>
        </>
      ) : null}
      <fieldset className="run-group-drawer__members" disabled={disabled}>
        <legend>成员（{selected.length} / {candidates.length}）</legend>
        {candidates.map((seat) => {
          const draft = drafts[seat.slotId]
          return (
            <div key={seat.slotId} className={`run-group-drawer__member${draft?.selected ? ' is-selected' : ''}`}>
              <label>
                <input type="checkbox" checked={draft?.selected ?? false} onChange={() => toggle(seat.slotId)} />
                <i className={`run-group-member__dot is-${seat.state}`} aria-hidden="true" />
                <strong>CH-{seat.channelId}</strong>
                <small>{seat.name} · {SEAT_STATE_LABEL[seat.state]}</small>
              </label>
              <select
                aria-label={`CH-${seat.channelId} 的组内角色`}
                value={draft?.roleTemplateKey ?? DEFAULT_ROLE_TEMPLATE}
                disabled={!draft?.selected}
                onChange={(event) => setRole(seat.slotId, event.target.value)}
              >
                {GROUP_ROLE_TEMPLATES.map((template) => (
                  <option key={template.key} value={template.key}>{template.name}</option>
                ))}
              </select>
              {creating ? (
                <label className="run-group-drawer__lead-pick" title="设为 lead">
                  <input
                    type="radio"
                    name="group-lead"
                    value={seat.slotId}
                    checked={effectiveLead === seat.slotId}
                    disabled={!draft?.selected}
                    onChange={() => setLeadSlotId(seat.slotId)}
                  />
                  <span>lead</span>
                </label>
              ) : null}
            </div>
          )
        })}
        {creating ? (
          <label className="run-group-drawer__lead-pick is-none">
            <input type="radio" name="group-lead" value={NO_LEAD} checked={effectiveLead === NO_LEAD} onChange={() => setLeadSlotId(NO_LEAD)} />
            <span>无 lead：只共享目标、消息与记忆，没有任务板调度</span>
          </label>
        ) : null}
      </fieldset>
      <footer className="run-group-drawer__actions">
        <button type="button" className="secondary-button" disabled={disabled} onClick={onCancel}>取消</button>
        <button type="submit" className="primary-button" disabled={disabled || !canSubmit}>
          {creating ? `建组（${selected.length}）` : `加入（${selected.length}）`}
        </button>
      </footer>
    </form>
  )
}
