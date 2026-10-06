import { useRef } from 'react'
import type { NotificationRecord } from '../../../domain/notification'
import { useNotificationResultRead } from './use-notification-result-read'
import './group-effects-notice.css'
/** A historical original-call diagnostic, not a retry button or current group-state authority. */
export function GroupEffectsNotice({ record }: { record?: NotificationRecord }): React.JSX.Element | null {
  const ref = useRef<HTMLParagraphElement>(null)
  useNotificationResultRead(ref, record?.key, record?.eventId, record)
  if (!record) return null
  return (
    <div
      className="group-effects-notice"
    >
      <details>
        <summary>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2 1.5 13h13L8 2Z" />
            <path d="M8 6v3m0 2v.1" />
          </svg>
          <span>先前的组后续事项待核对</span>
          <span className="group-effects-notice__disclosure" aria-hidden="true">
            详情
          </span>
        </summary>
        <p ref={ref} data-notification-result data-notification-key={record.key} data-notification-event={record.eventId}>{record.detail}</p>
        <small>阅读通知不会改变任务或成员状态。</small>
      </details>
    </div>
  )
}
