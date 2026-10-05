import { describe, expect, it, vi } from 'vitest'
import { PageOperationNotifications, beginPageOperation, finishPageOperation, failPageOperation, type PageOperationObserver } from '../src/application/notifications/page-operation-notifications'
import { pageOperationReference } from '../src/domain/page-operation-notification'
import { notificationSourceHarness } from './notification-source-fixtures'

describe('page operation observations do not become workflow execution', () => {
  it('a later confirmation closes only exact same-object unknown attempts, never another account or generation', async () => {
    const h = notificationSourceHarness(), source = new PageOperationNotifications(h.owner)
    try {
      await source.flush()
      source.begin({ kind: 'account-login', id: 'old-a', scope: { accountId: 'account-a' } }).finish({ state: 'unconfirmed' })
      source.begin({ kind: 'account-login', id: 'old-b', scope: { accountId: 'account-b' } }).finish({ state: 'unconfirmed' })
      await source.flush()
      source.begin({ kind: 'account-login', id: 'confirmed-a', scope: { accountId: 'account-a' } }).finish({ state: 'success' })
      await source.flush()
      expect(h.ledger.page().records.find(record => record.key.endsWith('old-a'))).toMatchObject({ subjectState: 'superseded', state: 'expired', attention: 'activity' })
      expect(h.ledger.page().records.find(record => record.key.endsWith('old-b'))).toMatchObject({ subjectState: 'unconfirmed', state: 'active', attention: 'notice' })
      source.begin({ kind: 'question-answer', id: 'old-question', scope: { sessionId: 'same-channel-id', generation: '1', composerId: 'composer-a' }, target: { kind: 'session', scope: { channelId: '1', sessionId: 'same-channel-id', generation: '1' }, toolCallId: 'same-tool' } }).finish({ state: 'unconfirmed' })
      await source.flush()
      source.begin({ kind: 'question-answer', id: 'new-generation-answer', scope: { sessionId: 'same-channel-id', generation: '2', composerId: 'composer-b' }, target: { kind: 'session', scope: { channelId: '1', sessionId: 'same-channel-id', generation: '2' }, toolCallId: 'same-tool' } }).finish({ state: 'success' })
      await source.flush()
      expect(h.ledger.page().records.find(record => record.key.endsWith('old-question'))?.subjectState).toBe('unconfirmed')
      source.begin({ kind: 'patch-install', id: 'old-unknown-install' }).finish({ state: 'unconfirmed' }); await source.flush()
      source.begin({ kind: 'patch-install', id: 'other-version-installed' }).finish({ state: 'success' }); await source.flush()
      expect(h.ledger.page().records.find(record => record.key.endsWith('old-unknown-install'))?.subjectState).toBe('unconfirmed')
    } finally { source.dispose(); await h.owner.close() }
  })
  it('repeated display nonces cannot cause two distinct business attempts to collapse into one record', async () => {
    const h = notificationSourceHarness(), source = new PageOperationNotifications(h.owner)
    try {
      await source.flush(); const first = source.begin({ kind: 'account-login', id: 'same-client-nonce' }), second = source.begin({ kind: 'account-login', id: 'same-client-nonce' })
      expect(first.reference.key).not.toBe(second.reference.key)
      first.finish({ state: 'success' }); second.finish({ state: 'failed' }); await source.flush()
      expect(h.ledger.page().summary.total).toBe(2)
    } finally { source.dispose(); await h.owner.close() }
  })
  it('acceptance is quiet; a verified final result updates the same identity once and never receives business input', async () => {
    const h = notificationSourceHarness(), source = new PageOperationNotifications(h.owner, () => 10_000)
    try {
      await source.flush()
      const operation = source.begin({ kind: 'import-fingerprint', id: 'display-id', scope: { providerId: 'roxy' } })
      await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ attention: 'activity', state: 'active', subjectState: 'running' })
      const id = h.ledger.page().records[0]!.id
      const reference = operation.finish({ state: 'success', scope: { accountId: 'actual-saved-id' }, facts: ['已保存并绑定实际窗口。'] }); await source.flush()
      expect(reference).toEqual(pageOperationReference('import-fingerprint', 'display-id'))
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
      expect(h.ledger.page().records[0]).toMatchObject({ id, state: 'resolved', scope: { accountId: 'actual-saved-id', providerId: 'roxy' }, title: '指纹浏览器账号已导入' })
      operation.fail(Error('late second callback')); await source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('success')
    } finally { source.dispose(); await h.owner.close() }
  })
  it('saved account plus login failure is partial, while awaiting checkout remains non-payment-confirmed and archivable', async () => {
    const h = notificationSourceHarness(), source = new PageOperationNotifications(h.owner)
    try {
      await source.flush()
      source.begin({ kind: 'import-card', id: 'card-attempt' }).finish({ state: 'partial', facts: ['账号已保存，登录未完成。'] })
      source.begin({ kind: 'checkout', id: 'checkout-attempt', scope: { accountId: 'original-account' } }).finish({ state: 'waiting', facts: ['结账入口已准备，支付尚未确认。'] })
      await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 2, pending: 0 })
      const checkout = h.ledger.page().records.find(record => record.key.includes('checkout-attempt'))!
      expect(checkout).toMatchObject({ attention: 'notice', state: 'active', title: '结账入口已准备，支付尚未确认' })
      await h.owner.archive(checkout.id); expect(h.ledger.page().summary.total).toBe(1)
      expect(h.ledger.page().records[0]?.title).toBe('账号卡已保存，登录仍未完成')
    } finally { source.dispose(); await h.owner.close() }
  })
  it('unlabelled credentials/card/PII in a raw exception are not copied to the ledger at all', async () => {
    const h = notificationSourceHarness(), source = new PageOperationNotifications(h.owner)
    try {
      await source.flush()
      const error = Object.assign(Error('unlabelled-secret-password /Users/private/path person@example.com user_secret::opaque-token'), { code: 'EACCES' })
      source.begin({ kind: 'account-login', id: 'failed', scope: { accountId: 'frozen-account' } }).fail(error)
      await source.flush()
      const text = JSON.stringify(h.ledger.page()); expect(text).not.toContain('unlabelled-secret'); expect(text).not.toContain('opaque-token'); expect(text).not.toContain('person@example.com'); expect(text).not.toContain('/Users/private')
      expect(h.ledger.page().records[0]?.detail).toContain('访问权限不足')
      expect(error.message).toContain('unlabelled-secret-password') // Original thrown error is untouched.
    } finally { source.dispose(); await h.owner.close() }
  })
  it('restores only actual persisted running evidence as unknown, without declaring success, retrying or replaying a toast', async () => {
    const h = notificationSourceHarness(), source = new PageOperationNotifications(h.owner)
    try {
      await source.flush(); source.begin({ kind: 'patch-install', id: 'old-attempt' }); await source.flush(); source.dispose()
      const pushes = vi.fn(); h.owner.subscribe(pushes)
      const restored = new PageOperationNotifications(h.owner); await restored.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ eventType: 'page.operation.interrupted', subjectState: 'unconfirmed', attention: 'notice', state: 'active' })
      expect(h.ledger.page().records[0]?.detail).toContain('不能据此确认操作已开始')
      expect(pushes.mock.calls.some(([event]) => event.announcement)).toBe(false)
      restored.dispose()
    } finally { source.dispose(); await h.owner.close() }
  })
  it('a current attempt or a late final result cannot be overwritten by a stale initial recovery query', async () => {
    const h = notificationSourceHarness(), source = new PageOperationNotifications(h.owner)
    await source.flush()
    const operation = source.begin({ kind: 'import-browser', id: 'recover-race' }); await source.flush()
    const captured = h.ledger.page({ eventType: 'page.operation.running' })
    let release!: () => void; const gate = new Promise<void>(done => { release = done })
    vi.spyOn(h.owner, 'page').mockImplementationOnce(async () => { await gate; return captured })
    const restored = new PageOperationNotifications(h.owner)
    try {
      operation.finish({ state: 'success', facts: ['真实结果已返回。'] }); await h.owner.flush()
      release(); await restored.flush(); expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'success', eventType: 'page.operation.result' })
    } finally { release(); source.dispose(); restored.dispose(); await h.owner.close() }
  })
  it('a notification callback failure cannot replace an original business result/error or force a repeat', () => {
    const observer: PageOperationObserver = { begin: () => { throw Error('observer failed') } }
    expect(beginPageOperation(observer, { kind: 'import-local' })).toBeUndefined()
    const finish = vi.fn(() => { throw Error('display failed') }), fail = vi.fn(() => { throw Error('display failed') })
    const operation = { reference: { key: 'test' }, finish, fail }
    expect(finishPageOperation(operation, { state: 'success' })).toBeUndefined()
    expect(() => failPageOperation(operation, Error('original'))).not.toThrow()
    expect(finish).toHaveBeenCalledOnce(); expect(fail).toHaveBeenCalledOnce()
  })
})
