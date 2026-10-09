import { DisclosureSummary } from '../DisclosureSummary'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { notificationHistoryNeedsAcknowledgement } from '../../../domain/notification-history'
import type { NotificationStore } from './notification-store'
import { formatFullClock } from '../format'

export function HistoryGapNotice({ store }: { store: NotificationStore }): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const alive = useRef(true), busy = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const integrity = snapshot.historyIntegrity
  const unknown = snapshot.historyGapUnconfirmed || snapshot.historyIncomplete && !integrity?.revision
  if (!unknown && !notificationHistoryNeedsAcknowledgement(integrity)) return null
  return <section className="notification-history-notice" aria-label="通知历史完整性说明">
    <div><strong>通知历史可能不完整</strong><p>已保存记录仍可查看。收起说明不会补齐缺失事件，也不改变业务结果。</p>
      {unknown ? <small>说明保存待确认，稍后可重新读取。</small> : null}
      {feedback ? <small role="status">{feedback}</small> : null}
      {error ? <p className="notification-history-notice__error" role="alert">{error}</p> : null}
    </div>
    <button type="button" className="notification-text-button is-muted" disabled={saving || unknown || !store.api.acknowledgeNotificationHistory}
      aria-label="确认并收起当前历史说明" onClick={() => {
        if (busy.current || !integrity?.revision) return
        busy.current = true; setSaving(true); setError(''); setFeedback('')
        const shown = integrity.revision
        void store.acknowledgeHistory(shown).then(() => {
          if (alive.current && (store.snapshot().historyIntegrity?.revision ?? 0) > shown) setFeedback('出现了新的缺口说明，请核对后再确认。')
        }).catch(() => { if (alive.current) setError('确认结果尚未保存或待核对，请重新读取后再试。') })
          .finally(() => { busy.current = false; if (alive.current) setSaving(false) })
      }}>{saving ? '保存中…' : '我知道了'}</button>
  </section>
}

export function HistoryRetentionInfo({ store }: { store: NotificationStore }): React.JSX.Element {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot), integrity = snapshot.historyIntegrity
  return <details className="notification-history-policy"><DisclosureSummary><span>历史保留与完整性</span></DisclosureSummary>
    <div className="notification-history-policy__content" role="region" aria-label="历史保留与完整性说明" tabIndex={0}>
    <p>普通已读结果与日常动态：至少保留 30 天。未读、待处理及曾需诊断的重要结果不会自动清理；旧版未分类历史也会保留。</p>
    <p>需要长期追溯时，请查看原会话或操作记录；手动清理仍需确认。</p>
    {snapshot.historyIncomplete ? <p>历史曾有缺口；已保存记录不受影响。
      {integrity?.observedAt !== undefined ? ` 说明记录于 ${formatFullClock(integrity.observedAt)}。` : ''}
      {integrity && integrity.revision > 0 && !notificationHistoryNeedsAcknowledgement(integrity) ? ' 这次说明已确认，不代表缺口已修复。' : ''}
    </p> : null}
    </div>
  </details>
}
