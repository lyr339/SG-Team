// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextUsagePopover } from '../src/renderer/src/ContextUsagePopover'
import { requestReveal } from '../src/renderer/src/inspector/reveal-bus'
import { ContextThresholdNotifications } from '../src/application/notifications/context-threshold-notifications'
import { notificationSourceHarness, notificationSession, notificationFrame, notificationTeam } from './notification-source-fixtures'
import type { NotificationPush } from '../src/domain/notification'
import { notificationTargetAvailable } from '../src/renderer/src/notifications/notification-navigation'
let host: HTMLDivElement, root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 20,
    y: 100,
    top: 100,
    bottom: 220,
    left: 20,
    right: 320,
    width: 300,
    height: 120,
    toJSON() {
      return {}
    }
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  delete (window as unknown as { sgDesktop?: unknown }).sgDesktop
})
describe('native context reading and exact source reveal', () => {
  it('only the visible fresh native body reads the exact current threshold; opening stats never reads another generation/domain', async () => {
    const h = notificationSourceHarness(),
      team = notificationTeam(),
      now = Date.now(),
      source = new ContextThresholdNotifications(h.owner, () => now)
    const session = notificationSession({
      contextUsage: { ratio: 0.96, used: 96000, limit: 100000 },
      contextUsageSource: 'bound',
      contextUsageComposerId: 'composer-a',
      contextUsageModelId: 'native-a',
      telemetry: { state: 'bound', detail: 'native' }
    })
    const scope = {
      workspaceId: team.activeWorkspaceId,
      runId: team.activeRun!.id,
      slotId: 'slot-a',
      sessionId: session.id,
      channelId: '1',
      generation: '0',
      composerId: 'composer-a',
      bindingGeneration: 'bind-a'
    }
    const listeners = new Set<(event: NotificationPush) => void>()
    h.owner.subscribe((e) => listeners.forEach((fn) => fn(e)))
    const read = vi.fn(async (input: { id: string; revision: number }) => h.owner.read(input.id, input.revision))
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
      getNotificationPage: async (query: Parameters<typeof h.owner.page>[0]) => h.owner.page(query),
      readNotification: read,
      onNotificationChanged: (fn: (event: NotificationPush) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
    }
    try {
      source.observe(notificationFrame({ contextUsageSampledAt: now, sessions: [session] }), team)
      await source.flush()
      await h.owner.flush()
      const target = h.ledger.page().records[0]!.target!
      await act(async () =>
        root.render(
          <ContextUsagePopover usage={session.contextUsage} notificationSession={session} notificationScope={scope} sampledAt={now - 10000} />
        )
      )
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.focus())
      expect(read).not.toHaveBeenCalled()
      await act(async () =>
        root.render(<ContextUsagePopover usage={session.contextUsage} notificationSession={session} notificationScope={scope} sampledAt={now} />)
      )
      // A legitimate new observable body event, not a timer/poll for every numeric tick.
      window.dispatchEvent(new Event('focus'))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(read).toHaveBeenCalledOnce()
      expect(h.ledger.page().summary.unread).toBe(0)
      expect(notificationTargetAvailable(target, [{ ...session, generation: 2 }], team)).toBe(false)
      expect(notificationTargetAvailable(target, [{ ...session, contextUsageModelId: 'other' }], team)).toBe(false)
      await act(async () => root.unmount())
      root = createRoot(host)
      expect(await requestReveal({ surface: 'context', sessionScope: target.kind === 'session' ? target.scope : scope })).toBe(false)
    } finally {
      source.stop()
      await h.owner.close()
    }
  })
  it('reveals only the mounted matching body and rejects stale context domains without executing an action', async () => {
    const now = Date.now(),
      session = notificationSession({
        contextUsage: { ratio: 0.8, used: 80000, limit: 100000 },
        contextUsageSource: 'bound',
        contextUsageComposerId: 'composer-a',
        contextUsageModelId: 'native-a'
      })
    const scope = {
      sessionId: session.id,
      channelId: '1',
      generation: '0',
      composerId: 'composer-a',
      contextDomain: JSON.stringify(['native-a', 100000])
    }
    await act(async () =>
      root.render(<ContextUsagePopover usage={session.contextUsage} notificationSession={session} notificationScope={scope} sampledAt={now} />)
    )
    expect(await requestReveal({ surface: 'context', sessionScope: { ...scope, contextDomain: 'wrong' } })).toBe(false)
    let result!: Promise<boolean>
    await act(async () => {
      result = requestReveal({ surface: 'context', sessionScope: scope })
    })
    await act(async () => {
      expect(await result).toBe(true)
    })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
