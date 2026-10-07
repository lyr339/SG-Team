/** Opaque private delivery evidence. Neither human reading nor proof of OS display. */
export interface NotificationDeliveryClaim { signalHash: string; contentHash: string; expiresAt: number }
export function validateNotificationDeliveryClaim(value: NotificationDeliveryClaim, now: number): void {
  const time = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000
  if (!value || Object.keys(value).some(key => !['signalHash', 'contentHash', 'expiresAt'].includes(key))
    || typeof value.signalHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.signalHash)
    || typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || !time(value.expiresAt) || !time(now)) throw Error('私有提醒送达身份无效')
}
