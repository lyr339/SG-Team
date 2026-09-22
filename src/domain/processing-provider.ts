export const PROCESSING_PROVIDER_IDS = ['aozai', 'henxin'] as const
export type ProcessingProviderId = typeof PROCESSING_PROVIDER_IDS[number]
export type ProcessingBalanceUnit = 'points' | 'uses'

export const PROCESSING_PROVIDER_LABEL: Record<ProcessingProviderId, string> = {
  aozai: '奥仔',
  henxin: '痕心'
}

export function normalizeProcessingProviderId(value: unknown): ProcessingProviderId {
  return value === 'henxin' ? 'henxin' : 'aozai'
}

export interface ProcessingBalance {
  unit: ProcessingBalanceUnit
  remaining: number
  used?: number
  capacity?: number
  costPerOperation?: number
  apiAllowed?: boolean
}

export interface ProcessingCredentialStatus extends Partial<ProcessingBalance> {
  providerId: ProcessingProviderId
  label: string
  saved: boolean
  maskedCode?: string
}

export type ProcessingProgressState = 'submitting' | 'processing' | 'completed' | 'failed'

export interface ProcessingProgressEvent {
  providerId: ProcessingProviderId
  requestId: string
  accountId: string
  state: ProcessingProgressState
  message: string
}

export interface ProcessingResult {
  providerId: ProcessingProviderId
  ok: boolean
  message: string
  balance?: ProcessingBalance
  operationId?: string
  retryAfterSeconds?: number
}

export interface ProcessingOptions {
  /** 完成后是否主动查询余额；服务响应自带余额时实现可直接返回。 */
  refreshBalance?: boolean
}

export interface CursorProcessingProvider {
  readonly id: ProcessingProviderId
  readonly label: string
  readonly unit: ProcessingBalanceUnit
  verifyCredential(code: string): Promise<ProcessingBalance>
  warmup(): Promise<void>
  refreshBalance(): Promise<ProcessingBalance>
  processToken(
    token: string,
    onProgress?: (state: ProcessingProgressState, message: string) => void,
    options?: ProcessingOptions
  ): Promise<ProcessingResult>
  resetAuthorization(): void
}
