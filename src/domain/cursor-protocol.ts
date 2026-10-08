import { z } from 'zod'

const text = z.string().trim().min(1).max(160)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const stamp = count.refine(n => n <= 8.64e15, '时间无效')
const scope = z.string().regex(/^[a-f0-9]{64}$/)
const tokens = z.object({ input: count.optional(), output: count.optional(), cacheRead: count.optional(), cacheWrite: count.optional(), reasoning: count.optional() }).strict()
const parameter = z.object({ id: text, value: text }).strict()
const receipt = z.object({
  timestamp: stamp, conversationRef: scope, model: text, kind: text, productId: text.optional(), subscriptionName: text.optional(),
  input: count, output: count, cacheRead: count, cacheWrite: count, chargedCents: z.number().finite().nonnegative().optional()
}).strict()
const record = z.object({
  id: text, accountScope: scope, capturedAt: stamp, conversationRef: scope, cursorVersion: text,
  model: text, mode: text, parameters: z.array(parameter).max(30), endpoint: z.literal('/agent.v1.AgentService/Run'),
  transport: z.literal('HTTP/2 · Connect/protobuf'), outcome: z.enum(['success', 'rejected', 'incomplete']), errorCode: text.optional(), limitType: text.optional(),
  inputBasis: z.enum(['total-including-cache','unknown']),
  requestFrames: count.max(5000), responseFrames: count.max(5000), usage: tokens.optional(), contextTokens: count.optional(), maxContextTokens: count.optional(),
  frames: z.array(z.object({ index: count, kind: z.enum(['message','end']), flags: count.max(255), bytes: count, fields: z.array(text).max(25) }).strict()).max(500),
  ledger: receipt.optional()
}).strict()
const model = z.object({
  id: text, name: text, contextLimit: count.nullable(), supportsThinking: z.boolean(), supportsMax: z.boolean(),
  parameters: z.array(z.object({ id: text, name: text, options: z.array(parameter).max(60) }).strict()).max(30)
}).strict()
const capture = z.object({ format: z.literal('shiguang.cursor-protocol.v1'), capturedAt: stamp, cursorVersion: text, records: z.array(record).max(200), models: z.array(model).max(300) }).strict()
export type ProtocolReceipt = z.infer<typeof receipt>
export type ProtocolRecord = z.infer<typeof record>
export type ProtocolModel = z.infer<typeof model>
export type ProtocolCapture = z.infer<typeof capture>

export interface ProtocolQuota {
  checkedAt: number
  accountScope: string
  source: 'formal-profile'
  planName: string
  limitType?: string
  cycleEnd?: number
  /** Original API metrics, not silently relabelled as a current pricing pool. */
  percentages: { auto?: number; api?: number; total?: number }
  receipts: ProtocolReceipt[]
}
export interface ProtocolSnapshot { capture?: ProtocolCapture; quota?: ProtocolQuota }

/** Never retain unknown JSON keys: capture imports are not a credential/prompt store. */
export function parseProtocolCapture(value: unknown): ProtocolCapture {
  const result = capture.safeParse(value)
  if (!result.success) throw new Error('不是受支持的脱敏协议记录，或包含无效／多余字段。请导入拾光协议 v1 JSON。')
  const ids = result.data.records.map(row => row.id)
  if (new Set(ids).size !== ids.length) throw new Error('协议记录的标识重复，未导入。')
  for (const row of result.data.records) {
    if (row.outcome === 'success' && row.errorCode) throw new Error('成功记录不能同时携带结束错误。')
    if (row.outcome === 'success' && row.frames.at(-1)?.kind !== 'end') throw new Error('成功记录缺少完整结束帧。')
    if (row.parameters.some(parameter => /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credentials?)$/i.test(parameter.id)
      || /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/.test(parameter.value))) throw new Error('记录中包含疑似凭据参数，未导入。')
    if (row.ledger && !receiptMatches(row, row.ledger)) throw new Error('账本与会话标识、时间或 token 口径不匹配，未导入。')
  }
  return result.data
}
export function parseProtocolQuota(value: unknown): ProtocolQuota {
  return z.object({ checkedAt:stamp,accountScope:scope,source:z.literal('formal-profile'),planName:text,limitType:text.optional(),cycleEnd:stamp.optional(),
    percentages:z.object({auto:z.number().finite().nonnegative().optional(),api:z.number().finite().nonnegative().optional(),total:z.number().finite().nonnegative().optional()}).strict(),receipts:z.array(receipt).max(20)
  }).strict().parse(value)
}

/** Confirm a single-step record by identity + time + exact token totals; no name-only guessing. */
export function receiptMatches(row: ProtocolRecord, bill: ProtocolReceipt): boolean {
  return row.outcome === 'success' && row.inputBasis === 'total-including-cache' && row.conversationRef === bill.conversationRef && Math.abs(row.capturedAt - bill.timestamp) <= 30_000
    && row.usage?.input === bill.input + bill.cacheRead + bill.cacheWrite && row.usage?.output === bill.output
    && row.usage?.cacheRead === bill.cacheRead && row.usage?.cacheWrite === bill.cacheWrite
}
export function recordReceipt(row: ProtocolRecord, quota?: ProtocolQuota): ProtocolReceipt | undefined {
  if (quota && row.accountScope === quota.accountScope) {
    const matches = quota.receipts.filter(bill => receiptMatches(row, bill))
    if(matches.length>1)return undefined
    if(matches.length===1)return matches[0]
  }
  return row.ledger
}
export function protocolBucketLabel(bill?: ProtocolReceipt): string {
  if (!bill) return '额度归属未确认'
  if (bill.productId === 'free' && bill.subscriptionName === 'free') return 'Free 额度订阅'
  return bill.productId ? `订阅 ${bill.productId}` : bill.subscriptionName ? `订阅 ${bill.subscriptionName}` : '账本未返回订阅标识'
}
