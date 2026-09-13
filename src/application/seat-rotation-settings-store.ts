import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_SEAT_ROTATION_SETTINGS,
  normalizeSeatRotationSettings,
  type SeatRotationSettings
} from '../domain/seat-rotation'

interface SeatRotationSettingsFile {
  version: 1
  settings: SeatRotationSettings
}

/** 席位自动轮换设置的本地持久化（userData/seat-rotation.json，原子写）。 */
export class SeatRotationSettingsStore {
  constructor(readonly path: string) {}

  load(): SeatRotationSettings {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_SEAT_ROTATION_SETTINGS }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SeatRotationSettingsFile>
      if (parsed.version !== 1) return { ...DEFAULT_SEAT_ROTATION_SETTINGS }
      return normalizeSeatRotationSettings(parsed.settings)
    } catch {
      return { ...DEFAULT_SEAT_ROTATION_SETTINGS }
    }
  }

  save(settings: unknown): SeatRotationSettings {
    const normalized = normalizeSeatRotationSettings(settings)
    mkdirSync(dirname(this.path), { recursive: true })
    const file: SeatRotationSettingsFile = { version: 1, settings: normalized }
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
    return normalized
  }
}
