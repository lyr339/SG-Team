import type { NotificationScope } from '../../../domain/notification'

/** CH alone is never a human-read identity; a replacement Composer/binding cannot consume an old receipt. */
export function notificationSessionScopeMatches(source: NotificationScope, current: NotificationScope): boolean {
  return Boolean(current.sessionId && source.sessionId === current.sessionId
    && (source.channelId === undefined || source.channelId === current.channelId)
    && (source.generation === undefined || source.generation === current.generation)
    && (source.composerId === undefined || source.composerId === current.composerId)
    && (source.bindingGeneration === undefined || source.bindingGeneration === current.bindingGeneration))
}
