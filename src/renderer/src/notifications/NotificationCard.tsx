import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react'
import {
  FeedbackIcon,
  CloseFeedbackIcon,
  type FeedbackTone,
} from '../feedback/FeedbackIcon'
import './notifications.css'
interface Props extends Omit<ComponentPropsWithoutRef<'aside'>, 'title'> {
  ref?: Ref<HTMLElement>
  title: string
  source: string
  detail?: string
  tone?: FeedbackTone
  actions: ReactNode
  error?: string
  onDismiss: () => void
}
/** The shared visual surface only. Queue, expiry, source reads, delivery and
 * business actions remain owned by the caller; no duplicated notification state. */
export function NotificationCard({
  ref,
  title,
  source,
  detail,
  tone = 'info',
  actions,
  error,
  onDismiss,
  className = '',
  ...rest
}: Props): React.JSX.Element {
  return (
    <aside
      {...rest}
      ref={ref}
      className={`notification-toast ${className}`}
      role={rest.role ?? 'status'}
      aria-live={rest['aria-live'] ?? 'polite'}
    >
      <div className="notification-toast__header">
        <FeedbackIcon tone={tone} className="notification-status-icon" />
        <strong>{title}</strong>
        <button
          className="notification-icon-button"
          type="button"
          aria-label="收起提醒"
          onClick={onDismiss}
        >
          <CloseFeedbackIcon />
        </button>
      </div>
      <div className="notification-toast__copy">
        <span>{source}</span>
        {detail ? <p>{detail}</p> : null}
        <div className="notification-toast__actions">{actions}</div>
        {error ? (
          <p className="notification-toast__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </aside>
  )
}
