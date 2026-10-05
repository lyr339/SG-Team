import { describe, expect, it } from 'vitest'
import { notificationPanelPlacement } from '../src/renderer/src/notifications/notification-panel-placement'
describe('viewport-safe notification placement in CSS pixels', () => {
  it('preserves normal right-edge alignment and clamps both sides on narrow/zoomed layouts', () => {
    for (const width of [360,520,615,800,985,1600]) for (const right of [20,300,417,width-12,width+100]) {
      const value = notificationPanelPlacement({ width, height: 640 }, { right, bottom: 40 })
      const panelWidth = Math.min(440, width - 24), left = width - value.right - panelWidth
      expect(left).toBeGreaterThanOrEqual(12); expect(value.right).toBeGreaterThanOrEqual(12)
      expect(value.top + value.height).toBe(628)
    }
    expect(notificationPanelPlacement({ width:985,height:554 },{right:697,bottom:40}).right).toBe(288)
  })
  it('uses the actual trigger and available vertical room instead of a whole-window guessed height', () => {
    const small = notificationPanelPlacement({ width:615,height:492 },{right:417,bottom:39})
    expect(small).toEqual({top:47,right:163,height:433})
    const wrapped = notificationPanelPlacement({ width:800,height:360 },{right:750,bottom:160})
    expect(wrapped.top + wrapped.height).toBe(348); expect(wrapped.height).toBeGreaterThanOrEqual(220)
  })
})
