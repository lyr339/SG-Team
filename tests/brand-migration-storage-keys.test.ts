// @vitest-environment jsdom
// 品牌迁移里唯一需要 jsdom（localStorage）的部分。它单独成文件而不与 brand-migration.test.ts
// 同住：那边要导入依赖 node:sqlite 的仓储，而 Vitest 4 给 jsdom 套件走 Vite 的 client 管线、
// 只放行 node 自带 builtinModules 里的内置模块——Node 22 的 builtinModules 不含只允许带
// node: 前缀的 sqlite，同文件会以「Cannot bundle built-in module "node:sqlite"」整套加载失败。
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyStorageKeys } from '../src/renderer/src/storage-migration'

describe('brand migration: renderer localStorage keys', () => {
  afterEach(() => localStorage.clear())

  it('moves legacy-prefixed keys to the current prefix and removes the old ones', () => {
    localStorage.setItem('qingtian-team.layout:v1:shell.sessions.v2:collapsed', '1')
    localStorage.setItem('qingtian-team.inspector:active-tab', 'plan')
    localStorage.setItem('shiguang.appearance.v1', '{"theme":"dark"}')
    expect(migrateLegacyStorageKeys()).toBe(2)
    expect(localStorage.getItem('sg-team.layout:v1:shell.sessions.v2:collapsed')).toBe('1')
    expect(localStorage.getItem('sg-team.inspector:active-tab')).toBe('plan')
    expect(localStorage.getItem('qingtian-team.inspector:active-tab')).toBeNull()
    expect(localStorage.getItem('shiguang.appearance.v1')).toBe('{"theme":"dark"}')
  })

  it('prefers an existing current value over the legacy one', () => {
    localStorage.setItem('qingtian-team.inspector:active-tab', 'plan')
    localStorage.setItem('sg-team.inspector:active-tab', 'review')
    expect(migrateLegacyStorageKeys()).toBe(0)
    expect(localStorage.getItem('sg-team.inspector:active-tab')).toBe('review')
    expect(localStorage.getItem('qingtian-team.inspector:active-tab')).toBeNull()
  })
})
