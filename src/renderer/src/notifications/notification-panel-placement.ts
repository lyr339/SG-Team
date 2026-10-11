export const NOTIFICATION_PANEL_WIDTH = 460

/** CSS-pixel geometry; preserves trigger alignment when possible, but never sacrifices viewport bounds. */
export function notificationPanelPlacement(viewport: { width: number; height: number }, trigger: { right: number; bottom: number }): { top: number; right: number; width: number; height: number } {
  const margin = 12, width = Math.min(NOTIFICATION_PANEL_WIDTH, Math.max(0, viewport.width - margin * 2))
  const right = Math.max(margin, Math.min(viewport.width - trigger.right, viewport.width - width - margin))
  const top = Math.max(margin, Math.min(trigger.bottom + 8, Math.max(margin, viewport.height - 220 - margin)))
  return { top, right, width, height: Math.max(1, viewport.height - top - margin) }
}
