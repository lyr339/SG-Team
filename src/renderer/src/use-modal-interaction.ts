import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'

/** Shared keyboard boundary for the simple handoff/guard dialogs. Owns no
 * business state, portals, operation cancellation or notification receipts. */
export function useModalInteraction(onClose: () => void, busy = false) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const opener = document.activeElement, element = ref.current
    ;(element?.querySelector<HTMLElement>('button:not(:disabled)') ?? element)?.focus({ preventScroll: true })
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected
        && (document.activeElement === document.body || element?.contains(document.activeElement))) opener.focus({ preventScroll: true })
    }
  }, [])
  // A result view may replace the focused submit button. Keep focus in this
  // dialog instead of letting the removed control strand it on body.
  useLayoutEffect(() => {
    const element = ref.current, active = document.activeElement
    if (element && (active === document.body || element.contains(active) && active?.matches(':disabled'))) element.focus({ preventScroll: true })
  })
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    // A nested modal owns its own keys; normal text selection/copy keeps the
    // browser default but never reaches shell navigation shortcuts.
    if ((event.target as Element).closest('[role="dialog"][aria-modal="true"]') !== event.currentTarget) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy) onClose()
      return
    }
    if (event.key !== 'Tab') return
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled, input[type="hidden"]')
        && !element.closest('[hidden], [inert], details:not([open]) > :not(summary)'))
    const first = stops[0], last = stops.at(-1), active = document.activeElement
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return }
    if (event.shiftKey && (active === first || active === event.currentTarget) || !event.shiftKey && active === last) {
      event.preventDefault(); (event.shiftKey ? last : first).focus()
    }
  }
  return { ref, tabIndex: -1, onKeyDown }
}
