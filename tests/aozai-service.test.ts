import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AozaiCardVault } from '../src/application/aozai-card-vault'
import { AozaiService, type AozaiFetch } from '../src/application/aozai-service'
import type { CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'

const NOW = Date.parse('2026-09-21T08:00:00Z')
const EXPIRES = new Date(NOW + 24 * 60 * 60 * 1000).toISOString()
const crypto: CursorAccountVaultCrypto = {
  available: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString().replace(/^encrypted:/, '')
}

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

interface StubResponse {
  ok?: boolean
  status?: number
  data?: unknown
  error?: Error
}

const AUTH_OK = (overrides: Record<string, unknown> = {}): StubResponse => ({
  status: 200,
  data: {
    token: 'bearer-one',
    token_type: 'Bearer',
    expires_at: EXPIRES,
    remaining: 87,
    max_uses: 100,
    points_per_op: 3,
    api_allowed: true,
    used: 13,
    ...overrides
  }
})

function createFetch(queue: StubResponse[], calls: RecordedCall[]): AozaiFetch {
  return async (url, init) => {
    const next = queue.shift()
    if (!next) throw new Error('fetch 队列已空')
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined
    })
    if (next.error) throw next.error
    const status = next.status ?? 200
    return {
      ok: next.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => next.data
    }
  }
}

function createContext(queue: StubResponse[], options: ConstructorParameters<typeof AozaiService>[2] = {}) {
  const calls: RecordedCall[] = []
  const path = join(mkdtempSync(join(tmpdir(), 'sg-aozai-')), 'card.json')
  const vault = new AozaiCardVault(path, crypto, () => NOW)
  const service = new AozaiService(vault, createFetch(queue, calls), {
    pollIntervalMs: 0,
    sleep: async () => {},
    now: () => NOW,
    ...options
  })
  return { calls, path, vault, service }
}

describe('AozaiCardVault', () => {
  it('加密落盘且可读取明文，权限 0o600', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-aozai-card-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto, () => 123)
    expect(vault.maskedCode()).toBeUndefined()
    expect(vault.save('CARD-SECRET-6l8Q')).toBe('••••6l8Q')
    expect(vault.maskedCode()).toBe('••••6l8Q')
    expect(readFileSync(path, 'utf8')).not.toContain('CARD-SECRET-6l8Q')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(vault.credential()).toBe('CARD-SECRET-6l8Q')
    vault.clear()
    expect(vault.maskedCode()).toBeUndefined()
  })

  it('拒绝过短卡密', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-aozai-card-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto)
    expect(() => vault.save('abc')).toThrowError(/卡密长度无效/)
  })

  it('系统钥匙变化时返回可操作提示而不是暴露 safeStorage 底层异常', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-aozai-card-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto)
    vault.save('CARD-SECRET-6l8Q')
    const unreadable = new AozaiCardVault(path, {
      ...crypto,
      decrypt: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') }
    })
    expect(() => unreadable.credential()).toThrowError(/重新粘贴卡密/)
    expect(() => unreadable.credential()).not.toThrowError(/safeStorage/)
  })
})

describe('AozaiService Bearer API', () => {
  it('用卡密换 Bearer，并动态读取点数与单次扣点', async () => {
    const { service, calls } = createContext([AUTH_OK()])
    await expect(service.verifyCard(' CARD-XXXX-6l8Q ')).resolves.toEqual({
      remainingPoints: 87,
      usedPoints: 13,
      maxPoints: 100,
      pointsPerOperation: 3,
      apiAllowed: true
    })
    expect(calls).toEqual([expect.objectContaining({
      url: 'https://getdoubao.com/api/v1/auth/token',
      method: 'POST',
      body: { card_code: 'CARD-XXXX-6l8Q' }
    })])
    expect(calls[0]?.headers).not.toHaveProperty('Authorization')
    expect(calls[0]?.headers).not.toHaveProperty('Cookie')
  })

  it('官方未返回 points_per_op 时不猜 3 点', async () => {
    const { service } = createContext([AUTH_OK({ points_per_op: undefined })])
    const info = await service.verifyCard('CARD-XXXX-6l8Q')
    expect(info).toEqual({ remainingPoints: 87, usedPoints: 13, maxPoints: 100, apiAllowed: true })
    expect(info).not.toHaveProperty('pointsPerOperation')
  })

  it('卡密错误保留服务端 detail；成功响应缺字段时明确报契约错误', async () => {
    await expect(createContext([{ status: 401, data: { detail: '卡密不存在或已停用' } }]).service.verifyCard('BAD-CARD'))
      .rejects.toThrowError(/卡密不存在或已停用/)
    await expect(createContext([{ status: 200, data: { token: 'x' } }]).service.verifyCard('BAD-RESPONSE'))
      .rejects.toThrowError(/认证响应格式异常/)
  })

  it('卡密未开通 API 时在保存阶段明确提示，不等到处理才报 403', async () => {
    const { service } = createContext([AUTH_OK({ api_allowed: false })])
    await expect(service.verifyCard('CARD-NOT-ENABLED')).rejects.toThrowError(/尚未开通 API 调用/)
  })

  it('完整流程只用 Bearer：换票→提交→轮询→GET card 刷新点数', async () => {
    const { service, vault, calls } = createContext([
      AUTH_OK(),
      { status: 200, data: { operation_id: 'op-1', status: 'processing' } },
      { status: 200, data: { status: 'processing', steps: [{ status: 'ok', message: '验证账号' }] } },
      { status: 200, data: { status: 'completed', error: null } },
      { status: 200, data: { remaining: 84, used: 16, max_uses: 100 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const progress: string[] = []
    await expect(service.processToken('user_123::jwt', (state, message) => progress.push(`${state}:${message}`)))
      .resolves.toEqual({ ok: true, message: '处理成功', remainingPoints: 84 })
    expect(calls.map((call) => call.url)).toEqual([
      'https://getdoubao.com/api/v1/auth/token',
      'https://getdoubao.com/api/v1/process',
      'https://getdoubao.com/api/v1/operations/op-1',
      'https://getdoubao.com/api/v1/operations/op-1',
      'https://getdoubao.com/api/v1/card'
    ])
    for (const call of calls.slice(1)) expect(call.headers.Authorization).toBe('Bearer bearer-one')
    expect(calls[1]?.body).toEqual({ session_token: 'user_123::jwt' })
    expect(progress).toContain('processing:验证账号')
  })

  it('维护响应优先于 HTTP 503，并且不进入轮询', async () => {
    const { service, vault, calls } = createContext([
      AUTH_OK(),
      { status: 503, data: { maintenance: true, message: '临时维护，不扣点' } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    await expect(service.processToken('user_123::jwt')).resolves.toEqual({ ok: false, message: '临时维护，不扣点' })
    expect(calls).toHaveLength(2)
  })

  it('受保护接口 401 时只换票一次并重试原请求', async () => {
    const { service, vault, calls } = createContext([
      AUTH_OK({ token: 'expired-token' }),
      { status: 401, data: { detail: '令牌已过期' } },
      AUTH_OK({ token: 'fresh-token' }),
      { status: 200, data: { operation_id: 'op-2' } },
      { status: 200, data: { status: 'completed' } },
      { status: 200, data: { remaining: 84, used: 16, max_uses: 100 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    await expect(service.processToken('user_123::jwt')).resolves.toMatchObject({ ok: true, remainingPoints: 84 })
    expect(calls.filter((call) => call.url.endsWith('/auth/token'))).toHaveLength(2)
    expect(calls[1]?.headers.Authorization).toBe('Bearer expired-token')
    expect(calls[3]?.headers.Authorization).toBe('Bearer fresh-token')
  })

  it('失败使用公开 error 字段并标明不扣点', async () => {
    const { service, vault } = createContext([
      AUTH_OK(),
      { status: 200, data: { operation_id: 'op-3' } },
      { status: 200, data: { status: 'failed', error: 'Token 已过期' } },
      { status: 200, data: { remaining: 87, used: 13, max_uses: 100 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const result = await service.processToken('user_123::jwt')
    expect(result).toEqual({ ok: false, message: 'Token 已过期（失败不扣点）', remainingPoints: 87 })
  })

  it('轮询网络错误达到上限后停止，任务已提交的提示不诱导重复扣点', async () => {
    const queue: StubResponse[] = [
      AUTH_OK(),
      { status: 200, data: { operation_id: 'op-4' } },
      ...Array.from({ length: 5 }, () => ({ error: new Error('socket hang up') }))
    ]
    const { service, vault } = createContext(queue)
    vault.save('CARD-XXXX-6l8Q')
    const result = await service.processToken('user_123::jwt', () => {}, { refreshRemaining: false })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('任务已提交')
    expect(result.message).toContain('刷新点数')
  })

  it('warmup 后处理复用 Bearer，不重复换票', async () => {
    const { service, vault, calls } = createContext([
      AUTH_OK(),
      { status: 200, data: { operation_id: 'op-9' } },
      { status: 200, data: { status: 'completed' } },
      { status: 200, data: { remaining: 84, used: 16, max_uses: 100 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    await service.warmup()
    await expect(service.processToken('user_123::jwt')).resolves.toMatchObject({ ok: true })
    expect(calls.filter((call) => call.url.endsWith('/auth/token'))).toHaveLength(1)
  })

  it('自动化 refreshRemaining:false 完成即返回，不阻塞 GET card', async () => {
    const { service, vault, calls } = createContext([
      AUTH_OK(),
      { status: 200, data: { operation_id: 'op-10' } },
      { status: 200, data: { status: 'completed' } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const result = await service.processToken('user_123::jwt', () => {}, { refreshRemaining: false })
    expect(result).toEqual({ ok: true, message: '处理成功' })
    expect(calls.some((call) => call.url.endsWith('/card'))).toBe(false)
  })

  it('并发预热共享同一次换票请求', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: RecordedCall[] = []
    const path = join(mkdtempSync(join(tmpdir(), 'sg-aozai-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto)
    vault.save('CARD-XXXX-6l8Q')
    const fetch: AozaiFetch = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      await gate
      return { ok: true, status: 200, json: async () => AUTH_OK().data }
    }
    const service = new AozaiService(vault, fetch, { now: () => NOW })
    const first = service.warmup()
    const second = service.warmup()
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    release()
    await Promise.all([first, second])
    expect(calls).toHaveLength(1)
  })

  it('首次刷新直接复用换票余额，后续刷新才 GET card；到期后重新换票', async () => {
    let now = NOW
    const { service, vault, calls } = createContext([
      AUTH_OK({ token: 'token-1' }),
      { status: 200, data: { remaining: 86, used: 14, max_uses: 100 } },
      AUTH_OK({ token: 'token-2', remaining: 80 })
    ], { now: () => now })
    vault.save('CARD-XXXX-6l8Q')
    await expect(service.refreshBalance()).resolves.toMatchObject({ remainingPoints: 87 })
    await expect(service.refreshBalance()).resolves.toMatchObject({ remainingPoints: 86, usedPoints: 14 })
    now += 25 * 60 * 60 * 1000
    await expect(service.refreshBalance()).resolves.toMatchObject({ remainingPoints: 80 })
    expect(calls.map((call) => call.url)).toEqual([
      'https://getdoubao.com/api/v1/auth/token',
      'https://getdoubao.com/api/v1/card',
      'https://getdoubao.com/api/v1/auth/token'
    ])
  })

  it('resetAuthorization 后旧预热响应不得回填共享状态', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: RecordedCall[] = []
    const path = join(mkdtempSync(join(tmpdir(), 'sg-aozai-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto)
    vault.save('CARD-XXXX-6l8Q')
    let call = 0
    const fetch: AozaiFetch = async () => {
      call += 1
      if (call === 1) await gate
      calls.push({ url: '/auth', method: 'POST', headers: {} })
      return { ok: true, status: 200, json: async () => AUTH_OK({ token: `token-${call}` }).data }
    }
    const service = new AozaiService(vault, fetch, { now: () => NOW })
    const stale = service.warmup()
    await Promise.resolve()
    service.resetAuthorization()
    release()
    await stale
    await service.warmup()
    expect(call).toBe(2)
  })

  it('默认按官方建议每 1000ms 轮询', async () => {
    const waits: number[] = []
    const { service, vault } = createContext([
      AUTH_OK(),
      { status: 200, data: { operation_id: 'op-poll' } },
      { status: 200, data: { status: 'processing' } },
      { status: 200, data: { status: 'completed' } }
    ], { pollIntervalMs: undefined, sleep: async (ms) => { waits.push(ms) } })
    vault.save('CARD-XXXX-6l8Q')
    await service.processToken('user_123::jwt', () => {}, { refreshRemaining: false })
    expect(waits).toEqual([1_000, 1_000])
  })

  it('429 使用限流提示；并发处理仍被拒绝', async () => {
    const limited = createContext([AUTH_OK(), { status: 429, data: {} }])
    limited.vault.save('CARD-XXXX-6l8Q')
    await expect(limited.service.processToken('user_123::jwt')).resolves.toEqual({
      ok: false,
      message: '请求过于频繁或服务繁忙，请稍后重试'
    })

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const running = createContext([AUTH_OK(), { status: 200, data: { operation_id: 'op-running' } }], {
      sleep: async () => gate
    })
    running.vault.save('CARD-XXXX-6l8Q')
    const first = running.service.processToken('user_123::jwt', () => {}, { refreshRemaining: false })
    await Promise.resolve(); await Promise.resolve()
    await expect(running.service.processToken('user_456::jwt')).rejects.toThrowError(/进行中/)
    release()
    // 查询队列耗尽后会按网络错误上限退出。
    await first
  })
})
