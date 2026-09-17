import {
  DEFAULT_CURSOR_CDP_SETTINGS,
  normalizeCursorCdpSettings,
  type CursorCdpSettings
} from '../domain/cursor-cdp'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../infrastructure/fs/store-file'

interface CursorCdpSettingsFile {
  version: 1
  settings: CursorCdpSettings
}

/** CDP 设置的本地持久化（userData/cursor-cdp.json，原子写）。 */
export class CursorCdpSettingsStore {
  constructor(readonly path: string) {}

  load(): CursorCdpSettings {
    const file = readStoreJsonSync(this.path)
    if (file.kind !== 'json') return { ...DEFAULT_CURSOR_CDP_SETTINGS }
    const parsed = file.value as Partial<CursorCdpSettingsFile> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      quarantineStoreFileSync(this.path, 'CDP 设置版本或结构不符')
      return { ...DEFAULT_CURSOR_CDP_SETTINGS }
    }
    return normalizeCursorCdpSettings(parsed.settings)
  }

  save(settings: unknown): CursorCdpSettings {
    const normalized = normalizeCursorCdpSettings(settings)
    const file: CursorCdpSettingsFile = { version: 1, settings: normalized }
    writeStoreFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    return normalized
  }
}
