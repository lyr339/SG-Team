import type { ComponentPropsWithoutRef } from 'react'
import { FeedbackIcon, type FeedbackTone } from './FeedbackIcon'
/** Small acknowledgements inside toolbars/menus stay inline, never become a
 * second full-size banner. The operation and expiry remain caller-owned. */
export function FeedbackText({
  tone = 'info',
  className = '',
  children,
  role,
  ...rest
}: ComponentPropsWithoutRef<'span'> & {
  tone?: FeedbackTone
}): React.JSX.Element {
  return (
    <span
      {...rest}
      className={`feedback-text is-${tone} ${className}`}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
    >
      <FeedbackIcon tone={tone} />
      <span>{children}</span>
    </span>
  )
}
