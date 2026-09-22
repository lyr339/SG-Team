import { randomUUID } from 'node:crypto'
import type {
  CursorProcessingProvider,
  ProcessingBalance,
  ProcessingOptions,
  ProcessingProgressState,
  ProcessingResult
} from '../domain/processing-provider'
import type { ProcessingCredentialVault } from './processing-credential-vault'

export interface HenxinFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  getSetCookie(): string[]
}

export type HenxinFetch = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<HenxinFetchResponse>

interface HenxinOptions {
  baseUrl?: string
  pollIntervalMs?: number
  overallTimeoutMs?: number
  maxNetworkErrors?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  createRequestId?: () => string
  requestTimeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://ctk.hxfwq.com'
const USER_AGENT = 'SG-Team/0.4 processing-provider'
const PENDING_STATUS = new Set(['reserved', 'validating', 'queued', 'running', 'retrying', 'processing'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numberField(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function errorOf(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return record(data?.error)
}

/** 痕心：卡密直接作为机器 API Bearer；Cookie 只服务余额查询，不参与处理请求。 */
export class HenxinService implements CursorProcessingProvider {
  readonly id = 'henxin' as const
  readonly label = '痕心'
  readonly unit = 'uses' as const
  private readonly baseUrl: string
  private readonly pollIntervalMs: number
  private readonly overallTimeoutMs: number
  private readonly maxNetworkErrors: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly createRequestId: () => string
  private readonly requestTimeoutMs: number
  private readonly cookies = new Map<string, string>()
  private loginPromise?: Promise<ProcessingBalance>
  private sessionGeneration = 0
  private running = false

  constructor(
    private readonly credentialVault: ProcessingCredentialVault,
    private readonly fetchImpl: HenxinFetch,
    options: HenxinOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.overallTimeoutMs = options.overallTimeoutMs ?? 300_000
    this.maxNetworkErrors = options.maxNetworkErrors ?? 5
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
    this.createRequestId = options.createRequestId ?? randomUUID
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  }

  /** 卡密本身就是机器 API Key；预热只验证本机密文可读，不创建/顶掉网页会话。 */
  async warmup(): Promise<void> {
    this.credentialVault.credential()
  }

  async verifyCredential(code: string): Promise<ProcessingBalance> {
    const credential = code.trim()
    if (!credential) throw new Error('卡密不能为空')
    return this.login(credential, this.sessionGeneration)
  }

  resetAuthorization(): void {
    this.sessionGeneration += 1
    this.loginPromise = undefined
    this.cookies.clear()
  }

  async refreshBalance(): Promise<ProcessingBalance> {
    if (!this.cookies.size) return this.ensureWebSession()
    const response = await this.request('/api/card/session', undefined, undefined, true)
    const data = record(await response.json().catch(() => undefined))
    if (response.status === 401) {
      this.cookies.clear()
      return this.ensureWebSession()
    }
    if (!response.ok || data?.ok === false) throw new Error(this.errorMessage(response.status, data, '余额查询失败'))
    const session = record(data?.session)
    const remaining = numberField(session?.remainingUses)
    if (remaining === undefined) throw new Error('痕心余额响应格式异常：缺少 remainingUses')
    return { unit: this.unit, remaining, costPerOperation: 1 }
  }

  async processToken(
    tokenValue: string,
    onProgress: (state: ProcessingProgressState, message: string) => void = () => {},
    _options: ProcessingOptions = {}
  ): Promise<ProcessingResult> {
    if (this.running) throw new Error('已有处理任务进行中，请等待完成')
    const token = tokenValue.trim()
    if (!token) throw new Error('Session Token 不能为空')
    const credential = this.credentialVault.credential()
    const idempotencyKey = this.createRequestId()
    this.running = true
    try {
      onProgress('submitting', '正在提交痕心处理请求…')
      const submitted = await this.submit(token, credential, idempotencyKey, onProgress)
      if (!submitted.ok || !submitted.operationId || !submitted.pending) return submitted
      onProgress('processing', submitted.message || '已受理，正在跟踪处理进度…')
      return this.trackOperation(submitted.operationId, credential, onProgress, submitted.balance)
    } finally {
      this.running = false
    }
  }

  private async ensureWebSession(): Promise<ProcessingBalance> {
    if (this.loginPromise) return this.loginPromise
    const generation = this.sessionGeneration
    const pending = this.login(this.credentialVault.credential(), generation)
    this.loginPromise = pending
    try {
      return await pending
    } finally {
      if (this.loginPromise === pending) this.loginPromise = undefined
    }
  }

  private async login(code: string, generation: number): Promise<ProcessingBalance> {
    let response: HenxinFetchResponse
    try {
      response = await this.request('/api/card/login', { code })
    } catch {
      throw new Error('网络错误，请确认痕心服务可达后重试')
    }
    const data = record(await response.json().catch(() => undefined))
    if (!response.ok || data?.ok === false) throw new Error(this.errorMessage(response.status, data, '卡密验证失败'))
    const card = record(data?.card)
    const remaining = numberField(data?.remainingUses) ?? numberField(card?.remainingUses)
    if (remaining === undefined) throw new Error('痕心登录响应格式异常：缺少 remainingUses')
    if (generation === this.sessionGeneration) this.absorbCookies(response.getSetCookie())
    return {
      unit: this.unit,
      remaining,
      used: numberField(card?.consumedUses),
      capacity: numberField(card?.totalUses),
      costPerOperation: 1,
      apiAllowed: card?.status === undefined ? undefined : card.status === 'active' && card.expired !== true
    }
  }

  private async submit(
    token: string,
    credential: string,
    idempotencyKey: string,
    onProgress: (state: ProcessingProgressState, message: string) => void
  ): Promise<ProcessingResult & { pending?: boolean }> {
    let response: HenxinFetchResponse | undefined
    let data: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.request('/api/v1/process', { token }, {
          Authorization: `Bearer ${credential}`,
          'Idempotency-Key': idempotencyKey
        })
        data = record(await response.json().catch(() => undefined))
        break
      } catch {
        if (attempt === 0) {
          onProgress('submitting', '网络中断，正在用同一幂等键确认请求结果…')
          continue
        }
      }
    }
    if (!response) {
      return { providerId: this.id, ok: false, message: '请求结果待确认；请先刷新余额或稍后重试，痕心会按幂等键与五分钟保护避免重复执行' }
    }
    if (!response.ok || data?.ok === false) {
      const error = errorOf(data)
      return {
        providerId: this.id,
        ok: false,
        message: this.errorMessage(response.status, data, '提交失败'),
        retryAfterSeconds: numberField(error?.retryAfterSeconds)
      }
    }
    return this.operationResult(data)
  }

  private async trackOperation(
    operationId: string,
    credential: string,
    onProgress: (state: ProcessingProgressState, message: string) => void,
    lastBalance?: ProcessingBalance
  ): Promise<ProcessingResult> {
    const deadline = this.now() + this.overallTimeoutMs
    let networkErrors = 0
    while (this.now() < deadline) {
      await this.sleep(this.pollIntervalMs)
      let response: HenxinFetchResponse
      try {
        response = await this.request(`/api/v1/operations/${encodeURIComponent(operationId)}`, undefined, {
          Authorization: `Bearer ${credential}`
        })
      } catch {
        networkErrors += 1
        if (networkErrors >= this.maxNetworkErrors) {
          return { providerId: this.id, ok: false, operationId, balance: lastBalance, message: '任务已提交但状态查询中断；可稍后重查，切勿换幂等键重复提交' }
        }
        continue
      }
      const data = record(await response.json().catch(() => undefined))
      if (!response.ok || data?.ok === false) {
        networkErrors += 1
        if (response.status === 401 || response.status === 403 || response.status === 404 || networkErrors >= this.maxNetworkErrors) {
          return { providerId: this.id, ok: false, operationId, balance: lastBalance, message: this.errorMessage(response.status, data, '状态查询失败') }
        }
        continue
      }
      networkErrors = 0
      const projected = this.operationResult(data, operationId)
      if (projected.balance) lastBalance = projected.balance
      if (!projected.pending) return projected
      onProgress('processing', projected.message)
    }
    return { providerId: this.id, ok: false, operationId, balance: lastBalance, message: '痕心处理超时，任务仍可能在后台进行；请稍后查询结果' }
  }

  private operationResult(data: Record<string, unknown> | undefined, fallbackId?: string): ProcessingResult & { pending?: boolean } {
    const operation = record(data?.operation) ?? data
    const card = record(data?.card) ?? record(operation?.card)
    const operationId = stringField(operation?.id) ?? stringField(operation?.operationId)
      ?? stringField(operation?.operation_id) ?? fallbackId
    const status = stringField(operation?.status) ?? ''
    const message = stringField(operation?.userMessage) ?? stringField(operation?.message) ?? this.statusMessage(status)
    const balance = this.balanceFrom(card)
    if (status === 'succeeded') return { providerId: this.id, ok: true, operationId, balance, message: message || '处理成功' }
    if (status === 'failed' || status === 'invalid') return { providerId: this.id, ok: false, operationId, balance, message: message || '处理失败（未扣次数）' }
    if (status === 'uncertain') return { providerId: this.id, ok: false, operationId, balance, message: message || '处理结果待确认，请勿重复提交' }
    if (PENDING_STATUS.has(status) && operationId) {
      return { providerId: this.id, ok: true, pending: true, operationId, balance, message: message || '处理中…' }
    }
    return { providerId: this.id, ok: false, operationId, balance, message: message || '痕心响应缺少可识别的 operation 状态' }
  }

  private balanceFrom(card: Record<string, unknown> | undefined): ProcessingBalance | undefined {
    const remaining = numberField(card?.remainingUses)
    if (remaining === undefined) return undefined
    return {
      unit: this.unit,
      remaining,
      used: numberField(card?.consumedUses),
      capacity: numberField(card?.totalUses),
      costPerOperation: 1
    }
  }

  private statusMessage(status: string): string {
    const labels: Record<string, string> = {
      reserved: '已预留次数，正在校验', validating: '正在校验 Token', queued: '已排队',
      running: '正在处理', retrying: '线路波动，服务端正在重试', processing: '正在处理'
    }
    return labels[status] ?? ''
  }

  private errorMessage(status: number, data: Record<string, unknown> | undefined, fallback: string): string {
    const error = errorOf(data)
    const message = stringField(error?.message)
    if (message) return message
    const code = stringField(error?.code)
    if (code === 'CARD_INVALID') return '痕心卡密无效'
    if (code === 'CARD_EXHAUSTED') return '痕心卡密次数已用完'
    if (code === 'CARD_DISABLED') return '痕心卡密已停用'
    if (code === 'CARD_EXPIRED') return '痕心卡密已到期'
    if (status === 429 || code === 'API_RATE_LIMITED') return '痕心请求频繁，请稍后重试'
    if (status === 401) return '痕心卡密认证失败或网页会话已失效'
    return `${fallback}（HTTP ${status}）`
  }

  private absorbCookies(lines: string[]): void {
    for (const line of lines) {
      const pair = line.split(';', 1)[0]
      if (!pair) continue
      const separator = pair.indexOf('=')
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
  }

  private async request(
    path: string,
    body?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
    withCookies = false
  ): Promise<HenxinFetchResponse> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...extraHeaders }
    if (body) headers['Content-Type'] = 'application/json'
    if (withCookies && this.cookies.size) {
      headers.Cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}
