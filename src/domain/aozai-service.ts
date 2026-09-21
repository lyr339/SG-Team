export interface AozaiCardStatus {
  saved: boolean
  maskedCode?: string
  remainingPoints?: number
  usedPoints?: number
  maxPoints?: number
  /** 官方认证响应可选字段；缺失时界面不猜测单次扣点。 */
  pointsPerOperation?: number
  apiAllowed?: boolean
}

export type AozaiProgressState = 'submitting' | 'processing' | 'completed' | 'failed'

export interface AozaiProgressEvent {
  requestId: string
  accountId: string
  state: AozaiProgressState
  message: string
}

export interface AozaiProcessResult {
  ok: boolean
  message: string
  remainingPoints?: number
}
