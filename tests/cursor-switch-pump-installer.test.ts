import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CursorSwitchPumpInstaller,
  PROFILE_REFRESH_HOOK,
  SWITCH_PUMP_OWNER,
  analyzeSwitchPump,
  assertJavaScriptSyntax,
  describeBundleWriteFailure,
  installProfileRefreshHook,
  installSwitchPump,
  removeSwitchPumpFromSource,
  switchPumpMatches
} from '../src/infrastructure/cursor/cursor-switch-pump-installer'
import { CursorRuntimeCompanionConfig } from '../src/infrastructure/cursor/cursor-runtime-companion-config'

const config = { port: 51_824, key: 'unit-test-key', revision: 1 }
const authSource = `class AuthenticationService {
  constructor() {
    this.overrideAccessToken = undefined;
    this.storageService = { store() {}, flush() {} };
    this.notifyLoginChangedListeners = () => {};
    this.storeEmailAndSignUpType = () => {};
    this.storeAccessRefreshToken = () => {};
  }
}`
const footer = 'function FZ1(){kn(()=>{if(!e.signedIn()){s(Fvf),a(!1);return}loadProfile()})}'
const source = `${authSource}\n${footer}`

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function appFixture(version = '3.6.31', bundleSource = source) {
  const root = mkdtempSync(join(tmpdir(), 'sg-switch-pump-'))
  tempRoots.push(root)
  const appRoot = join(root, 'Cursor.app', 'Contents', 'Resources', 'app')
  const bundlePath = join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
  mkdirSync(dirname(bundlePath), { recursive: true })
  writeFileSync(bundlePath, bundleSource)
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(appRoot, 'product.json'), JSON.stringify({ version, checksums: { 'vs/workbench/workbench.desktop.main.js': 'old' } }))
  return { root, appRoot, bundlePath }
}

describe('CursorSwitchPumpInstaller', () => {
  it('uses the same async locator for status, install, config and removal, and rechecks after changing installs', async () => {
    const first = appFixture()
    const second = appFixture()
    let current = first.bundlePath
    const installer = new CursorSwitchPumpInstaller({ locateBundle: async () => current, execFn: async () => {} })
    expect(await installer.status()).toMatchObject({ bundlePath: first.bundlePath, kind: 'not-installed' })
    expect(await installer.ensure(config)).toMatchObject({ ok: true })
    expect(await installer.readInstalledConfig()).toEqual(config)
    current = second.bundlePath
    expect(await installer.status()).toMatchObject({ bundlePath: second.bundlePath, kind: 'not-installed' })
    expect(await installer.readInstalledConfig()).toBeUndefined()
    expect(await installer.ensure(config)).toMatchObject({ ok: true })
    expect(await installer.remove()).toMatchObject({ ok: true })
    // The independent profile refresh hook remains when only the pump is removed.
    expect(readFileSync(second.bundlePath, 'utf8').replace(`${PROFILE_REFRESH_HOOK}e.displayEmail();`, '')).toBe(source)
    expect(analyzeSwitchPump(readFileSync(first.bundlePath, 'utf8')).installed).toBe(true)
  })

  it('requires one ordered authentication constructor and all nearby behavior markers', () => {
    expect(analyzeSwitchPump(source)).toMatchObject({ supported: true, installed: false, injectionIndex: expect.any(Number) })
    expect(analyzeSwitchPump(source.replace('this.overrideAccessToken = undefined;', 'this.overrideAccessToken = undefined; this.overrideAccessToken = null;')))
      .toMatchObject({ supported: false, reason: expect.stringContaining('锚点不唯一') })
    expect(analyzeSwitchPump(source.replace('this.notifyLoginChangedListeners = () => {};', '')))
      .toMatchObject({ supported: false, reason: expect.stringContaining('notifyLoginChangedListeners') })
  })

  it('adds one idempotent async profile dependency without touching surrounding sidebar code', () => {
    const footer = 'function FZ1(){kn(()=>{if(!e.signedIn()){s(Fvf),a(!1);return}loadProfile()})}'
    const installed = installProfileRefreshHook(footer)
    expect(installed).toMatchObject({ ok: true, changed: true })
    expect(installed.source).toContain(`${PROFILE_REFRESH_HOOK}e.displayEmail();if(!e.signedIn())`)
    expect(installProfileRefreshHook(installed.source)).toMatchObject({ ok: true, changed: false })
    expect(installProfileRefreshHook('no footer')).toMatchObject({ ok: false, changed: false })
    expect(installProfileRefreshHook(`${footer}${PROFILE_REFRESH_HOOK}`)).toMatchObject({ ok: false, changed: false })
    expect(installProfileRefreshHook(`${installed.source}${PROFILE_REFRESH_HOOK}`)).toMatchObject({ ok: false, changed: false })
  })

  it('installs, re-reads and removes an owned pump idempotently', () => {
    const installed = installSwitchPump(source, config)
    expect(installed).toMatchObject({ ok: true, changed: true })
    expect(installed.source).toContain(SWITCH_PUMP_OWNER)
    expect(analyzeSwitchPump(installed.source)).toMatchObject({ installed: true, supported: true, managed: true, config })
    expect(switchPumpMatches(installed.source, config)).toBe(true)
    expect(installSwitchPump(installed.source, config)).toMatchObject({ ok: true, changed: false })
    expect(switchPumpMatches(installed.source, { ...config, revision: 2 })).toBe(false)
    expect(installSwitchPump(installed.source, { ...config, revision: 2 })).toMatchObject({ ok: true, changed: true })
    const removed = removeSwitchPumpFromSource(installed.source)
    expect(removed).toMatchObject({ ok: true, changed: true, source })
  })

  it('reuses but never overwrites or removes another tool\'s compatible pump', () => {
    const owned = installSwitchPump(source, config).source
    const external = owned.replace(SWITCH_PUMP_OWNER, '')
    expect(analyzeSwitchPump(external)).toMatchObject({ installed: true, managed: false })
    expect(installSwitchPump(external, { ...config, port: 51_825 })).toMatchObject({ ok: false, changed: false, message: expect.stringContaining('不覆盖') })
    expect(removeSwitchPumpFromSource(external)).toMatchObject({ ok: false, changed: false, message: expect.stringContaining('不执行卸载') })
  })

  it('writes atomically, updates checksum, signs deeply, reports ownership and can uninstall', async () => {
    const fixture = appFixture()
    const execFn = vi.fn(async () => {})
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath, execFn })
    expect(await installer.status()).toMatchObject({ kind: 'not-installed' })
    expect(await installer.ensure(config)).toMatchObject({ ok: true, changed: true })
    expect(await installer.status()).toMatchObject({ kind: 'installed', managed: true, config })
    expect(readFileSync(`${fixture.bundlePath}.sg-runtime-switch-backup-3.6.31`, 'utf8')).toBe(source)
    expect(JSON.parse(readFileSync(join(fixture.appRoot, 'product.json'), 'utf8')).checksums['vs/workbench/workbench.desktop.main.js']).not.toBe('old')
    if (process.platform === 'darwin') {
      expect(execFn).toHaveBeenCalledWith('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', join(fixture.root, 'Cursor.app')])
    }
    expect(await installer.ensure(config)).toMatchObject({ ok: true, changed: false })
    expect(await installer.remove()).toMatchObject({ ok: true, changed: true })
    expect(await installer.status()).toMatchObject({ kind: 'not-installed' })
  })

  it('windows: turns EPERM/EBUSY bundle write failures into actionable guidance and keeps the raw error', () => {
    const eperm = Object.assign(new Error("EPERM: operation not permitted, rename 'x.tmp' -> 'x'"), { code: 'EPERM' })
    const perUser = 'C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js'
    const perUserMessage = describeBundleWriteFailure(eperm, perUser, 'win32')
    expect(perUserMessage).toMatch(/^写 Workbench 失败（EPERM）：先完全退出 Cursor/)
    expect(perUserMessage).toContain('杀毒软件')
    expect(perUserMessage).not.toContain('Program Files')
    expect(perUserMessage).toContain('原始错误：EPERM: operation not permitted')
    // 「所有用户」安装：多出管理员权限的提示。
    const allUsers = 'C:\\Program Files\\Cursor\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js'
    expect(describeBundleWriteFailure(Object.assign(new Error('busy'), { code: 'EBUSY' }), allUsers, 'win32'))
      .toContain('「所有用户」安装（Program Files）')
    // 非 Windows 或非权限/占用类错误：保持原有口径。
    expect(describeBundleWriteFailure(eperm, perUser, 'darwin')).toBe("写 Workbench 失败：EPERM: operation not permitted, rename 'x.tmp' -> 'x'")
    expect(describeBundleWriteFailure(Object.assign(new Error('disk full'), { code: 'ENOSPC' }), perUser, 'win32')).toBe('写 Workbench 失败：disk full')
  })

  it('leaves an external compatible pump byte-for-byte unchanged', async () => {
    const fixture = appFixture()
    const external = installProfileRefreshHook(installSwitchPump(source, config).source).source.replace(SWITCH_PUMP_OWNER, '')
    writeFileSync(fixture.bundlePath, external)
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath, execFn: vi.fn(async () => {}) })
    expect(await installer.status()).toMatchObject({ kind: 'installed', managed: false })
    expect(await installer.ensure({ ...config, port: 51_825, key: 'different' })).toMatchObject({ ok: true, changed: false, message: expect.stringContaining('直接复用') })
    expect(await installer.remove()).toMatchObject({ ok: false, changed: false })
    expect(readFileSync(fixture.bundlePath, 'utf8')).toBe(external)
  })

  it('preserves an external pump while adding the independent profile refresh hook', async () => {
    const fixture = appFixture()
    const footer = 'function FZ1(){kn(()=>{if(!e.signedIn()){s(Fvf),a(!1);return}loadProfile()})}'
    const external = installSwitchPump(`${authSource}\n${footer}`, config).source.replace(SWITCH_PUMP_OWNER, '')
    writeFileSync(fixture.bundlePath, external)
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath, execFn: vi.fn(async () => {}) })
    expect(await installer.ensure({ ...config, port: 51_825, key: 'different' })).toMatchObject({ ok: true, changed: true })
    const readback = readFileSync(fixture.bundlePath, 'utf8')
    expect(readback).toContain(PROFILE_REFRESH_HOOK)
    expect(readback.replace(`${PROFILE_REFRESH_HOOK}e.displayEmail();`, '')).toBe(external)
    expect(analyzeSwitchPump(readback)).toMatchObject({ installed: true, managed: false, config })
  })

  it('does not report a marked but incomplete pump as installed', async () => {
    const fixture = appFixture()
    const broken = installSwitchPump(source, config).source.replace('/v1/switch-done', '/v1/broken')
    writeFileSync(fixture.bundlePath, broken)
    expect(await new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath }).status()).toMatchObject({
      kind: 'unsupported', message: expect.stringContaining('运行体校验未通过')
    })
  })

  it('requires the current revision for an owned pump but keeps compatible external revisions usable', async () => {
    const fixture = appFixture()
    const oldOwned = installSwitchPump(source, { ...config, revision: 0 }).source
    writeFileSync(fixture.bundlePath, oldOwned)
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath })
    expect(await installer.status()).toMatchObject({
      kind: 'not-installed', managed: true, message: expect.stringContaining('需要更新')
    })
    expect(await installer.readInstalledConfig()).toBeUndefined()

    writeFileSync(fixture.bundlePath, oldOwned.replace(SWITCH_PUMP_OWNER, ''))
    expect(await installer.status()).toMatchObject({ kind: 'installed', managed: false })
    expect(await installer.readInstalledConfig()).toMatchObject({ revision: 0 })
  })

  it.each(['3.6.31', '3.21.12'])('auto-selects %s and checks the actual profile hook before writing', async (version) => {
    const profile = version === '3.6.31' ? footer
      : 'function rFy(){Yt(()=>{if(!t.signedIn()){s(dPo),a(!1);return}loadProfile()})}'
    const original = `import { x } from './not-executed.js';\n${authSource}\n${profile}`
    const fixture = appFixture(version, original)
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath, execFn: async () => {} })
    expect(await installer.status()).toMatchObject({ compatibility: { state: 'supported', adapter: version } })
    expect(await installer.ensure(config)).toMatchObject({ ok: true, changed: true })
    const patched = readFileSync(fixture.bundlePath, 'utf8')
    expect(patched).toContain(`import { x } from './not-executed.js'`)
    expect(patched).toContain(`${PROFILE_REFRESH_HOOK}${version === '3.6.31' ? 'e' : 't'}.displayEmail();`)
    expect(await installer.status()).toMatchObject({ kind: 'installed', profileRefreshReady: true })
    expect(await installer.ensure(config)).toMatchObject({ ok: true, changed: false })
  })

  it('refuses unknown releases without writing, then re-detects after an upgrade or downgrade', async () => {
    const fixture = appFixture('3.22.0')
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath })
    expect(await installer.status()).toMatchObject({ kind: 'unsupported', compatibility: { version: '3.22.0' } })
    expect(await installer.ensure(config)).toMatchObject({ ok: false, changed: false })
    expect(readFileSync(fixture.bundlePath, 'utf8')).toBe(source)
    writeFileSync(join(fixture.appRoot, 'package.json'), JSON.stringify({ version: '3.21.12' }))
    writeFileSync(join(fixture.appRoot, 'product.json'), JSON.stringify({ version: '3.21.12' }))
    expect(await installer.status()).toMatchObject({ kind: 'not-installed', compatibility: { adapter: '3.21.12' } })
  })

  it('does not silently skip a missing or ambiguous profile hook', async () => {
    for (const original of [authSource, `${source}\n${footer}`]) {
      const fixture = appFixture('3.21.12', original)
      const outcome = await new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath }).ensure(config)
      expect(outcome).toMatchObject({ ok: false, changed: false, message: expect.stringContaining('资料刷新适配未通过') })
      expect(readFileSync(fixture.bundlePath, 'utf8')).toBe(original)
    }
  })

  it('keeps release-specific originals instead of overwriting or reusing the other release backup', async () => {
    const fixture = appFixture('3.6.31')
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath, execFn: async () => {} })
    expect((await installer.ensure(config)).ok).toBe(true)
    const current = `import x from './react.js';\n${authSource}\nfunction rFy(){Yt(()=>{if(!t.signedIn()){s(dPo),a(!1);return}loadProfile()})}`
    writeFileSync(fixture.bundlePath, current)
    writeFileSync(join(fixture.appRoot, 'package.json'), JSON.stringify({ version: '3.21.12' }))
    writeFileSync(join(fixture.appRoot, 'product.json'), JSON.stringify({ version: '3.21.12' }))
    expect((await installer.ensure(config)).ok).toBe(true)
    expect(readFileSync(`${fixture.bundlePath}.sg-runtime-switch-backup-3.6.31`, 'utf8')).toBe(source)
    expect(readFileSync(`${fixture.bundlePath}.sg-runtime-switch-backup-3.21.12`, 'utf8')).toBe(current)
  })

  it('keeps a current pump available for hot switching after a cold switch changes port and key', async () => {
    const fixture = appFixture('3.21.12')
    const installer = new CursorSwitchPumpInstaller({ bundlePath: fixture.bundlePath, execFn: async () => {} })
    expect((await installer.ensure(config)).ok).toBe(true)
    new CursorRuntimeCompanionConfig(fixture.bundlePath).ensure({ port: 51_831, key: 'cold-switch-endpoint' })
    expect(await installer.status()).toMatchObject({ kind: 'installed', config: { port: 51_831, key: 'cold-switch-endpoint', revision: 1 } })
    expect(await installer.readInstalledConfig()).toEqual({ port: 51_831, key: 'cold-switch-endpoint', revision: 1 })
  })

  it('uses real ESM grammar without resolving imports or executing the source', () => {
    expect(() => assertJavaScriptSyntax('import x from "missing.js"; export const y = import.meta.url; throw new Error("must not run");')).not.toThrow()
    expect(() => assertJavaScriptSyntax('export const broken = ;')).toThrow(/语法解析失败/)
    expect(() => assertJavaScriptSyntax('import { from "missing.js";')).toThrow(/语法解析失败/)
  })
})
