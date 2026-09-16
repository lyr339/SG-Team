import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reconcileGlobalChannelServers } from '../src/infrastructure/cursor/global-mcp-registrar'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sg-team-global-mcp-'))
  const configPath = join(root, '.cursor', 'mcp.json')
  const command = join(root, 'Electron')
  const server = join(root, 'index.mjs')
  const database = join(root, 'task-pool.sqlite3')
  mkdirSync(join(root, '.cursor'), { recursive: true })
  writeFileSync(command, '')
  writeFileSync(server, '')
  writeFileSync(database, '')
  return { root, configPath, command, server, database }
}

function inputOf(files: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return {
    command: files.command,
    serverPath: files.server,
    databasePath: files.database,
    channelCount: 2,
    configPath: files.configPath,
    ...extra
  }
}

describe('global mcp registrar', () => {
  it('creates the native SG Team entry and preserves unrelated servers', () => {
    const files = fixture()
    writeFileSync(files.configPath, JSON.stringify({
      mcpServers: { 'zhimo-mcp': { command: 'zhimo' } }
    }))
    const result = reconcileGlobalChannelServers(inputOf(files))
    expect(result.changed).toBe(true)
    expect(result.serverNames).toEqual(['SG Team'])
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    expect(config.mcpServers['zhimo-mcp']).toEqual({ command: 'zhimo' })
    expect(config.mcpServers['SG Team']).toMatchObject({
      command: files.command,
      args: [files.server],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        SG_TEAM_SERVER_ROLE: 'unified'
      }
    })
    // 幂等：二次调用无变更
    expect(reconcileGlobalChannelServers(inputOf(files)).changed).toBe(false)
  })

  it('rewrites a drifted SG Team entry and creates the config from scratch when missing', () => {
    const files = fixture()
    writeFileSync(files.configPath, JSON.stringify({
      mcpServers: { 'SG Team': { command: '/old/electron', args: ['/old/index.mjs'] } }
    }))
    expect(reconcileGlobalChannelServers(inputOf(files)).changed).toBe(true)
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    expect(Object.keys(config.mcpServers)).toEqual(['SG Team'])
    expect(config.mcpServers['SG Team'].command).toBe(files.command)

    const fresh = fixture()
    rmSync(fresh.configPath, { force: true })
    expect(reconcileGlobalChannelServers(inputOf(fresh)).changed).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(fresh.configPath, 'utf8')).mcpServers)).toEqual(['SG Team'])
  })

  it('用户手写的 SG_TEAM_KEEPALIVE_MS 随条目保留：重写不抹掉，且未漂移时不改文件；其他自定义 env 不保留', () => {
    const files = fixture()
    writeFileSync(files.configPath, JSON.stringify({
      mcpServers: {
        'SG Team': {
          command: '/old/electron', args: ['/old/index.mjs'],
          env: { ELECTRON_RUN_AS_NODE: '1', SG_TEAM_KEEPALIVE_MS: ' 60000 ', SOMETHING_ELSE: 'x' }
        }
      }
    }))
    expect(reconcileGlobalChannelServers(inputOf(files)).changed).toBe(true)
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    expect(config.mcpServers['SG Team'].env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      SG_TEAM_DB: files.database,
      SG_TEAM_SERVER_ROLE: 'unified',
      SG_TEAM_KEEPALIVE_MS: '60000'
    })
    // 第二次启动：条目已一致，不再改写（否则每次启动都触发 Cursor 重载 MCP）
    expect(reconcileGlobalChannelServers(inputOf(files)).changed).toBe(false)
  })

  it('SG_TEAM_APP_VERSION：版本变化即改写（升级后让 Cursor 重载一次 MCP），同版本不改写，且保留手写的 keepalive', () => {
    const files = fixture()
    writeFileSync(files.configPath, JSON.stringify({
      mcpServers: {
        'SG Team': {
          command: files.command, args: [files.server],
          env: {
            ELECTRON_RUN_AS_NODE: '1', SG_TEAM_DB: files.database, SG_TEAM_SERVER_ROLE: 'unified',
            SG_TEAM_APP_VERSION: '0.3.2', SG_TEAM_KEEPALIVE_MS: '60000'
          }
        }
      }
    }))
    // 同版本：条目一致，不动文件
    expect(reconcileGlobalChannelServers(inputOf(files, { appVersion: '0.3.2' })).changed).toBe(false)
    // 新版本首次启动：改写并带上新版本号，手写的 keepalive 仍在
    expect(reconcileGlobalChannelServers(inputOf(files, { appVersion: '0.3.3' })).changed).toBe(true)
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    expect(config.mcpServers['SG Team'].env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      SG_TEAM_DB: files.database,
      SG_TEAM_SERVER_ROLE: 'unified',
      SG_TEAM_APP_VERSION: '0.3.3',
      SG_TEAM_KEEPALIVE_MS: '60000'
    })
    // 不传版本（开发态 / 旧调用方）：不写该键，也不因旧文件里有它而反复改写以外的语义——这里它被视作漂移一次抹掉
    expect(reconcileGlobalChannelServers(inputOf(files)).changed).toBe(true)
    expect(JSON.parse(readFileSync(files.configPath, 'utf8')).mcpServers['SG Team'].env.SG_TEAM_APP_VERSION).toBeUndefined()
  })

  it('refuses malformed global config without touching it', () => {
    const files = fixture()
    writeFileSync(files.configPath, '{ broken')
    expect(() => reconcileGlobalChannelServers(inputOf(files))).toThrowError(/已停止注册/)
    expect(readFileSync(files.configPath, 'utf8')).toBe('{ broken')
  })
})
