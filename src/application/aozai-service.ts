import type { ProcessingCredentialVault } from './processing-credential-vault'
import type {
  CursorProcessingProvider, ProcessingBalance, ProcessingOptions, ProcessingProgressState, ProcessingResult
} from '../domain/processing-provider'

export interface AozaiFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type AozaiFetch = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<AozaiFetchResponse>

export type AozaiCardInfo = ProcessingBalance

interface AozaiAuthorization extends ProcessingBalance {
  token: string
  expiresAt: number
}

interface AozaiServiceOptions {
  baseUrl?: string
  pollIntervalMs?: number
  overallTimeoutMs?: number
  maxNetworkErrors?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULT_BASE_URL = 'https://getdoubao.com'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const AUTH_EXPIRY_SKEW_MS = 60_000

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function detailOf(data: unknown): string | undefined {
  const detail = asRecord(data)?.detail
  return typeof detail === 'string' && detail.trim() ? detail.trim() : undefined
}

function optionalNumber(data: Record<string, unknown> | undefined, key: string): number | undefined {
  if (data?.[key] === undefined || data[key] === null || data[key] === '') return undefined
  const value = Number(data[key])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function optionalBoolean(data: Record<string, unknown> | undefined, key: string): boolean | undefined {
  return typeof data?.[key] === 'boolean' ? data[key] : undefined
}

function messageOf(data: Record<string, unknown> | undefined, fallback: string): string {
  const message = data?.message
  return typeof message === 'string' && message.trim() ? message.trim() : fallback
}

/**
 * 奥仔公开 API 客户端：卡密只用于换取 24h Bearer，之后所有调用复用内存令牌。
 * Bearer 不落盘、不进入渲染进程；卡密仍由 AozaiCardVault/safeStorage 单独持久化。
 */
export class AozaiService implements CursorProcessingProvider {
  readonly id = 'aozai' as const
  readonly label = '奥仔'
  readonly unit = 'points' as const
  private readonly baseUrl: string
  private readonly pollIntervalMs: number
  private readonly overallTimeoutMs: number
  private readonly maxNetworkErrors: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private authorization?: AozaiAuthorization
  private authorizationPromise?: Promise<AozaiAuthorization>
  private authorizationGeneration = 0
  private running = false

  constructor(
    private readonly cardVault: ProcessingCredentialVault,
    private readonly fetchImpl: AozaiFetch,
    options: AozaiServiceOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.overallTimeoutMs = options.overallTimeoutMs ?? 300_000
    this.maxNetworkErrors = options.maxNetworkErrors ?? 5
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
  }

  /** 倒计时末段预热；未过期令牌直接复用，并发调用只发一次换令牌请求。 */
  async warmup(): Promise<void> {
    await this.ensureAuthorization()
  }

  /** 用指定卡密换取令牌并验证，成功后由 IPC 保存卡密。 */
  async verifyCredential(cardCode: string): Promise<ProcessingBalance> {
    const code = cardCode.trim()
    if (!code) throw new Error('卡密不能为空')
    return this.cardInfo(await this.exchangeCard(code))
  }

  /** 更换或清除卡密时同步作废内存 Bearer，杜绝继续使用上一张卡的令牌。 */
  resetAuthorization(): void {
    this.authorizationGeneration += 1
    this.authorization = undefined
    this.authorizationPromise = undefined
  }

  /** 用已保存卡密查询点数。首次换令牌的响应已含余额，不再额外请求 /card。 */
  async refreshBalance(): Promise<ProcessingBalance> {
    const hadFreshAuthorization = this.hasFreshAuthorization()
    const authorization = await this.ensureAuthorization()
    return hadFreshAuthorization ? this.queryCard() : this.cardInfo(authorization)
  }

  /** 提交 Session Token 并轮询至完成；所有凭据只在主进程内流转。 */
  async processToken(
    sessionToken: string,
    onProgress: (state: ProcessingProgressState, message: string) => void = () => {},
    options: ProcessingOptions = {}
  ): Promise<ProcessingResult> {
    if (this.running) throw new Error('已有处理任务进行中，请等待完成')
    const token = sessionToken.trim()
    if (!token) throw new Error('Session Token 不能为空')
    this.running = true
    try {
      if (!this.hasFreshAuthorization()) onProgress('submitting', '正在认证奥仔自助服务…')
      await this.ensureAuthorization()
      onProgress('submitting', '正在提交处理请求…')
      const submitted = await this.submitProcess(token)
      if (!submitted.ok) return submitted
      onProgress('processing', '已受理，正在跟踪处理进度…')
      const finished = await this.trackOperation(submitted.operationId, onProgress)
      if (options.refreshBalance === false) return finished
      const balance = await this.safeRefreshBalance()
      return { ...finished, ...(balance ? { balance } : {}) }
    } finally {
      this.running = false
    }
  }

  private hasFreshAuthorization(): boolean {
    return Boolean(this.authorization && this.authorization.expiresAt - this.now() > AUTH_EXPIRY_SKEW_MS)
  }

  private async ensureAuthorization(): Promise<AozaiAuthorization> {
    if (this.hasFreshAuthorization()) return this.authorization as AozaiAuthorization
    if (this.authorizationPromise) return this.authorizationPromise
    const pending = this.exchangeCard(this.cardVault.credential(), this.authorizationGeneration)
    this.authorizationPromise = pending
    try {
      return await pending
    } finally {
      if (this.authorizationPromise === pending) this.authorizationPromise = undefined
    }
  }

  private async exchangeCard(cardCode: string, generation = this.authorizationGeneration): Promise<AozaiAuthorization> {
    let response: AozaiFetchResponse
    try {
      response = await this.request('/api/v1/auth/token', { card_code: cardCode })
    } catch {
      throw new Error('网络错误，请确认服务可达后重试')
    }
    const data = asRecord(await response.json().catch(() => undefined))
    if (!response.ok) throw new Error(detailOf(data) ?? `卡密验证失败（HTTP ${response.status}）`)
    const token = typeof data?.token === 'string' ? data.token.trim() : ''
    const expiresAt = typeof data?.expires_at === 'string' ? Date.parse(data.expires_at) : Number.NaN
    const remaining = optionalNumber(data, 'remaining')
    const tokenType = typeof data?.token_type === 'string' ? data.token_type.trim() : 'Bearer'
    if (!token || !Number.isFinite(expiresAt) || remaining === undefined || tokenType.toLowerCase() !== 'bearer') {
      throw new Error('认证响应格式异常：缺少 Bearer、到期时间或点数余额')
    }
    if (data?.api_allowed === false) throw new Error('该卡密尚未开通 API 调用，请先在奥仔服务站同意开通')
    const authorization: AozaiAuthorization = {
      unit: this.unit,
      token,
      expiresAt,
      remaining,
      used: optionalNumber(data, 'used'),
      capacity: optionalNumber(data, 'max_uses'),
      costPerOperation: optionalNumber(data, 'points_per_op'),
      apiAllowed: optionalBoolean(data, 'api_allowed')
    }
    // 清除/换卡期间可能仍有旧预热请求在飞；过期请求可以返回给原调用方，但不得回填共享认证态。
    if (generation === this.authorizationGeneration) this.authorization = authorization
    return authorization
  }

  private cardInfo(value: AozaiAuthorization | ProcessingBalance): ProcessingBalance {
    return {
      unit: this.unit,
      remaining: value.remaining,
      ...(value.used !== undefined ? { used: value.used } : {}),
      ...(value.capacity !== undefined ? { capacity: value.capacity } : {}),
      ...(value.costPerOperation !== undefined ? { costPerOperation: value.costPerOperation } : {}),
      ...(value.apiAllowed !== undefined ? { apiAllowed: value.apiAllowed } : {})
    }
  }

  private async queryCard(): Promise<AozaiCardInfo> {
    const { response, data } = await this.authorizedRequest('/api/v1/card')
    if (!response.ok) throw new Error(this.httpMessage(response.status, data, '余额查询失败'))
    if (data?.api_allowed === false) throw new Error('该卡密的 API 调用已停用，请在奥仔服务站检查状态')
    const remaining = optionalNumber(data, 'remaining')
    if (remaining === undefined) throw new Error('余额响应格式异常：缺少 remaining')
    return this.cardInfo({
      unit: this.unit,
      remaining,
      used: optionalNumber(data, 'used'),
      capacity: optionalNumber(data, 'max_uses'),
      costPerOperation: optionalNumber(data, 'points_per_op') ?? this.authorization?.costPerOperation,
      apiAllowed: optionalBoolean(data, 'api_allowed') ?? this.authorization?.apiAllowed
    })
  }

  private async submitProcess(sessionToken: string): Promise<{ ok: true; operationId: string } | ({ ok: false } & ProcessingResult)> {
    let result: Awaited<ReturnType<AozaiService['authorizedRequest']>>
    try {
      result = await this.authorizedRequest('/api/v1/process', { session_token: sessionToken })
    } catch (error) {
      return { providerId: this.id, ok: false, message: error instanceof Error ? error.message : '网络错误，请检查连接后重试' }
    }
    const { response, data } = result
    if (data?.maintenance === true) {
      return { providerId: this.id, ok: false, message: messageOf(data, '系统维护升级中，请稍后再试。卡密点数不受影响。') }
    }
    if (!response.ok) return { providerId: this.id, ok: false, message: this.httpMessage(response.status, data, '提交失败') }
    const operationId = typeof data?.operation_id === 'string' ? data.operation_id.trim() : ''
    if (!operationId) return { providerId: this.id, ok: false, message: '服务响应缺少 operation_id' }
    return { ok: true, operationId }
  }

  private async trackOperation(
    operationId: string,
    onProgress: (state: ProcessingProgressState, message: string) => void
  ): Promise<ProcessingResult> {
    const deadline = this.now() + this.overallTimeoutMs
    let networkErrors = 0
    let lastStepMessage = ''
    while (this.now() < deadline) {
      await this.sleep(this.pollIntervalMs)
      let result: Awaited<ReturnType<AozaiService['authorizedRequest']>>
      try {
        result = await this.authorizedRequest(`/api/v1/operations/${encodeURIComponent(operationId)}`)
      } catch {
        networkErrors += 1
        if (networkErrors >= this.maxNetworkErrors) {
          return { providerId: this.id, ok: false, message: '网络错误，请检查连接后重试；任务已提交，可稍后刷新点数确认结果', operationId }
        }
        continue
      }
      const { response, data } = result
      if (data?.maintenance === true) {
        return { providerId: this.id, ok: false, message: messageOf(data, '系统维护升级中；任务状态暂不可查询，请稍后刷新点数确认结果'), operationId }
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          return { providerId: this.id, ok: false, message: this.httpMessage(response.status, data, '查询处理状态失败'), operationId }
        }
        networkErrors += 1
        if (networkErrors >= this.maxNetworkErrors) {
          return { providerId: this.id, ok: false, message: this.httpMessage(response.status, data, '查询进度失败，请稍后刷新点数确认结果'), operationId }
        }
        continue
      }
      networkErrors = 0
      const status = typeof data?.status === 'string' ? data.status : ''
      const steps = Array.isArray(data?.steps) ? data.steps : []
      const current = steps.map((step) => asRecord(step)).filter((step): step is Record<string, unknown> => Boolean(step)).pop()
      const stepMessage = typeof current?.message === 'string' ? current.message.trim() : ''
      if (stepMessage && stepMessage !== lastStepMessage) {
        lastStepMessage = stepMessage
        onProgress('processing', stepMessage)
      }
      if (status === 'completed') return { providerId: this.id, ok: true, message: '处理成功', operationId }
      if (status === 'failed') {
        const failedStep = steps
          .map((step) => asRecord(step))
          .find((step) => step?.status === 'fail' && typeof step.message === 'string')
        const reason = typeof data?.error === 'string' && data.error.trim()
          ? data.error.trim()
          : (failedStep?.message as string | undefined)?.trim()
        return { providerId: this.id, ok: false, message: `${reason || '处理失败'}（失败不扣点）`, operationId }
      }
    }
    return { providerId: this.id, ok: false, message: '处理超时，任务仍可能在后台进行；请稍后刷新点数确认结果', operationId }
  }

  private async safeRefreshBalance(): Promise<ProcessingBalance | undefined> {
    try {
      return await this.refreshBalance()
    } catch {
      return undefined
    }
  }

  /** 所有受保护接口统一在此处理一次 401 换票；不叠加旧 Cookie 兼容分支。 */
  private async authorizedRequest(
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ response: AozaiFetchResponse; data: Record<string, unknown> | undefined }> {
    let authorization = await this.ensureAuthorization()
    let response = await this.request(path, body, authorization.token)
    let data = asRecord(await response.json().catch(() => undefined))
    if (response.status === 401) {
      this.resetAuthorization()
      authorization = await this.ensureAuthorization()
      response = await this.request(path, body, authorization.token)
      data = asRecord(await response.json().catch(() => undefined))
    }
    return { response, data }
  }

  private httpMessage(status: number, data: Record<string, unknown> | undefined, fallback: string): string {
    const detail = detailOf(data)
    if (detail) return detail
    if (status === 401) return '认证已过期，请刷新后重试'
    if (status === 403) return '卡密点数不足或当前令牌无权访问该操作'
    if (status === 429) return '请求过于频繁或服务繁忙，请稍后重试'
    if (status === 503) return '奥仔服务维护中，请稍后重试'
    return `${fallback}（HTTP ${status}）`
  }

  private request(path: string, body?: Record<string, unknown>, bearer?: string): Promise<AozaiFetchResponse> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
  }
}
