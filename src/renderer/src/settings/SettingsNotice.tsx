import { useEffect, useId, useState } from 'react'
import { ChevronDownIcon } from '../UiIcons'

export interface SettingsNoticeMessage {
  tone: 'success' | 'warning' | 'error'
  title: string
  detail?: string
}

export function SettingsNotice({ message, onDismiss }: {
  message: SettingsNoticeMessage
  onDismiss?: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(message.tone !== 'success')
  const detailId = useId()
  useEffect(() => { setExpanded(message.tone !== 'success') }, [message.tone, message.title, message.detail])
  return (
    <aside className={`settings-notice is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
      <div className="settings-notice__head">
        <svg className="settings-notice__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          {message.tone === 'success'
            ? <path d="m4 10 4 4 8-8" />
            : message.tone === 'warning'
              ? <><path d="m10 3 7 13H3L10 3Z" /><path d="M10 8v3M10 13.5v.1" /></>
              : <><circle cx="10" cy="10" r="7" /><path d="m7.5 7.5 5 5m0-5-5 5" /></>}
        </svg>
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
