import './feedback.css'
export type FeedbackTone = 'info' | 'success' | 'warning' | 'error' | 'working'
export function FeedbackIcon({
  tone = 'info',
  className = '',
}: {
  tone?: FeedbackTone
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={`feedback-icon is-${tone} ${className}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      {tone === 'success' ? (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m6.5 10 2.3 2.3 4.7-4.8" />
        </>
      ) : tone === 'warning' ? (
        <>
          <path d="M10 3 17 16H3L10 3Z" />
          <path d="M10 8v3m0 2.5v.1" />
        </>
      ) : tone === 'error' ? (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m7.5 7.5 5 5m0-5-5 5" />
        </>
      ) : tone === 'working' ? (
        <>
          <circle className="feedback-icon__track" cx="10" cy="10" r="7" />
          <path d="M10 3a7 7 0 0 1 7 7" />
        </>
      ) : (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="M10 9v4m0-6.5v.1" />
        </>
      )}
    </svg>
  )
}
export function CloseFeedbackIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </svg>
  )
}
