import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { CursorAccountSwitcher } from '../src/infrastructure/cursor/cursor-account-switcher'
import { CursorAccountVault } from '../src/application/cursor-account-vault'
import { switchCursorAccountWithVault } from '../src/application/cursor-account-switch'
import { generateCursorMachineIdentity } from '../src/infrastructure/cursor/cursor-machine-identity'
import { appRootOfBundle } from '../src/infrastructure/cursor/cursor-install-paths'
import { CursorSwitchMutex } from '../src/infrastructure/cursor/cursor-switch-mutex'
import { CursorRuntimeAccountBridge, type CursorRuntimeAccountBridgePort } from '../src/infrastructure/cursor/cursor-runtime-account-bridge'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (sub: string) => `${encode({alg:'HS256',typ:'JWT'})}.${encode({sub,type:'session',exp:2_000_000_000})}.test-only`
type Fault = 'timeout' | 'reject' | 'readback' | 'launch' | 'write' | 'machine-write' | 'none'

function fixture(platform: 'win32' | 'darwin' = 'win32', version = '3.21.12', nativeBridge?: CursorRuntimeAccountBridgePort) {
  const root = mkdtempSync(join(tmpdir(), 'sg 恢复 空间 ')); roots.push(root)
  const database = join(root, 'state.vscdb'), storage = join(root, 'storage.json'), machine = join(root, 'machineid')
  const oldToken = jwt('user_old'), newToken = jwt('user_new'), identity = generateCursorMachineIdentity()
  const db = new DatabaseSync(database)
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value)')
  const insert = db.prepare('INSERT INTO ItemTable VALUES (?, ?)')
  insert.run('cursorAuth/accessToken', oldToken); insert.run('cursorAuth/refreshToken', oldToken)
  insert.run('storage.serviceMachineId', 'old-guid'); insert.run('cursor.modelCatalog.v1', 'old-catalog')
  insert.run('editorPreference', 'before'); db.close()
  writeFileSync(storage, JSON.stringify({ 'telemetry.machineId': 'old-machine', windowState: 'before' }))
  writeFileSync(machine, 'old-guid')
  const bundle = platform === 'darwin'
    ? join(root, 'Cursor.app', 'Contents', 'Resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
    : join(root, '自定义 Cursor', 'resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
  mkdirSync(dirname(bundle), { recursive: true })
  const config = Buffer.from(JSON.stringify({port:51824,key:'test-key',revision:1})).toString('base64')
  writeFileSync(bundle, `/*ZMO_SWITCH_CONFIG:${config}*/const zP=51824,zK="test-key"`)
  const app = appRootOfBundle(bundle)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ version })); writeFileSync(join(app, 'product.json'), JSON.stringify({ version }))
  const vault = new CursorAccountVault(join(root, 'accounts.json'), { available:()=>true, encrypt:s=>Buffer.from(s), decrypt:b=>Buffer.from(b).toString() })
  const oldId = vault.save({ label:'old@test.invalid',token:oldToken })[0]!.id
  const newId = vault.save({ label:'new@test.invalid',token:newToken,makeActive:false }).find(a=>a.id!==oldId)!.id
  vault.attachMachineIdentity(newId,identity); vault.activateAfterLiveSwitch(oldId)
  let alive = true, fault: Fault = 'timeout', kills = 0, launches = 0, recoverySuppressed = 0
  let refuseRecoveryKill = false, breakRecoveryFile = false
  const mutex = new CursorSwitchMutex()
  const commands: { file: string; args: string[] }[] = []
  const value = (key: string) => { const d = new DatabaseSync(database); try { return d.prepare('SELECT value FROM ItemTable WHERE key=?').get(key)?.value } finally { d.close() } }
  const switcher = new CursorAccountSwitcher({
    stateDatabasePath:database,storageJsonPath:storage,machineIdPath:machine,platform:()=>platform,
    locateRuntimeBundle:async()=>bundle,sleep:async()=>{},now:()=>1,
    switchMutex:mutex,
    beforeRecovery:()=>{ recoverySuppressed++ },
    tokenExchanger:{resolve:async()=>({accessToken:newToken,refreshToken:newToken,sourceType:'session',runtimeType:'session',exchanged:false})},
    execFn:async(file,args)=>{
      commands.push({file,args})
      if(file==='tasklist'||file==='pgrep') return {stdout:alive?'Cursor.exe 42\n':''}
      if(file==='taskkill'||file==='pkill') {
        expect(mutex.locked).toBe(true)
        kills++
        if(kills>1&&refuseRecoveryKill) throw new Error('taskkill denied during recovery')
        alive=false
      }
      if(file==='cmd.exe'||file==='open') {
        launches++
        if(launches===1&&fault==='launch') throw new Error('start failed')
        if(launches>1 && fault!=='none') {
          // Recovery must finish before the old installation is allowed to launch again.
          expect(value('cursorAuth/accessToken')).toBe(oldToken)
          expect(readFileSync(machine,'utf8')).toBe('old-guid')
        }
        if(platform==='win32') expect(args.join(' ')).toContain(win32.resolve(bundle,'..','..','..','..','..','..','Cursor.exe'))
        alive=true
      }
      return {stdout:''}
    },
    runtimeBridge:nativeBridge ?? {applyAfterLaunch:async(_payload,launch)=>{
      if(fault==='write') mkdirSync(`${storage}.tmp`)
      if(fault==='machine-write') mkdirSync(`${machine}.tmp`)
      const launchResult=await launch()
      if(fault==='none') return {launchResult,ack:{success:true,reason:''}}
      // A failed native startup may already have flushed unrelated preferences. Do not erase them.
      const d = new DatabaseSync(database)
      d.prepare('UPDATE ItemTable SET value=? WHERE key=?').run('after','editorPreference')
      if(fault==='readback') d.prepare('UPDATE ItemTable SET value=? WHERE key=?').run(jwt('other_user'),'cursorAuth/refreshToken')
      d.close()
      writeFileSync(storage,JSON.stringify({ ...JSON.parse(readFileSync(storage,'utf8')), windowState:'after' }))
      if(breakRecoveryFile) { rmSync(storage); mkdirSync(storage) }
      if(fault==='timeout') throw new Error('runtime acknowledgement timeout')
      return {launchResult,ack:{success:fault==='readback',reason:'readback-mismatch'}}
    }}
  })
  return { root,database,storage,machine,oldToken,newToken,vault,oldId,newId,switcher,value,commands,mutex,
    setFault:(v:Fault)=>{fault=v}, blockKill:()=>{refuseRecoveryKill=true}, blockRecovery:()=>{breakRecoveryFile=true},
    wasClosed:()=>{alive=false}, counts:()=>({kills,launches,recoverySuppressed,alive}) }
}

describe('Cold switch failure recovery across both audited Cursor versions', () => {
  it('Windows 3.21.12: real loopback timeout closes the one-shot server before scoped rollback finishes', async () => {
    const serverFactory=vi.fn(createServer)
    // Vitest's spy type retains only the last overload; the spy delegates both overloads to Node unchanged.
    const bridge=new CursorRuntimeAccountBridge({port:0,timeoutMs:20,prepareCompanion:async()=>{},createServer:serverFactory as typeof createServer})
    const f=fixture('win32','3.21.12',bridge)
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('已恢复切换前')
    expect(serverFactory).toHaveBeenCalledTimes(1)
    expect(serverFactory.mock.results[0]!.value.listening).toBe(false)
    expect(f.value('cursorAuth/accessToken')).toBe(f.oldToken)
    expect(f.vault.list().find(account=>account.active)?.id).toBe(f.oldId)
    expect(f.mutex.locked).toBe(false)
  })
  for (const platform of ['win32','darwin'] as const) for (const version of ['3.6.31','3.21.12']) {
    it.each(['timeout','reject','readback'] as const)(`${platform} ${version}: %s restores identity before relaunch and leaves Vault selection unchanged`, async fault => {
      const f=fixture(platform,version); f.setFault(fault)
      await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('已恢复切换前')
      expect(f.value('cursorAuth/accessToken')).toBe(f.oldToken); expect(f.value('cursorAuth/refreshToken')).toBe(f.oldToken)
      expect(f.value('storage.serviceMachineId')).toBe('old-guid'); expect(f.value('cursor.modelCatalog.v1')).toBe('old-catalog')
      expect(f.value('cursorAuth/cachedUserId')).toBeUndefined(); expect(f.value('editorPreference')).toBe('after')
      expect(JSON.parse(readFileSync(f.storage,'utf8'))).toEqual({'telemetry.machineId':'old-machine',windowState:'after'})
      expect(readFileSync(f.machine,'utf8')).toBe('old-guid')
      expect(f.vault.list().find(a=>a.active)?.id).toBe(f.oldId)
      expect(f.vault.list().find(a=>a.id===f.oldId)?.pendingMachineAlign).toBe(true)
      expect(f.counts()).toMatchObject({kills:2,launches:2,recoverySuppressed:1})
    })
  }

  it.each(['write','machine-write'] as const)('Windows 3.21.12: partial %s failure restores the committed database before reopening', async fault => {
    const f=fixture(); f.setFault(fault)
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('已恢复切换前')
    expect(f.value('cursorAuth/accessToken')).toBe(f.oldToken)
    expect(readFileSync(f.machine,'utf8')).toBe('old-guid')
    expect(f.vault.list().find(a=>a.active)?.id).toBe(f.oldId)
    expect(f.counts().launches).toBe(1)
  })

  it('Windows 3.21.12: launch failure restores old state rather than reopening the unconfirmed target', async () => {
    const f=fixture(); f.setFault('launch')
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('已恢复切换前')
    expect(f.value('cursorAuth/accessToken')).toBe(f.oldToken)
    expect(f.counts().launches).toBe(2)
  })

  it('Windows 3.21.12: an unconfirmed process exit prevents rollback writes and does not claim restoration', async () => {
    const f=fixture(); f.blockKill()
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('恢复未完成')
    expect(f.value('cursorAuth/accessToken')).toBe(f.newToken)
    expect(f.counts().launches).toBe(1)
    expect(f.vault.list().find(a=>a.active)?.id).toBe(f.oldId)
  })

  it('Windows 3.21.12: failed file restoration keeps Cursor closed and retains the recovery backup', async () => {
    const f=fixture(); f.blockRecovery()
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('恢复未完成')
    expect(f.counts()).toMatchObject({alive:false,launches:1})
    const parent=join(dirname(f.database),'backups'), directory=readdirSync(parent)[0]!
    expect(existsSync(join(parent,directory,'itemtable.sqlite3'))).toBe(true)
    expect(readFileSync(join(parent,directory,'storage.json'),'utf8')).toContain('old-machine')
  })

  it('Windows 3.21.12: missing snapshot aborts before any account write and reopens the old installation', async () => {
    const f=fixture(); writeFileSync(join(dirname(f.database),'backups'),'blocked')
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('未改动')
    expect(f.value('cursorAuth/accessToken')).toBe(f.oldToken)
    expect(readFileSync(f.machine,'utf8')).toBe('old-guid')
    expect(f.counts()).toMatchObject({kills:1,launches:1,recoverySuppressed:0})
  })

  it('Windows 3.21.12: a failed Vault commit after native confirmation also restores Cursor before releasing the switch', async () => {
    const f=fixture(); f.setFault('none')
    await expect(f.switcher.switchAccount({token:f.newToken,identity:generateCursorMachineIdentity()}, () => {
      expect(f.mutex.locked).toBe(true)
      expect(f.value('cursorAuth/accessToken')).toBe(f.newToken)
      throw new Error('Vault save denied')
    })).rejects.toThrow('已恢复切换前')
    expect(f.value('cursorAuth/accessToken')).toBe(f.oldToken)
    expect(readFileSync(f.machine,'utf8')).toBe('old-guid')
    expect(f.counts()).toMatchObject({kills:2,launches:2})
    expect(f.mutex.locked).toBe(false)
  })

  it('keeps both cold/hot switch exclusion through selection commit, not just through the native ACK', async () => {
    const f=fixture(); f.setFault('none')
    let enter!: () => void, release!: () => void
    const entered=new Promise<void>(resolve=>{enter=resolve})
    const pending=new Promise<void>(resolve=>{release=resolve})
    const first=f.switcher.switchAccount({token:f.newToken,identity:generateCursorMachineIdentity()}, async()=>{enter();await pending})
    await entered
    expect(f.mutex.locked).toBe(true)
    await expect(f.mutex.withLock('无感换号',async()=>{})).rejects.toThrow('正在进行')
    release(); await first
    expect(f.mutex.locked).toBe(false)
  })

  it('does not start a previously closed Cursor again after recovery', async () => {
    const f=fixture(); f.wasClosed()
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('Cursor 保持关闭')
    expect(f.value('cursorAuth/accessToken')).toBe(f.oldToken)
    expect(f.counts()).toMatchObject({alive:false,launches:1})
  })

  it('permits a verified retry after rollback without reusing/overwriting the failed attempt backup', async () => {
    const f=fixture()
    await expect(switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)).rejects.toThrow('已恢复')
    f.setFault('none')
    const result=await switchCursorAccountWithVault({vault:f.vault,switcher:f.switcher},f.newId)
    expect(result.runtimeVerified).toBe(true)
    expect(f.vault.list().find(a=>a.active)?.id).toBe(f.newId)
    expect(readdirSync(join(dirname(f.database),'backups'))).toHaveLength(2)
  })
})
