import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import type { ConversationEntry } from '../../domain/conversation-entry'
import { formatClock } from './format'

interface QueuedMessageTrayProps {
  session: AgentSession
  /** 仍在排队（未投递）的用户可见消息，按入队顺序。 */
  entries: ConversationEntry[]
  /** 撤回尚未投递的消息。 */
  onWithdraw?: (entryId: string) => void
  /** 解除「等待新会话」保持位：当前会话下一次轮询即取走。 */
  onRelease?: (entryId: string) => void
}

function QueueIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.5 5h10M6.5 10h10M6.5 15h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <circle cx="3" cy="5" r="1" fill="currentColor" />
      <circle cx="3" cy="10" r="1" fill="currentColor" />
      <circle cx="3" cy="15" r="1" fill="currentColor" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  )
}

export const QUEUE_TRAY_COLLAPSED_KEY = 'sg-team.workspace:queue-tray-collapsed'

function readCollapsed(): boolean {
  try { return localStorage.getItem(QUEUE_TRAY_COLLAPSED_KEY) === '1' } catch { return false }
}

function storeCollapsed(value: boolean): void {
  try { localStorage.setItem(QUEUE_TRAY_COLLAPSED_KEY, value ? '1' : '0') } catch { /* 当前窗口仍然生效。 */ }
}

export function queuePreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact || '（仅附件）'
}

/** 托盘状态句：说明这些消息为什么还没进入对话、什么时候会进入。 */
export function queueTrayState(session: Pick<AgentSession, 'online' | 'waiting'>): { tone: 'offline' | 'waiting' | 'busy'; text: string } {
  if (!session.online) return { tone: 'offline', text: 'Agent 离线：消息保留在本地队列，恢复轮询后按顺序送达' }
  if (session.waiting) return { tone: 'waiting', text: 'Agent 正在监听：下一条消息会立即投递' }
  return { tone: 'busy', text: 'Agent 正在处理当前任务：新消息按顺序等待' }
}

/**
 * 待投递托盘：停在时间线与输入区之间，承接尚未被 check_messages 取走的用户消息。
 *
 * 它是发送后的即时回显——消息不进时间线（那里只放 Agent 实际看到过的对话），但也不消失；
 * 被取走的那一刻从托盘移入时间线。每条可撤回，带「等待新会话」保持位的可放行。
 * 数字口径 = 服务端待投递计数（含内部静默消息），列表口径 = 用户可见条目，两者相差时如实注明。
 * 没有任何待投递内容时不渲染。
 */
export function QueuedMessageTray({ session, entries, onWithdraw, onRelease }: QueuedMessageTrayProps): React.JSX.Element | null {
  const listId = useId()
  // 折叠偏好持久化，与下方本轮文件栏同一规则：两条栏叠放时行为一致。
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const listRef = useRef<HTMLOListElement>(null)
  // 列表超高才可滚动；渐隐遮罩只在对应方向还有内容时出现，滚到边缘即消失。
  const [scrollHint, setScrollHint] = useState<'' | 'up' | 'down' | 'both'>('')
  const updateScrollHint = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const up = el.scrollTop > 4
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 4
    setScrollHint(up && down ? 'both' : up ? 'up' : down ? 'down' : '')
  }, [])
  useEffect(() => { updateScrollHint() }, [entries.length, collapsed, updateScrollHint])
  const depth = Math.max(session.queueDepth, entries.length)
  if (depth === 0) return null
  const heldCount = entries.filter((entry) => entry.heldForNextSession).length
  const hiddenCount = Math.max(0, depth - entries.length)
  const { tone, text: stateText } = queueTrayState(session)
  const expandable = entries.length > 0
  const open = expandable && !collapsed
  return (
    <section
      className={`queue-tray is-${tone} ${open ? 'is-open' : 'is-collapsed'}`}
      aria-label="待投递消息"
      data-queue-depth={depth}
    >
      <button
        type="button"
        className="queue-tray__head"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? listId : undefined}
        disabled={!expandable}
        title={expandable ? (open ? '收起待投递列表' : '展开待投递列表') : undefined}
        onClick={() => setCollapsed((value) => {
          storeCollapsed(!value)
          return !value
        })}
      >
        <span className="queue-tray__icon"><QueueIcon /></span>
        <strong className="queue-tray__title">待投递 <b>{depth}</b></strong>
        <span className="queue-tray__state" title={stateText}>{stateText}</span>
        {heldCount > 0 ? <em className="queue-tray__held" title={`${heldCount} 条等待新会话`}>{heldCount} 条等待新会话</em> : null}
        {expandable ? <span className="queue-tray__chevron"><ChevronIcon /></span> : null}
      </button>
      {expandable ? (
        // 列表常驻挂载，收起走 grid-rows 高度过渡（与展开对称）；收起后 inert 挡掉焦点与读屏。
        <div id={listId} className="queue-tray__listwrap" inert={!open}>
          <ol ref={listRef} className="queue-tray__list" data-scroll={scrollHint || undefined} onScroll={updateScrollHint}>
            {entries.map((entry, index) => (
              <li key={entry.id} className={`queue-tray__item ${entry.heldForNextSession ? 'is-held' : ''}`} data-entry-id={entry.id}>
                <span className="queue-tray__index">{index + 1}</span>
                <div className="queue-tray__body">
                  <div className="queue-tray__meta">
                    <time>{formatClock(entry.timestamp)}</time>
                    {entry.attachments?.length ? <span>{entry.attachments.length} 个附件</span> : null}
                    {entry.heldForNextSession ? <b>等待新会话</b> : null}
                  </div>
                  <p title={entry.text}>{queuePreview(entry.text)}</p>
                </div>
                <div className="queue-tray__actions">
                  {entry.heldForNextSession && onRelease ? (
                    <button type="button" title="解除等待：当前 Agent 下一次轮询即取走" onClick={() => onRelease(entry.id)}>放行</button>
                  ) : null}
                  {onWithdraw ? (
                    <button type="button" className="is-danger" title="撤回这条消息并回填到输入框" onClick={() => onWithdraw(entry.id)}>撤回</button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {hiddenCount > 0 ? (
        <p className="queue-tray__note">
          {entries.length ? `另有 ${hiddenCount} 条系统内部消息在队列中，不显示正文。` : `${hiddenCount} 条系统内部消息在队列中，不显示正文。`}
        </p>
      ) : null}
    </section>
  )
}
