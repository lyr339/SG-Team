#!/usr/bin/env node
/**
 * mac 分发产物：把 `pack:mac` 的目录产物变成能发给别人的 zip。
 *
 * 1. 完整 adhoc 重签（`codesign --force --deep --sign -`）。electron-builder 以 `identity: null`
 *    打包时完全跳过签名，bundle 里只剩 Electron 预编译自带的 linker-signed 主可执行文件，
 *    整包签名校验失败（code has no resources but signature indicates they must be present）。
 *    本机能跑是因为本地生成的文件没有隔离标记；经 AirDrop / 微信 / 网盘 / 浏览器传到别的
 *    Mac 后 Gatekeeper 做完整评估，签名无效 → 「已损坏，无法打开」，连「仍要打开」入口都没有。
 *    重签后签名有效，提示变成「无法验证开发者」，系统设置 → 隐私与安全性里有「仍要打开」；
 *    `xattr -dr com.apple.quarantine` 在两种情况下都可用。彻底免提示只有 Developer ID + 公证。
 * 2. `ditto -c -k --keepParent` 压缩。.app 内有十余个符号链接（Electron Framework 的
 *    Versions/Current 等），`zip -r` 会把它们展开；ditto 与 Finder「压缩」同源，原样保留。
 *
 * 用法：node scripts/dist-mac.mjs [appPath] [outDir]
 *   默认 appPath = release/mac-arm64/拾光.app，outDir = release
 * 产物：<outDir>/ShiGuang-<version>-mac-<arch>.zip（ASCII 文件名：作为下载链接时不用转义）
 *
 * 注意：重签会重写 .app 内的可执行文件。不要对正在运行的那份 app 执行（`~/.cursor/mcp.json`
 * 指向 release 目录时，release 里的 app 就是在运行的那份）——先退出拾光，或对副本执行。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const appPath = resolve(process.argv[2] ?? join(root, 'release', 'mac-arm64', '拾光.app'))
const outDir = resolve(process.argv[3] ?? join(root, 'release'))

if (process.platform !== 'darwin') {
  console.error('dist-mac 只能在 macOS 上运行（需要 codesign 与 ditto）')
  process.exit(1)
}
if (!existsSync(join(appPath, 'Contents', 'MacOS'))) {
  console.error(`找不到 app bundle：${appPath}\n先运行 npm run pack:mac`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
// electron-builder 目录产物：mac-arm64 / mac-universal / mac（x64）
const dirName = basename(dirname(appPath))
const arch = dirName.endsWith('-arm64') ? 'arm64' : dirName.endsWith('-universal') ? 'universal' : 'x64'
const zipPath = join(outDir, `ShiGuang-${version}-mac-${arch}.zip`)

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })

console.log(`[dist-mac] adhoc 重签 ${appPath}`)
run('codesign', ['--force', '--deep', '--sign', '-', appPath])
run('codesign', ['--verify', '--deep', '--strict', appPath])

console.log(`[dist-mac] ditto → ${zipPath}`)
rmSync(zipPath, { force: true })
run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath])

const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1)
console.log(`[dist-mac] 完成：${zipPath}（${sizeMb} MB）`)
console.log('[dist-mac] 收件人：解压后拖进「应用程序」，终端执行一次：')
console.log('           xattr -dr com.apple.quarantine /Applications/拾光.app && open -a 拾光')
