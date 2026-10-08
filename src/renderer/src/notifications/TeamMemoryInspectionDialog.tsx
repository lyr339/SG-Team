import { FeedbackLine } from '../feedback/FeedbackLine'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  TeamMemoryInspection,
  TeamMemoryInspectionRequest
} from '../../../domain/team-memory-inspection'
import { memoryRevisionIssue, memoryInspectionMatches } from '../../../domain/team-memory-inspection'
import type { NotificationReference } from '../../../domain/notification-reference'
import { observeSourceNotificationRead } from './observe-source-read'
import { useNotificationResultRead } from './use-notification-result-read'
import { pageOperationDisplay } from './page-operation-display'
import { formatFullClock } from '../format'
import './team-memory-inspection.css'
const statusNames = {
  proposed: '待审查',
  accepted: '已采纳',
  rejected: '已驳回',
  superseded: '已被取代'
} as const
interface Props {
  request: TeamMemoryInspectionRequest
  initial: TeamMemoryInspection
  onClose: () => void
  onOpenGroup?: () => boolean
}
export function TeamMemoryInspectionDialog({
  request,
  initial,
  onClose,
  onOpenGroup
}: Props): React.JSX.Element {
  const [value, setValue] = useState(initial),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const [decision, setDecision] = useState<'accept' | 'reject'>(),
    [note, setNote] = useState(''),
    [reviewing, setReviewing] = useState(false),
    [result, setResult] = useState<{
      message: string
      notification?: NotificationReference
    }>()
  const titleId = useId(),
    body = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    backdrop = useRef<HTMLDivElement>(null),
    close = useRef<HTMLButtonElement>(null),
    epoch = useRef(0),
    leaving = useRef(false),
    loadingRef = useRef(false),
    reviewLock = useRef(false),
    resultRef = useRef<HTMLParagraphElement>(null),
    confirmation = useRef<HTMLDivElement>(null),
    readButton = useRef<HTMLButtonElement>(null),
    readHadFocus = useRef(false),
    confirmationWasOpen = useRef(false)
  const prerequisite = memoryRevisionIssue(value.item, value.predecessor)
  useNotificationResultRead(resultRef, result?.notification?.key, result?.notification?.eventId)
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
        (opener?.isConnected ? opener : document.querySelector<HTMLElement>('.notification-trigger'))?.focus({
          preventScroll: true
        })
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
    if (decision) {
      confirmationWasOpen.current = true
      confirmation.current?.querySelector<HTMLElement>('textarea')?.focus()
    } else if (confirmationWasOpen.current) {
      confirmationWasOpen.current = false
      if (!result) readButton.current?.focus({ preventScroll: true })
    }
  }, [decision])
  useEffect(() => {
    if (result) resultRef.current?.focus({ preventScroll: true })
  }, [result])
  useEffect(() => {
    if (!loading && readHadFocus.current) {
      readHadFocus.current = false
      if (document.activeElement === document.body || document.activeElement === readButton.current)
        readButton.current?.focus({ preventScroll: true })
    }
  }, [loading])
  useEffect(() => {
    const element = body.current,
      api = window.sgDesktop
    if (!element || loading || reviewing || error || !api?.getNotificationPage || !api.onNotificationChanged)
      return
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
        (record.subjectState === prerequisite ||
          (record.subjectState === 'operator-review' &&
            value.item.status === 'proposed' &&
            record.scope.operatorRequestId === value.operatorReview?.messageId &&
            Boolean(value.operatorReview)))
    )
  }, [
    request.memoryId,
    request.workspaceId,
    request.runId,
    request.groupId,
    request.version,
    prerequisite,
    loading,
    reviewing,
    error,
    value.operatorReview,
    value.item.status
  ])
  const refresh = async () => {
    if (loadingRef.current || reviewLock.current || !window.sgDesktop.getTeamMemoryInspection) return
    const current = ++epoch.current
    readHadFocus.current = document.activeElement === readButton.current
    loadingRef.current = true
    setLoading(true)
    setError('')
    try {
      const next = await window.sgDesktop.getTeamMemoryInspection(request)
      if (!memoryInspectionMatches(request, next)) throw Error('原记录范围已变化')
      if (current === epoch.current) {
        setValue(next)
        setDecision(undefined)
        setResult(undefined)
      }
    } catch {
      if (current === epoch.current) setError('原记录暂不可重新读取。保留上次内容；没有据此确认状态改变。')
    } finally {
      loadingRef.current = false
      if (current === epoch.current) setLoading(false)
    }
  }
  const canReview = Boolean(
    value.item.status === 'proposed' &&
      value.canReview &&
      window.sgDesktop.reviewTeamMemory &&
      !loading &&
      !reviewing &&
      !error
  )
  const confirmReview = async () => {
    if (reviewLock.current || !decision || !canReview || !window.sgDesktop.reviewTeamMemory) return
    if (decision === 'accept' && (prerequisite === 'conflict' || prerequisite === 'unconfirmed')) return
    const selected = decision,
      current = ++epoch.current,
      display = pageOperationDisplay(selected === 'accept' ? 'memory-accept' : 'memory-reject')
    reviewLock.current = true
    setReviewing(true)
    setError('')
    setResult(undefined)
    try {
      const response = await window.sgDesktop.reviewTeamMemory({
        ...request,
        decision: selected,
        confirmed: true,
        note,
        ...display.request
      })
      if (!memoryInspectionMatches(request, response.inspection)) throw Error('原对象范围已变化')
      const conclusion = response.conclusion ?? response.inspection.item.status
      if (current === epoch.current) {
        setValue(response.inspection)
        setDecision(undefined)
        setNote('')
        setResult({
          message:
            (conclusion === 'accepted'
              ? '原记忆已采纳'
              : conclusion === 'rejected'
                ? '原记忆已驳回'
                : '审核结果仍待核对') + (response.inspectionPending ? '；展示刷新待核对' : ''),
          notification: response.notification ?? display.reference
        })
        if (response.inspectionPending) setError('原审核结论已返回，原记录刷新仍待核对；不会重做审核。')
      }
    } catch {
      if (current === epoch.current) {
        setError('本次审核结果待核对。')
        setResult({
          message: '原入口未返回确认结果。输入保留；请重新读取核对，不会自动重试。',
          notification: display.reference
        })
      }
    } finally {
      reviewLock.current = false
      if (current === epoch.current) setReviewing(false)
    }
  }
  return createPortal(
    <div
      ref={backdrop}
      className="memory-inspection-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !reviewLock.current) onClose()
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
          const buttons = [
              ...(panel.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),textarea:not(:disabled),[tabindex="0"],summary'
              ) ?? [])
            ],
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
            <h2 id={titleId} title={value.item.title}>
              {value.item.title}
            </h2>
          </div>
          <button ref={close} type="button" aria-label="关闭原记忆" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" />
            </svg>
          </button>
        </header>
        <div className="memory-inspection__scroll">
          <div className="memory-inspection__meta">
            <span>{statusNames[value.item.status]}</span>
            <span>版本 {value.item.version}</span>
            <time title="本次读取时间" aria-label={`读取于 ${formatFullClock(value.observedAt)}`}>
              {formatFullClock(value.observedAt)}
            </time>
          </div>
          {prerequisite === 'conflict' ? (
            <FeedbackLine className="memory-inspection__notice" tone="warning">
              要取代的旧记忆已发生变化，不能直接采纳这项修订。先核对两份内容，再决定是否驳回并回到原协作流程处理；不会自动审核。
            </FeedbackLine>
          ) : null}
          {value.operatorReview && value.item.status === 'proposed' ? (
            <FeedbackLine className="memory-inspection__notice" tone="warning">
              {value.operatorReview.reason === 'timeout' ? '原审核等待时间较长' : '原流程未找到独立审核成员'}
              ，已发给你处理。先看提案和引用，再选择采纳或驳回。
            </FeedbackLine>
          ) : null}
          {error ? (
            <FeedbackLine className="memory-inspection__notice" tone="error">
              {error}
            </FeedbackLine>
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
          {decision ? (
            <div
              ref={confirmation}
              className="memory-review-confirm"
              role="group"
              aria-label="确认原记忆审核"
            >
              <strong>{decision === 'accept' ? '采纳这项原提案？' : '驳回这项原提案？'}</strong>
              <p>
                {decision === 'accept'
                  ? '确认后写入原共享记忆，后续成员上下文可能引用它。'
                  : '确认后原提案保留为已驳回；不会删除正文或自动重新提出。'}
              </p>
              <label>
                审核附言（可选）
                <textarea
                  name="memory-review-note"
                  autoComplete="off"
                  aria-label="审核附言（可选）"
                  value={note}
                  maxLength={4000}
                  disabled={reviewing}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                />
              </label>
            </div>
          ) : null}
        </div>
        <footer>
          <div className="memory-review-result">
            {result ? (
              <p
                ref={resultRef}
                role="status"
                tabIndex={-1}
                data-notification-result
                data-notification-key={result.notification?.key}
                data-notification-event={result.notification?.eventId}
              >
                {result.message}
              </p>
            ) : (
              <small>
                {reviewing
                  ? '原审核已提交，关闭不会撤回已发出的操作。'
                  : decision
                    ? '核对后再确认；附言仅存于原条目。'
                    : '读取不会审核提案，结论只在明确确认后写入原记录。'}
              </small>
            )}
          </div>
          <div>
            {!decision || error ? (
              <button
                ref={readButton}
                type="button"
                disabled={loading || reviewing || !window.sgDesktop.getTeamMemoryInspection}
                aria-busy={loading}
                onClick={() => void refresh()}
              >
                {loading ? '读取中…' : '重新读取'}
              </button>
            ) : null}
            {decision ? (
              <>
                <button type="button" disabled={reviewing} onClick={() => setDecision(undefined)}>
                  先不审核
                </button>
                <button
                  type="button"
                  className="memory-review-primary"
                  disabled={!canReview}
                  aria-busy={reviewing}
                  onClick={() => void confirmReview()}
                >
                  {reviewing ? '提交中…' : decision === 'accept' ? '确认采纳' : '确认驳回'}
                </button>
              </>
            ) : null}
            {!decision && value.canReview && window.sgDesktop.reviewTeamMemory ? (
              <>
                <button
                  type="button"
                  disabled={!canReview}
                  onClick={() => {
                    setDecision('reject')
                    setResult(undefined)
                  }}
                >
                  驳回…
                </button>
                <button
                  type="button"
                  className="memory-review-primary"
                  disabled={!canReview || prerequisite === 'conflict' || prerequisite === 'unconfirmed'}
                  title={prerequisite === 'conflict' ? '前置记忆已变化，请先核对或驳回这项修订' : undefined}
                  onClick={() => {
                    setDecision('accept')
                    setResult(undefined)
                  }}
                >
                  采纳…
                </button>
              </>
            ) : null}
            {onOpenGroup && !decision ? (
              <button
                type="button"
                disabled={reviewing}
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
