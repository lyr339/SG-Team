import { FeedbackIcon } from '../feedback/FeedbackIcon'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon } from '../UiIcons'
import { useNotificationResultRead } from '../notifications/use-notification-result-read'

export interface SettingsNoticeMessage {
  tone: 'success' | 'warning' | 'error'
  title: string
  detail?: string
  section?: 'accounts' | 'import'
  notification?: import('../../../domain/notification-reference').NotificationReference
}

export function SettingsNotice({ message, onDismiss }: {
  message: SettingsNoticeMessage
  onDismiss?: () => void
}): React.JSX.Element {
  const resultRef = useRef<HTMLElement>(null)
  useNotificationResultRead(resultRef, message.notification?.key, message.notification?.eventId)
  const [expanded, setExpanded] = useState(message.tone !== 'success')
  const detailId = useId()
  useEffect(() => { setExpanded(message.tone !== 'success') }, [message.tone, message.title, message.detail])
  return (
    <aside ref={resultRef} className={`settings-notice is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}
      data-notification-page={`account:${message.section ?? 'accounts'}`} data-notification-result data-notification-key={message.notification?.key} data-notification-event={message.notification?.eventId}>
      <div className="settings-notice__head">
        <FeedbackIcon tone={message.tone} className="settings-notice__icon" />
        <strong>{message.title}</strong>
        <div className="settings-notice__actions">
          {message.detail ? <button type="button" className="settings-notice__toggle" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded((current) => !current)}>
            详情<ChevronDownIcon />
          </button> : null}
          {onDismiss ? <button type="button" className="settings-notice__close" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
          </button> : null}
        </div>
      </div>
      {message.detail ? <div id={detailId} className={`settings-notice__details${expanded ? ' is-open' : ''}`} aria-hidden={!expanded} inert={!expanded}>
        <div tabIndex={expanded ? 0 : -1} aria-label="完整提示详情"><p className="settings-notice__detail">{message.detail}</p></div>
      </div> : null}
    </aside>
  )
}
