/** Main-process read-only facts. Never carry message text, attachments or the held session token. */
export interface ChannelQueueFact {
  entryId: string
  channelId: string
  runId?: string
  createdAt: number
  held: boolean
  /** Evidence from an already performed original row read/transaction; main-only, no new query. */
  inspection?: { id: string; sequence: number }
  /** Exact watched id was absent from that original lightweight result. */
  missing?: boolean
  deliveredAt?: number
  withdrawnAt?: number
  retiredAt?: number
  /** Scope committed, but final old-row audit failed. Never claim it is still about to deliver. */
  unconfirmed?: boolean
  unconfirmedAt?: number
}
