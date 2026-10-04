/** Reading requires visible source content, not merely a selected route or a mounted card. */
export function notificationElementVisible(element: HTMLElement): boolean {
  if (!element.isConnected || !document.hasFocus() || element.closest('[hidden], [inert]')) return false
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
  if (dialogs.length && !dialogs.at(-1)!.contains(element)) return false
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, innerHeight)
  let left = Math.max(rect.left, 0), right = Math.min(rect.right, innerWidth)
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const [overflowX, overflowY = overflowX] = style.overflow.split(/\s+/)
    const clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY) || /(auto|scroll|hidden|clip)/.test(overflowY ?? '')
    const clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX) || /(auto|scroll|hidden|clip)/.test(overflowX ?? '')
    if (clipsY || clipsX) {
      const bounds = ancestor.getBoundingClientRect()
      if (clipsY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom) }
      if (clipsX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right) }
    }
  }
  return bottom - top >= Math.min(rect.height, 48) && right - left >= Math.min(rect.width, 32)
}
