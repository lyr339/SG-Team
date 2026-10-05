import { useEffect, useRef, type RefObject } from 'react'
import type { AgentSession } from '../../../domain/agent-session'
import type { NotificationScope } from '../../../domain/notification'
import { notificationSessionScopeMatches } from './notification-session-scope'
import { observeSourceNotificationRead } from './observe-source-read'
import { nativeContextReading } from '../../../domain/context-reading'

export function useContextNotificationRead(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  scope: NotificationScope | undefined,
  session: AgentSession | undefined,
  sampledAt: number | undefined
): void {
  const current = useRef({ scope, session, sampledAt })
  current.current = { scope, session, sampledAt }
  const sessionId = scope?.sessionId,
    generation = scope?.generation,
    composerId = scope?.composerId,
    bindingGeneration = scope?.bindingGeneration
  const domain = session?.contextUsage?.limit ? JSON.stringify([session.contextUsageModelId ?? null, session.contextUsage.limit]) : undefined
  const bound = session?.contextUsageSource === 'bound'
  useEffect(() => {
    const element = ref.current,
      api = window.sgDesktop
    if (!open || !element || !sessionId || !domain || !bound || !api?.getNotificationPage || !api.onNotificationChanged) return
    return observeSourceNotificationRead(
      element,
      api,
      { sessionId, generation, contextDomain: domain, eventType: 'context.threshold', category: 'usage', limit: 5 },
      (record) => {
        const fresh = current.current,
          reading = fresh.session ? nativeContextReading(fresh.session, fresh.sampledAt, Date.now()) : undefined,
          ratio = reading?.ratio
        return Boolean(
          fresh.scope &&
            reading &&
            reading.domain === domain &&
            ratio !== undefined &&
            record.eventType === 'context.threshold' &&
            record.scope.contextDomain === domain &&
            notificationSessionScopeMatches(record.scope, fresh.scope) &&
            ['workspaceId', 'runId', 'slotId'].every(
              (key) =>
                !record.scope[key as keyof NotificationScope] ||
                record.scope[key as keyof NotificationScope] === fresh.scope![key as keyof NotificationScope]
            ) &&
            ((record.subjectState === '95' && ratio >= 0.92) ||
              (record.subjectState === '80' && ratio >= 0.77) ||
              (record.subjectState === '0' && ratio < 0.77))
        )
      }
    )
  }, [ref, open, sessionId, generation, composerId, bindingGeneration, domain, bound])
}
