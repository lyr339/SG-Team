import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface NotificationRuntimeMarker { version: 1; startedAt: number; closedAt?: number; historyIncomplete: boolean }

/** Tiny private quit evidence, not a notification queue or a business database. No messages, paths or credentials are stored. */
export class NotificationRuntimeJournal {
  private marker?: NotificationRuntimeMarker
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  open(): { historyIncomplete: boolean } {
    if (this.marker) return { historyIncomplete: this.marker.historyIncomplete }
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
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
        || value.closedAt !== undefined && (!Number.isSafeInteger(value.closedAt) || value.closedAt < 0) || typeof value.historyIncomplete !== 'boolean') throw Error('通知退出记录格式异常，原文件保留')
      previous = value
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const historyIncomplete = Boolean(previous && (previous.closedAt === undefined || previous.historyIncomplete))
    this.write({ version: 1, startedAt: this.now(), historyIncomplete })
    return { historyIncomplete }
  }
  finish(confirmed: boolean, historyIncomplete: boolean): void {
    if (!this.marker) throw Error('通知退出记录尚未启用')
    this.write({ version: 1, startedAt: this.marker.startedAt, historyIncomplete: this.marker.historyIncomplete || historyIncomplete || !confirmed,
      ...(confirmed ? { closedAt: this.now() } : {}) })
  }
  private write(marker: NotificationRuntimeMarker): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.pending-${process.pid}`
    try { writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 }); renameSync(temporary, this.path); this.marker = marker }
    finally { rmSync(temporary, { force: true }) }
  }
}
