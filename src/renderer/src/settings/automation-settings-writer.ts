import type { AccountAutomationSettings } from '../../../domain/account-automation'
import { DEFAULT_CURSOR_CHECKOUT_PROFILE, type CursorCheckoutProfile } from '../../../domain/cursor-checkout-profile'

type Patch = Omit<Partial<AccountAutomationSettings>, 'checkoutProfile'> & { checkoutProfile?: Partial<CursorCheckoutProfile> }

function difference(base: AccountAutomationSettings, next: AccountAutomationSettings): Patch {
  const patch: Patch = {}
  for (const key of Object.keys({ ...base, ...next }) as (keyof AccountAutomationSettings)[]) {
    if (key !== 'checkoutProfile' && !Object.is(base[key], next[key])) Object.assign(patch, { [key]: next[key] })
  }
  if (next.checkoutProfile) {
    const before = base.checkoutProfile ?? DEFAULT_CURSOR_CHECKOUT_PROFILE
    const changed: Partial<CursorCheckoutProfile> = {}
    for (const key of Object.keys({ ...before, ...next.checkoutProfile }) as (keyof CursorCheckoutProfile)[]) {
      if (before[key] !== next.checkoutProfile[key]) Object.assign(changed, { [key]: next.checkoutProfile[key] })
    }
    if (Object.keys(changed).length) patch.checkoutProfile = changed
  } else if (base.checkoutProfile) patch.checkoutProfile = undefined
  return patch
}

function apply(base: AccountAutomationSettings, patch: Patch): AccountAutomationSettings {
  return { ...base, ...patch, checkoutProfile: Object.hasOwn(patch, 'checkoutProfile')
    ? patch.checkoutProfile ? { ...(base.checkoutProfile ?? DEFAULT_CURSOR_CHECKOUT_PROFILE), ...patch.checkoutProfile } : undefined
    : base.checkoutProfile }
}

/** Renderer-only field intent queue. The existing main-process API remains the
 * authority for normalization and persistence. Rebase each write on its last
 * confirmed result; pending edits overlay it without rolling newer input back. */
export class AutomationSettingsWriter {
  private readonly initial: AccountAutomationSettings
  private confirmed?: AccountAutomationSettings
  private reading?: Promise<AccountAutomationSettings>
  private tail: Promise<unknown> = Promise.resolve()
  private readonly pending: Patch[] = []
  private readonly listeners = new Set<() => void>()
  constructor(private visible: AccountAutomationSettings,
    private readonly read: () => Promise<AccountAutomationSettings>,
    private readonly write: (value: AccountAutomationSettings) => Promise<AccountAutomationSettings>) { this.initial = visible }
  snapshot = (): AccountAutomationSettings => this.visible
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(): void {
    this.visible = this.pending.reduce(apply, this.confirmed ?? this.initial)
    for (const listener of this.listeners) listener()
  }
  load = (): Promise<AccountAutomationSettings> => {
    if (this.confirmed) return Promise.resolve(this.confirmed)
    if (!this.reading) this.reading = this.read().then(value => {
      this.confirmed = value; this.publish(); return value
    }).finally(() => { this.reading = undefined })
    return this.reading
  }
  save = (base: AccountAutomationSettings, next: AccountAutomationSettings): Promise<AccountAutomationSettings> => {
    const patch = difference(base, next)
    if (!Object.keys(patch).length) return this.flush()
    this.pending.push(patch); this.publish()
    const task = this.tail.catch(() => {}).then(async () => {
      try {
        const confirmed = await this.load()
        const saved = await this.write(apply(confirmed, patch))
        this.confirmed = saved
        return saved
      } finally {
        this.pending.splice(this.pending.indexOf(patch), 1)
        this.publish()
      }
    })
    this.tail = task
    // Callers still receive the rejection, but an abandoned UI must not create
    // an unhandled promise or poison later independent edits.
    void task.catch(() => {})
    return task
  }
  flush = async (): Promise<AccountAutomationSettings> => {
    while (this.pending.length) await this.tail
    return this.load()
  }
}
