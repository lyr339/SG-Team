import { useEffect, useRef, useState } from 'react'
import { TEAM_ROLE_TEMPLATES } from '../../../domain/team-control'
import type { CreateTeamGroupInput, TeamGroupMembersInput } from '../../../shared/desktop-api'
import { AgentAvatar } from '../AgentAvatar'
import { MenuSelect } from '../lobby/MenuSelect'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { SEAT_STATE_LABEL, type UngroupedSeat } from './pool-view'

/** 建组：可带名册多选预勾的通道；加人：目标组。 */
export type GroupComposerMode =
  | { kind: 'create'; preselectedChannelIds?: readonly string[] }
  | { kind: 'add'; groupId: string; groupName: string }

interface GroupComposerProps {
  mode: GroupComposerMode
  /** 池内未入组席位（建组 / 加人的候选面一致）。 */
  candidates: UngroupedSeat[]
  /** 建组时组名的默认值（「组 N」）。 */
  defaultName: string
  busy: boolean
  error?: string
  onClose: () => void
  onCreate: (input: CreateTeamGroupInput) => void
  onAddMembers: (input: TeamGroupMembersInput) => void
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
 * 建组 / 加人抽屉：右侧滑入（220ms，reduced-motion 关闭），名册多选与运行页共用一个实例。
 * 建组：组名（必填）、目标、成员表（头像 + 名称 CH-N + 组内角色）、lead 单选（可无 lead）、
 * 无 lead 时的任务规划策略；加人：只有成员表。确认即入组——成员在下一次轮询收到入组通知，
 * 不重建会话。抽屉内不做拖拽。
 */
export function GroupComposer({
  mode,
  candidates,
  defaultName,
  busy,
  error,
  onClose,
  onCreate,
  onAddMembers
}: GroupComposerProps): React.JSX.Element {
  const creating = mode.kind === 'create'
  const preselected = creating ? new Set(mode.preselectedChannelIds ?? []) : undefined
  const [name, setName] = useState(creating ? defaultName : '')
  const [goal, setGoal] = useState('')
  const [leadSlotId, setLeadSlotId] = useState(NO_LEAD)
  const [membersMayPlan, setMembersMayPlan] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, MemberDraft>>(() => Object.fromEntries(
    candidates
      .filter((seat) => preselected?.has(seat.channelId))
      .map((seat) => [seat.slotId, { selected: true, roleTemplateKey: DEFAULT_ROLE_TEMPLATE }])
  ))
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) nameRef.current?.focus({ preventScroll: true })
  }, [creating])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [busy, onClose])

  const selected = candidates.filter((seat) => drafts[seat.slotId]?.selected)
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

  const submit = (): void => {
    if (!canSubmit || busy) return
    const members = selected.map((seat) => ({ slotId: seat.slotId, roleTemplateKey: drafts[seat.slotId]!.roleTemplateKey }))
    if (!creating) {
      onAddMembers({ groupId: mode.groupId, members })
      return
    }
    onCreate({
      name: name.trim(),
      goal: goal.trim() || undefined,
      leadSlotId: effectiveLead || undefined,
      // 有 lead 时策略不生效（规划权归有效 lead），省略让服务端取默认；
      // 无 lead 时把开关的选择显式带上（关闭 = 组内无人能规划，任务只能由用户在拾光创建）。
      planPolicy: effectiveLead ? undefined : membersMayPlan ? 'any_member' : 'lead_only',
      members
    })
  }

  return (
    <div
      className="group-composer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form
        className="group-composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-composer-title"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <header className="group-composer__head">
          <div>
            <strong id="group-composer-title">{creating ? '新建协作组' : `向「${mode.kind === 'add' ? mode.groupName : ''}」加人`}</strong>
            <span>{creating ? '入组不重建会话：成员在下一次轮询收到入组通知并领取简报' : '新成员在下一次轮询收到入组通知'}</span>
          </div>
          <button type="button" className="group-composer__close" disabled={busy} aria-label="关闭抽屉" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" /></svg>
          </button>
        </header>

        <div className="group-composer__body">
          {creating ? (
            <>
              <label className="group-composer__field">
                <span>组名</span>
                <input
                  ref={nameRef}
                  type="text"
                  value={name}
                  maxLength={80}
                  placeholder="例如：验收组"
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="group-composer__field">
                <span>组目标</span>
                <textarea
                  rows={2}
                  value={goal}
                  maxLength={8_000}
                  placeholder="一句话说清这组要做什么（可稍后改）"
                  disabled={busy}
                  onChange={(event) => setGoal(event.target.value)}
                />
              </label>
            </>
          ) : null}

          <fieldset className="group-composer__members" disabled={busy}>
            <legend>成员（{selected.length} / {candidates.length}）</legend>
            {candidates.map((seat) => {
              const draft = drafts[seat.slotId]
              const checked = draft?.selected ?? false
              return (
                <div key={seat.slotId} className={`group-composer__member${checked ? ' is-selected' : ''}`}>
                  <label className="group-composer__member-pick">
                    <input type="checkbox" checked={checked} onChange={() => toggle(seat.slotId)} />
                    {seat.avatarId
                      ? <AgentAvatar avatarId={seat.avatarId} name={seat.name} size="sm" />
                      : <i className={`seat-dot is-${seat.state}`} aria-hidden="true" />}
                    <span className="group-composer__member-who">
                      <strong>{seat.name} · CH-{seat.channelId}</strong>
                      <small>{SEAT_STATE_LABEL[seat.state]}</small>
                    </span>
                  </label>
                  <MenuSelect
                    ariaLabel={`CH-${seat.channelId} 的组内角色`}
                    value={draft?.roleTemplateKey ?? DEFAULT_ROLE_TEMPLATE}
                    disabled={!checked}
                    menuMinWidth={148}
                    options={GROUP_ROLE_TEMPLATES.map((template) => ({ value: template.key, label: template.name }))}
                    onChange={(value) => setRole(seat.slotId, value)}
                  />
                  {creating ? (
                    <label className={`group-composer__lead-pick${effectiveLead === seat.slotId ? ' is-checked' : ''}`} title="设为本组 lead">
                      <input
                        type="radio"
                        name="group-composer-lead"
                        value={seat.slotId}
                        checked={effectiveLead === seat.slotId}
                        disabled={!checked}
                        onChange={() => setLeadSlotId(seat.slotId)}
                      />
                      <span>lead</span>
                    </label>
                  ) : null}
                </div>
              )
            })}
            {!candidates.length ? (
              <p className="group-composer__empty">池内没有未入组的会话；先在名册把成员移出其他组，或新建会话。</p>
            ) : null}
            {creating && candidates.length ? (
              <label className={`group-composer__lead-pick is-none${effectiveLead === NO_LEAD ? ' is-checked' : ''}`}>
                <input
                  type="radio"
                  name="group-composer-lead"
                  value={NO_LEAD}
                  checked={effectiveLead === NO_LEAD}
                  onChange={() => setLeadSlotId(NO_LEAD)}
                />
                <span>无 lead：只共享目标、消息与记忆，没有任务板调度</span>
              </label>
            ) : null}
          </fieldset>

          {creating && effectiveLead === NO_LEAD && candidates.length ? (
            <div className="group-composer__policy">
              <ToggleSwitch checked={membersMayPlan} disabled={busy} onChange={setMembersMayPlan}>
                成员可规划任务
              </ToggleSwitch>
              <small>{membersMayPlan ? '任一成员都能在任务板规划本组任务' : '组内无人能规划：任务只能由你在拾光里为该组创建'}</small>
            </div>
          ) : null}

          {error ? <p className="group-composer__error" role="alert">{error}</p> : null}
        </div>

        <footer className="group-composer__actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || !canSubmit}>
            {busy ? '处理中…' : creating ? `建组（${selected.length}）` : `加入（${selected.length}）`}
          </button>
        </footer>
      </form>
    </div>
  )
}
