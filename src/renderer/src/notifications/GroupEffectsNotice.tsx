import { FeedbackIcon } from '../feedback/FeedbackIcon'
import { ChevronDownIcon } from '../UiIcons'
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
      <details className="feedback-disclosure">
        <summary>
          <FeedbackIcon tone="warning" />
          <span>先前的组后续事项待核对</span>
          <span className="feedback-disclosure__toggle group-effects-notice__disclosure" aria-hidden="true">
            详情<ChevronDownIcon/>
          </span>
        </summary>
        <p ref={ref} data-notification-result data-notification-key={record.key} data-notification-event={record.eventId}>{record.detail}</p>
        <small>阅读通知不会改变任务或成员状态。</small>
      </details>
    </div>
  )
}
