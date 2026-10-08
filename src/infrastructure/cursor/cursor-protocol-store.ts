import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeStoreFileSync } from '../fs/store-file'
import { parseProtocolCapture, parseProtocolQuota, type ProtocolCapture, type ProtocolQuota, type ProtocolSnapshot } from '../../domain/cursor-protocol'

export const PROTOCOL_IMPORT_LIMIT = 1024 * 1024
export class CursorProtocolStore {
  constructor(private readonly path: string) {}
  load(): ProtocolSnapshot {
    if (!existsSync(this.path)) return {}
    if (statSync(this.path).size > PROTOCOL_IMPORT_LIMIT * 2) throw new Error('本机协议记录超出读取上限。')
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as ProtocolSnapshot
      return { capture: data.capture ? parseProtocolCapture(data.capture) : undefined, quota: data.quota ? parseProtocolQuota(data.quota) : undefined }
    } catch { throw new Error('本机协议记录无法读取；未覆盖原文件。') }
  }
  importFile(path: string): ProtocolSnapshot {
    if (!statSync(path).isFile() || statSync(path).size > PROTOCOL_IMPORT_LIMIT) throw new Error('请选择不超过 1 MB 的协议 v1 JSON 文件。')
    let data: unknown
    try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('协议记录不是有效 JSON，未导入。') }
    const capture = parseProtocolCapture(data)
    const current = this.load(), records = new Map(current.capture?.records.map(row=>[row.id,row]))
    for (const row of capture.records) {
      const previous=records.get(row.id)
      if(previous&&(previous.accountScope!==row.accountScope||previous.conversationRef!==row.conversationRef||previous.capturedAt!==row.capturedAt))throw new Error('记录标识与已有来源冲突，未覆盖原数据。')
      records.set(row.id,row)
    }
    if(records.size>200)throw new Error('本机协议记录已超过 200 条；未删除旧记录或导入新记录。')
    const newest=(current.capture?.capturedAt??0)>capture.capturedAt?current.capture!:capture
    const snapshot = { ...current, capture:{...newest,records:[...records.values()].sort((a,b)=>a.capturedAt-b.capturedAt)} }
    this.write(snapshot)
    return snapshot
  }
  saveQuota(quota: ProtocolQuota): ProtocolSnapshot {
    const snapshot = { ...this.load(), quota:parseProtocolQuota(quota) }
    this.write(snapshot)
    return snapshot
  }
  private write(snapshot: { capture?: ProtocolCapture; quota?: ProtocolQuota }): void {
    writeStoreFileSync(this.path, JSON.stringify(snapshot), { mode: 0o600 })
  }
}
