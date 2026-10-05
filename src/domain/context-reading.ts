import type { AgentSession } from './agent-session'

/** Shared display/notification boundary. No estimates, cached display values or unbound fallback readings. */
export function nativeContextReading(
  session: AgentSession,
  sampledAt: number | undefined,
  now: number
): { domain: string; ratio: number } | undefined {
  const usage = session.contextUsage
  if (
    session.contextUsageSource !== 'bound' ||
    !session.composerId ||
    session.contextUsageComposerId !== session.composerId ||
    session.telemetry?.state !== 'bound' ||
    typeof sampledAt !== 'number' ||
    !Number.isSafeInteger(sampledAt) ||
    sampledAt < 0 ||
    sampledAt > now + 500 ||
    now - sampledAt > 3_000 ||
    !usage ||
    !Number.isSafeInteger(usage.used) ||
    usage.used! < 0 ||
    !Number.isSafeInteger(usage.limit) ||
    usage.limit! <= 0 ||
    !Number.isFinite(usage.ratio) ||
    usage.ratio < 0 ||
    usage.ratio > 1 ||
    Math.abs(usage.ratio - Math.min(1, usage.used! / usage.limit!)) > 0.02
  )
    return undefined
  return { domain: JSON.stringify([session.contextUsageModelId ?? null, usage.limit]), ratio: usage.ratio }
}
