/** Private, durable reply association. Hashes/reference metadata only; never reply bodies or credentials. */
export interface ReplyIdentityRow {
  key: string
  aliases: string[]
  entryId: string
  failed: boolean
  recorded: boolean
}
export interface ReplyIdentityBatch {
  sourceKey: string
  rows: ReplyIdentityRow[]
  /** New alias associations not necessarily retained in the eight-alias working payload. */
  links?: Array<{ key: string; alias: string }>
  /** Only proven, unrecorded aliases may be consolidated. Two published replies are never guessed into one. */
  merges?: Array<{ from: string; to: string }>
}
/** The payload only keeps a small working set. These are the exact queried aliases owned by its durable row. */
export interface ReplyIdentityMatch { row: ReplyIdentityRow; aliases: string[] }
export const REPLY_IDENTITY_BATCH_LIMIT = 100
export const REPLY_IDENTITY_LOOKUP_LIMIT = 800
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function validReplyIdentityRow(value: unknown): value is ReplyIdentityRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as ReplyIdentityRow
  return Object.keys(row).every(key => ['key', 'aliases', 'entryId', 'failed', 'recorded'].includes(key))
    && digest(row.key) && Array.isArray(row.aliases) && row.aliases.length <= 8
    && row.aliases.every(digest) && new Set(row.aliases).size === row.aliases.length
    && typeof row.entryId === 'string' && row.entryId.length > 0 && row.entryId.length <= 300
    && typeof row.failed === 'boolean' && typeof row.recorded === 'boolean'
}
export function validateReplyIdentityBatch(value: ReplyIdentityBatch): void {
  if (!value || Object.keys(value).some(key => !['sourceKey', 'rows', 'links', 'merges'].includes(key))
    || !/^reply-source:[a-f0-9]{64}$/.test(value.sourceKey) || !Array.isArray(value.rows)
    || value.rows.length > REPLY_IDENTITY_BATCH_LIMIT || value.rows.some(row => !validReplyIdentityRow(row))
    || new Set(value.rows.map(row => row.key)).size !== value.rows.length) throw Error('私有回复身份批次无效')
  if (value.links !== undefined && (!Array.isArray(value.links) || value.links.length > REPLY_IDENTITY_LOOKUP_LIMIT
    || value.links.some(link => !link || Object.keys(link).some(key => !['key', 'alias'].includes(key)) || !digest(link.key) || !digest(link.alias) || !value.rows.some(row => row.key === link.key))
    || new Set(value.links.map(link => `${link.key}:${link.alias}`)).size !== value.links.length)) throw Error('私有回复别名关联无效')
  if (value.merges !== undefined && (!Array.isArray(value.merges) || value.merges.length > REPLY_IDENTITY_BATCH_LIMIT
    || value.merges.some(merge => !merge || Object.keys(merge).some(key => !['from', 'to'].includes(key)) || !digest(merge.from) || !digest(merge.to)
      || merge.from === merge.to || value.rows.some(row => row.key === merge.from) || !value.rows.some(row => row.key === merge.to))
    || new Set(value.merges.map(merge => merge.from)).size !== value.merges.length)) throw Error('私有回复身份归并无效')
}
export function validateReplyIdentityLookup(sourceKey: string, aliases: readonly string[]): void {
  if (!/^reply-source:[a-f0-9]{64}$/.test(sourceKey) || !Array.isArray(aliases) || aliases.length > REPLY_IDENTITY_LOOKUP_LIMIT
    || aliases.some(value => !digest(value)) || new Set(aliases).size !== aliases.length) throw Error('私有回复关联查询无效')
}
