import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_APP_UPDATE_SETTINGS,
  normalizeAppUpdateSettings,
  type AppUpdateSettings
} from '../domain/app-update'

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
    try {
      if (!existsSync(this.path)) return { settings: { ...DEFAULT_APP_UPDATE_SETTINGS }, runtime: {} }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AppUpdateSettingsFile>
      if (parsed.version !== 1) return { settings: { ...DEFAULT_APP_UPDATE_SETTINGS }, runtime: {} }
      return { settings: normalizeAppUpdateSettings(parsed.settings), runtime: normalizeRuntime(parsed.runtime) }
    } catch {
      return { settings: { ...DEFAULT_APP_UPDATE_SETTINGS }, runtime: {} }
    }
  }

  save(settings: unknown, runtime: AppUpdateRuntimeRecord = this.load().runtime): AppUpdateSettings {
    const normalized = normalizeAppUpdateSettings(settings)
    mkdirSync(dirname(this.path), { recursive: true })
    const file: AppUpdateSettingsFile = { version: 1, settings: normalized, runtime: normalizeRuntime(runtime) }
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
    return normalized
  }
}
