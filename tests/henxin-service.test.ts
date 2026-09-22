import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HenxinService, type HenxinFetch } from '../src/application/henxin-service'
import { ProcessingCredentialVault } from '../src/application/processing-credential-vault'
import type { CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'

const crypto: CursorAccountVaultCrypto = {
  available: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString().replace(/^encrypted:/, '')
}
interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }
interface Stub { status?: number; data?: unknown; cookies?: string[]; error?: Error }
function context(queue: Stub[], options: ConstructorParameters<typeof HenxinService>[2] = {}) {
  const calls: Call[] = []
  const vault = new ProcessingCredentialVault(join(mkdtempSync(join(tmpdir(), 'sg-henxin-')), 'card.json'), crypto, '痕心')
  const fetch: HenxinFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined })
    const next = queue.shift()
    if (!next) throw new Error('fetch 队列已空')
    if (next.error) throw next.error
    const status = next.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => next.data, getSetCookie: () => next.cookies ?? [] }
  }
  const service = new HenxinService(vault, fetch, { pollIntervalMs: 0, sleep: async () => {}, createRequestId: () => 'idem-fixed', ...options })
  return { calls, vault, service }
}
const LOGIN_OK: Stub = {
  data: { ok: true, card: { status: 'active', totalUses: 5, consumedUses: 0, remainingUses: 5, expired: false }, remainingUses: 5 },
  cookies: ['card_session=fixture-cookie-value; Path=/; Secure; SameSite=Strict']
}

describe('HenxinService', () => {
  it('登录验证读取次数并只在内存保存 Cookie', async () => {
    const { service, calls } = context([LOGIN_OK])
    await expect(service.verifyCredential(' CTI-CARD ')).resolves.toEqual({
      unit: 'uses', remaining: 5, used: 0, capacity: 5, costPerOperation: 1, apiAllowed: true
    })
    expect(calls[0]).toMatchObject({ url: 'https://ctk.hxfwq.com/api/card/login', body: { code: 'CTI-CARD' } })
    expect(calls[0]?.headers).not.toHaveProperty('Cookie')
  })

  it('warmup 不访问网络；首次刷新登录，随后只读 session', async () => {
    const { service, vault, calls } = context([
      LOGIN_OK,
      { data: { ok: true, session: { remainingUses: 4 } } }
    ])
    vault.save('CTI-CARD')
    await service.warmup()
    expect(calls).toHaveLength(0)
    await expect(service.refreshBalance()).resolves.toMatchObject({ remaining: 5 })
    await expect(service.refreshBalance()).resolves.toEqual({ unit: 'uses', remaining: 4, costPerOperation: 1 })
    expect(calls[1]?.headers.Cookie).toContain('card_session=fixture-cookie-value')
  })

  it('同步成功响应直接返回余额，机器 API 只带 Bearer 卡密与稳定幂等键', async () => {
    const { service, vault, calls } = context([{
      data: {
        ok: true,
        operation: { id: 'op-1', status: 'succeeded', userMessage: '处理成功' },
        card: { totalUses: 5, consumedUses: 1, remainingUses: 4 }
      }
    }])
    vault.save('CTI-CARD')
    await expect(service.processToken('user_abc::jwt')).resolves.toEqual({
      providerId: 'henxin', ok: true, operationId: 'op-1', message: '处理成功',
      balance: { unit: 'uses', remaining: 4, used: 1, capacity: 5, costPerOperation: 1 }
    })
    expect(calls[0]).toMatchObject({
      url: 'https://ctk.hxfwq.com/api/v1/process', body: { token: 'user_abc::jwt' }
    })
    expect(calls[0]?.headers.Authorization).toBe('Bearer CTI-CARD')
    expect(calls[0]?.headers['Idempotency-Key']).toBe('idem-fixed')
    expect(calls[0]?.headers).not.toHaveProperty('Cookie')
  })

  it('中间态按 operation id 查询，直到 succeeded', async () => {
    const { service, vault, calls } = context([
      { data: { ok: true, operation: { id: 'op-2', status: 'queued', userMessage: '已排队' } } },
      { data: { ok: true, operation: { id: 'op-2', status: 'running', userMessage: '正在处理' } } },
      { data: { ok: true, operation: { id: 'op-2', status: 'succeeded', userMessage: '完成' }, card: { remainingUses: 4 } } }
    ])
    vault.save('CTI-CARD')
    const progress: string[] = []
    await expect(service.processToken('user_abc::jwt', (_state, message) => progress.push(message)))
      .resolves.toMatchObject({ ok: true, operationId: 'op-2', balance: { remaining: 4 } })
    expect(calls.map((call) => call.url)).toEqual([
      'https://ctk.hxfwq.com/api/v1/process',
      'https://ctk.hxfwq.com/api/v1/operations/op-2',
      'https://ctk.hxfwq.com/api/v1/operations/op-2'
    ])
    expect(progress).toContain('正在处理')
  })

  it('POST 网络中断只用同一个幂等键重试一次', async () => {
    const { service, vault, calls } = context([
      { error: new Error('socket reset') },
      { data: { ok: true, operation: { id: 'op-3', status: 'succeeded', userMessage: '原任务已完成' }, card: { remainingUses: 4 } } }
    ])
    vault.save('CTI-CARD')
    await expect(service.processToken('user_abc::jwt')).resolves.toMatchObject({ ok: true, operationId: 'op-3' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.headers['Idempotency-Key']).toBe('idem-fixed')
    expect(calls[1]?.headers['Idempotency-Key']).toBe('idem-fixed')
  })

  it('格式错误、限流与 uncertain 都不自动换 key 重提', async () => {
    const invalid = context([{ status: 400, data: { ok: false, error: { code: 'TOKEN_FORMAT_INVALID', message: '无法识别 Token 格式' } } }])
    invalid.vault.save('CTI-CARD')
    await expect(invalid.service.processToken('bad-token')).resolves.toEqual({ providerId: 'henxin', ok: false, message: '无法识别 Token 格式', retryAfterSeconds: undefined })
    expect(invalid.calls).toHaveLength(1)

    const limited = context([{ status: 429, data: { ok: false, error: { code: 'API_RATE_LIMITED', message: '请求频繁，请稍后重试', retryAfterSeconds: 7, scope: 'card' } } }])
    limited.vault.save('CTI-CARD')
    await expect(limited.service.processToken('user_abc::jwt')).resolves.toMatchObject({ ok: false, retryAfterSeconds: 7 })

    const uncertain = context([{ data: { ok: true, operation: { id: 'op-u', status: 'uncertain', userMessage: '结果待确认' } } }])
    uncertain.vault.save('CTI-CARD')
    await expect(uncertain.service.processToken('user_abc::jwt')).resolves.toEqual({ providerId: 'henxin', ok: false, operationId: 'op-u', balance: undefined, message: '结果待确认' })
  })

  it('网页 session 失效时仅余额刷新重新登录；处理 API 不依赖 Cookie', async () => {
    const { service, vault, calls } = context([
      LOGIN_OK,
      { status: 401, data: { ok: false, error: { code: 'SESSION_REQUIRED', message: '请先使用卡密登录' } } },
      { ...LOGIN_OK, data: { ...LOGIN_OK.data as object, remainingUses: 4 } }
    ])
    vault.save('CTI-CARD')
    await service.refreshBalance()
    await expect(service.refreshBalance()).resolves.toMatchObject({ remaining: 4 })
    expect(calls.filter((call) => call.url.endsWith('/card/login'))).toHaveLength(2)
  })
})
