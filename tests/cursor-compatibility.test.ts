import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorCompatibilityForVersion } from '../src/domain/cursor-compatibility'
import { readCursorCompatibility } from '../src/infrastructure/cursor/cursor-compatibility'
import { appRootOfBundle } from '../src/infrastructure/cursor/cursor-install-paths'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Cursor compatibility metadata', () => {
  it.each(['3.6.31', '3.21.12'])('explicitly selects the audited %s release', (version) => {
    expect(cursorCompatibilityForVersion(version)).toMatchObject({ state: 'supported', version, adapter: version })
  })
  it('never falls back to a known adapter for an unknown or unreadable version', () => {
    expect(cursorCompatibilityForVersion('3.22.0')).toMatchObject({ state: 'unsupported', version: '3.22.0' })
    for (const version of [undefined, '', {}, '3.21.12-beta']) expect(cursorCompatibilityForVersion(version).state).toBe('unavailable')
  })
  it('reads the selected installation and refuses disagreement during an update', () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-cursor-compatibility-')); roots.push(root)
    const bundle = join(root, 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
    mkdirSync(dirname(bundle), { recursive: true })
    const appRoot = appRootOfBundle(bundle)
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version: '3.21.12' }))
    writeFileSync(join(appRoot, 'product.json'), JSON.stringify({ version: '3.6.31' }))
    expect(readCursorCompatibility(bundle)).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('不一致') })
    writeFileSync(join(appRoot, 'product.json'), JSON.stringify({ version: '3.21.12' }))
    expect(readCursorCompatibility(bundle)).toMatchObject({ state: 'supported', adapter: '3.21.12' })
  })
  it('uses Windows path semantics even when tested on macOS', () => {
    expect(appRootOfBundle('D:\\Tools\\Cursor\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js')).toBe('D:\\Tools\\Cursor\\resources\\app')
  })
})
