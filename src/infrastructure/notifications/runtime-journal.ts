import { createHash, randomUUID } from 'node:crypto'
import { validateNotificationGapId } from '../../domain/notification-history'
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface NotificationRuntimeMarker { version: 1 | 2; startedAt: number; closedAt?: number; historyIncomplete: boolean; runtimeId?: string; gapId?: string }
function legacyGapId(startedAt: number): string {
  const hash = createHash('sha256').update(`notification-runtime-v1:${startedAt}`).digest('hex').slice(0, 32)
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`
}

/** Tiny private quit evidence, not a notification queue or a business database. No messages, paths or credentials are stored. */
export class NotificationRuntimeJournal {
  private marker?: NotificationRuntimeMarker
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  open(): { historyIncomplete: boolean; gapId?: string } {
    if (this.marker) return { historyIncomplete: this.marker.historyIncomplete, ...(this.marker.gapId ? { gapId: this.marker.gapId } : {}) }
    let previous: NotificationRuntimeMarker | undefined
    try {
      const file = openSync(this.path, 'r')
      let text: string
      try {
        const buffer = Buffer.alloc(4_097), size = readSync(file, buffer, 0, buffer.length, 0)
        if (size > 4_096) throw Error('通知退出记录过大，原文件保留')
        text = buffer.subarray(0, size).toString('utf8')
      } finally { closeSync(file) }
      const value = JSON.parse(text) as NotificationRuntimeMarker
      if (!value || ![1, 2].includes(value.version) || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
        || value.closedAt !== undefined && (!Number.isSafeInteger(value.closedAt) || value.closedAt < 0) || typeof value.historyIncomplete !== 'boolean') throw Error('通知退出记录格式异常，原文件保留')
      if (value.version === 2) { if (!value.runtimeId) throw Error('通知退出记录身份缺失'); validateNotificationGapId(value.runtimeId); if (value.gapId) validateNotificationGapId(value.gapId) }
      if (value.version === 1) { delete value.runtimeId; delete value.gapId }
      previous = value
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const historyIncomplete = Boolean(previous && (previous.closedAt === undefined || previous.historyIncomplete))
    const gapId = previous && historyIncomplete ? previous.closedAt === undefined ? previous.runtimeId ?? legacyGapId(previous.startedAt) : previous.gapId ?? legacyGapId(previous.startedAt) : undefined
    this.write({ version: 2, runtimeId: randomUUID(), startedAt: this.now(), historyIncomplete, ...(gapId ? { gapId } : {}) })
    return { historyIncomplete, ...(gapId ? { gapId } : {}) }
  }
  finish(confirmed: boolean, historyIncomplete: boolean, gapId?: string): void {
    if (!this.marker) throw Error('通知退出记录尚未启用')
    if (gapId) validateNotificationGapId(gapId)
    const observedGap = confirmed ? gapId ?? this.marker.gapId : this.marker.runtimeId
    this.write({ version: 2, runtimeId: this.marker.runtimeId, ...(observedGap ? { gapId: observedGap } : {}), startedAt: this.marker.startedAt, historyIncomplete: this.marker.historyIncomplete || historyIncomplete || !confirmed || Boolean(observedGap),
      ...(confirmed ? { closedAt: this.now() } : {}) })
  }
  private write(marker: NotificationRuntimeMarker): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.pending-${process.pid}`
    try { writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 }); renameSync(temporary, this.path); this.marker = marker }
    finally { rmSync(temporary, { force: true }) }
  }
}
