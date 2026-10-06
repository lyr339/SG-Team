import type { ConversationEntry } from './conversation-entry'

/** A restored/imported body or a neighbouring channel is not an original Cursor result. */
export function nativeAssistantEntry(entry: ConversationEntry, channelId: string): boolean {
  return entry.role === 'assistant' && entry.source === 'cursor' && entry.channelId === channelId
}
