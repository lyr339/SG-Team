import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { extractFile } from '@electron/asar'

// Real directory/installer artifacts, not a production startup. Windows runtime
// execution is deliberately NOT claimed by running its JS under a Mac process.
const root = resolve(import.meta.dirname, '..'), evidence = join(root, 'preview-screenshots/notification-implementation/acceptance')
const temporary = mkdtempSync(join(tmpdir(), 'sg-notification-package-')), reports = []
const digest = data => createHash('sha256').update(data).digest('hex')
const mac = join(root, 'release/mac-arm64/拾光.app'), windows = join(root, 'release/win-unpacked')
const architecture = path => { const buffer=readFileSync(path), pe=buffer.readUInt32LE(0x3c); assert.equal(buffer.subarray(pe,pe+4).toString('binary'),'PE\0\0'); return buffer.readUInt16LE(pe+4) }
const run = (name, executable, args, env = {}) => {
  const result = spawnSync(executable, args, { cwd: root, env: { ...process.env, TMPDIR: temporary, ...env }, encoding: 'utf8', timeout: 90000, maxBuffer: 8*1024*1024 })
  writeFileSync(join(evidence, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.status, 0, name + ': ' + (result.stderr ?? '').slice(-1500))
}
try {
  for (const [platform, directory, archive] of [['mac',mac,join(mac,'Contents/Resources/app.asar')],['windows',windows,join(windows,'resources/app.asar')]]) {
    const files = [...readdirSync(join(root,'out/main')).filter(name=>name.endsWith('.js')).map(name=>'out/main/'+name),
      ...readdirSync(join(root,'out/preload')).filter(name=>name.endsWith('.cjs')).map(name=>'out/preload/'+name),
      ...readdirSync(join(root,'out/renderer/assets')).filter(name=>/\.(js|css)$/.test(name)).map(name=>'out/renderer/assets/'+name)]
    for (const name of files) assert.ok(readFileSync(join(root,name)).equals(extractFile(archive,name)), platform+' contains stale/missing '+name)
    const metadata = JSON.parse(extractFile(archive,'package.json').toString())
    const expectedMetadata=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
    for(const field of ['name','version','main'])assert.equal(metadata[field],expectedMetadata[field],platform+' wrong '+field)
    assert.deepEqual(metadata.dependencies,expectedMetadata.dependencies)
    const resourceRoot = platform==='mac'?join(directory,'Contents/Resources'):join(directory,'resources')
    assert.ok(readFileSync(join(root,'out/mcp/index.mjs')).equals(readFileSync(join(resourceRoot,'mcp/index.mjs'))))
    assert.ok(existsSync(join(resourceRoot,platform==='mac'?'trayTemplate.png':'tray.ico')))
    reports.push({platform,archive,archiveSha256:digest(readFileSync(archive)),compiledFilesCompared:files.length,workerPreloadRendererAndMcpCurrent:true})
  }
  assert.equal(architecture(join(windows,'ShiGuang.exe')),0x8664)
  assert.equal(execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',join(mac,'Contents/Info.plist')]).toString().trim(),'app.shiguang.team')
  const actualWinMain=extractFile(join(windows,'resources/app.asar'),'out/main/index.js').toString()
  assert.ok(actualWinMain.includes('setAppUserModelId("app.shiguang.team")'))
  const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version
  const installer=join(root,'release',`ShiGuang-Setup-${version}.exe`), blockmap=installer+'.blockmap'
  assert.equal(architecture(installer),0x014c) // NSIS 32-bit bootstrap, x64 application payload.
  assert.ok(existsSync(blockmap)); assert.ok(existsSync(join(root,'release',`ShiGuang-${version}-mac-arm64.zip`)))
  run('packaged-mac-signature','/usr/bin/codesign',['--verify','--deep','--strict',mac])
  run('packaged-mcp',process.execPath,['--import','tsx','scripts/verify-built-mcp.ts','--packaged'])
  const worker=join(root,'out/main'), executable=join(mac,'Contents/MacOS/拾光')
  // Compare exact packaged worker bytes above, then exercise the distribution's
  // real embedded Node against the same compiled fixture, without main startup.
  run('packaged-worker',executable,['scripts/verify-notification-worker.mjs',worker],{ELECTRON_RUN_AS_NODE:'1'})
  run('packaged-delivery-claims',executable,['--import','tsx','scripts/verify-notification-delivery-claims.ts'],{ELECTRON_RUN_AS_NODE:'1'})
  const summary={packages:reports,windowsApplicationMachine:'x64',windowsNsisInstallerAndBlockmapPresent:true,macAdHocSignatureVerified:true,
    packagedMacEmbeddedNodeAndMcpPassed:true,windowsNativeDesktopExecutionNotClaimed:true,noProductionMainCursorAccountsOrOsNotices:true,
    artifactHashes:{windowsInstaller:digest(readFileSync(installer)),windowsBlockmap:digest(readFileSync(blockmap)),macZip:digest(readFileSync(join(root,'release',`ShiGuang-${version}-mac-arm64.zip`)))}}
  writeFileSync(join(evidence,'packages.json'),JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary,null,2))
} finally { rmSync(temporary,{recursive:true,force:true}) }
