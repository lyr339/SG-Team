import { Notification } from 'electron'
import type { NotificationNativePort } from '../application/notification-delivery-service'

/** No permission probe/test notification. Only an already user-enabled delivery creates a native notice. */
export function createNativeNotificationPort(platform: NodeJS.Platform = process.platform): NotificationNativePort {
  return {
    supported: () => (platform === 'darwin' || platform === 'win32') && Notification.isSupported(),
    show: (content, callbacks) => {
      const notification = new Notification({ ...content, timeoutType: 'default' })
      notification.once('click', callbacks.clicked)
      notification.once('failed', callbacks.failed)
      notification.once('show', callbacks.shown)
      notification.on('close', details => {
        if (platform !== 'win32') { callbacks.closed('dismissed'); return }
        const reason = details && typeof details === 'object' ? details.reason : undefined
        callbacks.closed(reason === 'timedOut' ? 'timed-out' : reason === 'userCanceled' ? 'dismissed' : reason === 'applicationHidden' ? 'programmatic' : 'unknown')
      })
      try { notification.show() }
      catch (error) { notification.removeAllListeners(); try { notification.close() } catch {}; throw error }
      return { close: () => { notification.removeAllListeners(); notification.close() } }
    }
  }
}
