// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { notificationElementVisible } from '../src/renderer/src/notifications/notification-visible'
it('does not treat retained closed-details geometry as painted result content, but still permits the direct summary and nested open results', () => {
  const host = document.createElement('div'); host.innerHTML = '<details><summary><span>title</span></summary><div><details open><summary>inner</summary><p>result</p></details></div></details>'
  document.body.append(host)
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 70, top: 100, bottom: 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
  try {
    const outer = host.querySelector('details')!, result = host.querySelector('p')!, summary = host.querySelector('summary span') as HTMLElement
    expect(notificationElementVisible(summary)).toBe(true); expect(notificationElementVisible(result)).toBe(false)
    outer.open = true; expect(notificationElementVisible(result)).toBe(true)
    result.style.visibility = 'hidden'; expect(notificationElementVisible(result)).toBe(false)
    result.style.visibility = ''; host.setAttribute('aria-hidden', 'true'); expect(notificationElementVisible(result)).toBe(false)
  } finally { host.remove(); rect.mockRestore(); focus.mockRestore() }
})
