import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TeamMemoryInspection, TeamMemoryInspectionRequest } from '../../../domain/team-memory-inspection'
import { memoryRevisionIssue, memoryInspectionMatches } from '../../../domain/team-memory-inspection'
import { observeSourceNotificationRead } from './observe-source-read'
import { formatFullClock } from '../format'
import './team-memory-inspection.css'
const statusNames = { proposed: '待审查', accepted: '已采纳', rejected: '已驳回', superseded: '已被取代' } as const
export function TeamMemoryInspectionDialog({
  request,
  initial,
  onClose,
  onOpenGroup
}: {
  request: TeamMemoryInspectionRequest
  initial: TeamMemoryInspection
  onClose: () => void
  onOpenGroup?: () => boolean
}): React.JSX.Element {
  const [value, setValue] = useState(initial),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const loadingRef = useRef(false)
  const titleId = useId(),
    body = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    backdrop = useRef<HTMLDivElement>(null),
    close = useRef<HTMLButtonElement>(null),
    epoch = useRef(0),
    leaving = useRef(false)
  const scope = memoryRevisionIssue(value.item, value.predecessor)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const siblings = [...document.body.children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== backdrop.current)
      .map((node) => ({ node, inert: node.inert }))
    siblings.forEach(({ node }) => {
      node.inert = true
    })
    close.current?.focus({ preventScroll: true })
    return () => {
      ++epoch.current
      siblings.forEach(({ node, inert }) => {
        node.inert = inert
      })
      if (!leaving.current)
        (opener?.isConnected ? opener : document.querySelector<HTMLElement>('.notification-trigger'))?.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])
  useEffect(() => {
    const element = body.current,
      api = window.sgDesktop
    if (!element || loading || error || !api?.getNotificationPage || !api.onNotificationChanged) return
    return observeSourceNotificationRead(
      element,
      api,
      { memoryId: request.memoryId, eventType: 'memory.issue', limit: 1 },
      (record) =>
        record.eventType === 'memory.issue' &&
        record.scope.workspaceId === request.workspaceId &&
        record.scope.runId === request.runId &&
        record.scope.groupId === request.groupId &&
        record.scope.memoryId === request.memoryId &&
        record.scope.memoryVersion === String(request.version) &&
        record.subjectState === scope
    )
  }, [request.memoryId, request.workspaceId, request.runId, request.groupId, request.version, scope, loading, error])
  const refresh = async () => {
    if (loadingRef.current || !window.sgDesktop.getTeamMemoryInspection) return
    loadingRef.current = true
    const current = ++epoch.current
    setLoading(true)
    setError('')
    try {
      const next = await window.sgDesktop.getTeamMemoryInspection(request)
      if (!memoryInspectionMatches(request, next)) throw Error('原记录范围已变化')
      if (current === epoch.current) setValue(next)
    } catch {
      if (current === epoch.current) setError('原记录暂不可重新读取。保留上次内容；没有据此确认状态改变。')
    } finally {
      if (current === epoch.current) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }
  return createPortal(
    <div
      ref={backdrop}
      className="memory-inspection-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panel}
        className="memory-inspection"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key !== 'Tab') return
          const buttons = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"],summary') ?? [])],
            first = buttons[0],
            last = buttons.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header>
          <div>
            <span>共享记忆 · 原记录</span>
            <h2 id={titleId}>{value.item.title}</h2>
          </div>
          <button ref={close} type="button" aria-label="关闭原记忆" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" />
            </svg>
          </button>
        </header>
        <div className="memory-inspection__meta">
          <span>{statusNames[value.item.status]}</span>
          <span>版本 {value.item.version}</span>
          <time title="本次读取时间" aria-label={`读取于 ${formatFullClock(value.observedAt)}`}>
            {formatFullClock(value.observedAt)}
          </time>
        </div>
        {scope === 'conflict' ? (
          <p className="memory-inspection__notice">
            要取代的旧记忆已发生变化，这项修订仍待审查。先核对两份内容，再在原协作流程中处理。这里只查看，不会自动采纳或驳回。
          </p>
        ) : null}
        {error ? (
          <p className="memory-inspection__notice" role="alert">
            {error}
          </p>
        ) : null}
        <div ref={body} className="memory-inspection__body" tabIndex={0}>
          <h3>提案内容</h3>
          <p>{value.item.content}</p>
          {value.predecessor ? (
            <details>
              <summary>查看要取代的前置条目 · {statusNames[value.predecessor.status]}</summary>
              <h3>{value.predecessor.title}</h3>
              <p>{value.predecessor.content}</p>
            </details>
          ) : value.item.supersedesId ? (
            <p>前置条目当前未确认；不能把缺失当成冲突已解决。</p>
          ) : null}
          <details>
            <summary>原引用 · {value.item.sources.length} 项</summary>
            <ul>
              {value.item.sources.map((source, index) => (
                <li key={index}>
                  <strong>{source.label}</strong>
                  <code>{source.ref}</code>
                </li>
              ))}
            </ul>
          </details>
        </div>
        <footer>
          <small>显示本次读取的原记录，不复制正文到通知历史。</small>
          <div>
            <button type="button" disabled={loading || !window.sgDesktop.getTeamMemoryInspection} aria-busy={loading} onClick={() => void refresh()}>
              {loading ? '读取中…' : '重新读取'}
            </button>
            {onOpenGroup ? (
              <button
                type="button"
                onClick={() => {
                  if (onOpenGroup()) {
                    leaving.current = true
                    onClose()
                  } else setError('原协作组当前不可定位；原记录内容仍保留。')
                }}
              >
                查看原协作组
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>,
    document.body
  )
}
