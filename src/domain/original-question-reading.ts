import type { ConversationEntry, ProcessBlockTool } from './conversation-entry'

/** Main-only receipt from existing SQL reads/successful persistence, never a public snapshot or answer permission. */
export interface OriginalQuestionHistory {
  current(): boolean
  contains(entry: ConversationEntry, block: ProcessBlockTool): boolean
  stamp(entry: ConversationEntry, toolCallId: string, blockId: string): string | undefined
}
export type OriginalQuestionHistoryReader = (channelId: string, entries: readonly ConversationEntry[], runId: string | undefined) => OriginalQuestionHistory | undefined
