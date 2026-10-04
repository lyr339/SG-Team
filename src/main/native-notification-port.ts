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
      notification.once('close', callbacks.closed)
      notification.show()
      return { close: () => { notification.removeAllListeners(); notification.close() } }
    }
  }
}
