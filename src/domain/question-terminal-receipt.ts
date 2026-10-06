/** Private terminal evidence only; no prompt, answers, options or original parameters. */
export interface QuestionTerminalReceipt { identity: string; status: 'submitted' | 'cancelled' }
export interface QuestionTerminalBatch { sourceKey: string; rows: QuestionTerminalReceipt[] }
export const QUESTION_TERMINAL_BATCH_LIMIT = 100
export function validateQuestionTerminalLookup(sourceKey: string, identities: readonly string[]): void {
  if (!/^questions:[a-f0-9]{64}$/.test(sourceKey) || !Array.isArray(identities) || identities.length > QUESTION_TERMINAL_BATCH_LIMIT
    || identities.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) || new Set(identities).size !== identities.length) throw Error('私有问卷终态查询无效')
}
export function validateQuestionTerminalBatch(batch: QuestionTerminalBatch): void {
  if (!batch || Object.keys(batch).some(key => !['sourceKey', 'rows'].includes(key)) || !Array.isArray(batch.rows)
    || batch.rows.some(row => !row || Object.keys(row).some(key => !['identity', 'status'].includes(key)) || !['submitted', 'cancelled'].includes(row.status))) throw Error('私有问卷终态批次无效')
  validateQuestionTerminalLookup(batch.sourceKey, batch.rows.map(row => row.identity))
}
