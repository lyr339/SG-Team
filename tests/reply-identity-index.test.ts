import { describe, expect, it } from 'vitest'
import { validateReplyIdentityBatch, validReplyIdentityRow } from '../src/domain/reply-identity-index'
const row = { key: '1'.repeat(64), aliases: ['2'.repeat(64)], entryId: 'native:reference', failed: false, recorded: false }
const sourceKey = `reply-source:${'3'.repeat(64)}`
describe('bounded private reply-index transport', () => {
  it('accepts stable hashes and reference metadata without copying text', () => {
    expect(validReplyIdentityRow(row)).toBe(true)
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row] })).not.toThrow()
  })
  it('rejects arbitrary data, other source namespaces, oversized/duplicate or malformed associations', () => {
    for (const changed of [{ ...row, text: 'must not copy' }, { ...row, key: 'plain' }, { ...row, aliases: ['plain'] },
      { ...row, aliases: Array(9).fill('2'.repeat(64)) }, { ...row, entryId: '' }, { ...row, failed: undefined }]) expect(validReplyIdentityRow(changed)).toBe(false)
    expect(() => validateReplyIdentityBatch({ sourceKey: `queue-source:${'3'.repeat(64)}`, rows: [row] })).toThrow()
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row, row] })).toThrow()
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: Array.from({ length: 101 }, (_, i) => ({ ...row, key: i.toString(16).padStart(64, '0') })) })).toThrow()
  })
})

describe('durable reply sidecar cannot become a generic storage payload', () => {
  it('validates new alias links and rejects bodies, missing owners, duplicate links and merge cycles', () => {
    const link = { key: row.key, alias: '4'.repeat(64) }
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row], links: [link] })).not.toThrow()
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row], links: [link, link] })).toThrow()
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row], links: [{ ...link, key: '5'.repeat(64) }] })).toThrow()
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row], links: [{ ...link, body: 'forbidden' } as typeof link] })).toThrow()
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row], merges: [{ from: row.key, to: row.key }] })).toThrow()
    expect(() => validateReplyIdentityBatch({ sourceKey, rows: [row], merges: [{ from: '5'.repeat(64), to: '6'.repeat(64) }] })).toThrow()
  })
})
