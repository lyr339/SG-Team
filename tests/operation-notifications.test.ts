import { describe, expect, it } from 'vitest'
import { processingNotification } from '../src/domain/processing-notification'
import { storageCleanupNotification } from '../src/domain/storage-cleanup-notification'
describe('cross-page operation facts', () => {
  it('keeps frozen request/provider/account ownership and does not imply automation follows a standalone processing result', () => {
    const value = processingNotification({ providerId: 'henxin', requestId: 'request-1', accountId: 'original-account', result: { providerId: 'henxin', ok: true, message: 'confirmed' }, now: 100 })
    expect(value.scope).toEqual({ providerId: 'henxin', accountId: 'original-account' })
    expect(value.origin).toEqual({ module: 'account', section: 'accounts' })
    expect(value.detail).toContain('不代表后续加固、换号或清场已经执行')
    expect(value.key).toBe('processing:henxin:request-1')
  })
  it('non-success and missing replies are not proof a submitted request never executed', () => {
    const value = processingNotification({ providerId: 'aozai', requestId: 'request-1', result: { providerId: 'aozai', ok: false, message: 'uncertain' }, now: 100 })
    expect(value.detail).toContain('不代表请求没有执行')
    expect(value.attention).toBe('notice')
    expect(processingNotification({ providerId: 'aozai', requestId: 'request-2', submitted: false, error: 'credential missing', now: 100 }).detail).toContain('没有进入处理服务')
  })
  it('uses confirmed cleanup counts, not a pre-operation estimate, and preserves skipped outcomes', () => {
    const value = storageCleanupNotification('op-1', { ok: false, freedBytes: 1_024, done: ['logs'], skipped: [{ id: 'caches', reason: 'in use' }], message: 'partial' }, undefined, 100)
    expect(value.title).toContain('部分项目')
    expect(value.detail).toContain('1.0 KB'); expect(value.detail).toContain('in use')
    expect(storageCleanupNotification('op-2', undefined, 'original interrupted result', 100).detail).toContain('不证明所有清理项都未执行')
  })
})
