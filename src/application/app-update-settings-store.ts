import {
  DEFAULT_APP_UPDATE_SETTINGS,
  normalizeAppUpdateSettings,
  type AppUpdateSettings
} from '../domain/app-update'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../infrastructure/fs/store-file'

export interface AppUpdateRuntimeRecord {
  /** 上次成功或失败完成检查的时刻；自动检查的周期从这里起算，跨重启保留。 */
  lastCheckedAt?: number
}

interface AppUpdateSettingsFile {
  version: 1
  settings: AppUpdateSettings
  runtime?: AppUpdateRuntimeRecord
}

function normalizeRuntime(value: unknown): AppUpdateRuntimeRecord {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const lastCheckedAt = typeof raw.lastCheckedAt === 'number' && Number.isFinite(raw.lastCheckedAt) && raw.lastCheckedAt > 0
    ? raw.lastCheckedAt
    : undefined
  return lastCheckedAt !== undefined ? { lastCheckedAt } : {}
}

/** 自更新设置与检查记录的本地持久化（userData/app-update.json，原子写，0o600）。 */
export class AppUpdateSettingsStore {
  constructor(readonly path: string) {}

  load(): { settings: AppUpdateSettings; runtime: AppUpdateRuntimeRecord } {
    const file = readStoreJsonSync(this.path)
    if (file.kind !== 'json') return { settings: { ...DEFAULT_APP_UPDATE_SETTINGS }, runtime: {} }
    const parsed = file.value as Partial<AppUpdateSettingsFile> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      quarantineStoreFileSync(this.path, '自更新设置版本或结构不符')
      return { settings: { ...DEFAULT_APP_UPDATE_SETTINGS }, runtime: {} }
    }
    return { settings: normalizeAppUpdateSettings(parsed.settings), runtime: normalizeRuntime(parsed.runtime) }
  }

  save(settings: unknown, runtime: AppUpdateRuntimeRecord = this.load().runtime): AppUpdateSettings {
    const normalized = normalizeAppUpdateSettings(settings)
    const file: AppUpdateSettingsFile = { version: 1, settings: normalized, runtime: normalizeRuntime(runtime) }
    writeStoreFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    return normalized
  }
}
