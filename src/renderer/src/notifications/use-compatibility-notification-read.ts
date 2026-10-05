import { useEffect, type RefObject } from 'react'
import type { CursorSwitchPumpStatus } from '../../../domain/cursor-switch-pump'
import { cursorCompatibilityIssue } from '../../../domain/cursor-compatibility-notification'
import { observeSourceNotificationRead } from './observe-source-read'

/** Only the latest visible status for the same exact inspected installation/version. No installation probe. */
export function useCompatibilityNotificationRead(
  ref: RefObject<HTMLElement | null>,
  status: CursorSwitchPumpStatus | undefined,
  busy: boolean
): void {
  const installationId = status?.installationId,
    version = status?.compatibility?.version,
    kind = status?.kind,
    compatibility = status?.compatibility?.state,
    profileReady = status?.profileRefreshReady
  useEffect(() => {
    const element = ref.current,
      api = window.sgDesktop
    if (
      !element ||
      busy ||
      !status ||
      !status.compatibility ||
      (status.kind === 'installed' && status.profileRefreshReady === undefined) ||
      !api?.getNotificationPage ||
      !api.onNotificationChanged
    )
      return
    const issue = cursorCompatibilityIssue({
      installationId,
      version,
      patch: kind!,
      compatibility: compatibility ?? 'unavailable',
      profileRefreshReady: profileReady
    })
    return observeSourceNotificationRead(
      element,
      api,
      { eventType: 'cursor.compatibility', ...(installationId ? { installationId } : {}), limit: 1 },
      (record) =>
        record.eventType === 'cursor.compatibility' &&
        record.scope.installationId === installationId &&
        record.scope.cursorVersion === version &&
        record.subjectState === (issue ?? 'confirmed')
    )
  }, [ref, busy, installationId, version, kind, compatibility, profileReady])
}
