import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
describe('target-specific distribution contract', () => {
  it('does not force the host Electron runtime into a Windows target', () => {
    for (const key of ['pack:win', 'pack:win:dir']) {
      expect(pkg.scripts[key]).toContain('--win --x64 --publish never')
      expect(pkg.scripts[key]).not.toContain('electronDist=node_modules/electron/dist')
    }
    expect(pkg.scripts['pack:mac']).toContain('--mac --arm64')
  })
  it('keeps the Windows shortcut/application identity consistent and includes the actual notification worker, preload and renderer', () => {
    expect(pkg.build.appId).toBe('app.shiguang.team')
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain("app.setAppUserModelId('app.shiguang.team')")
    expect(pkg.build.asar).toBe(true)
    expect(pkg.build.files).toEqual(expect.arrayContaining(['out/main/**/*', 'out/preload/**/*', 'out/renderer/**/*']))
    expect(pkg.build.win.executableName).toBe('ShiGuang')
    expect(pkg.build.nsis.allowToChangeInstallationDirectory).toBe(true)
  })
})
