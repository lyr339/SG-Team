/**
 * 生成 mac 自更新用的静态清单 `update-manifest.json`（任务书 §4.1 / §4.2），作为 Release 资产上传。
 * 用 `node scripts/update-manifest.mjs` 调用（无 shebang：vitest 会直接 import 本文件取纯函数）。
 *
 * 客户端（mac）经 `releases/latest/download/update-manifest.json` 取它：不计 GitHub REST 限额、可镜像；
 * 一处写下 sha512 / 大小 / 发布说明。Windows 客户端不读它（electron-updater 读 latest.yml），
 * 但 win 资产也一并登记，方便日后统一。
 *
 * 用法：
 *   node scripts/update-manifest.mjs --version 0.3.4 --tag v0.3.4 \
 *     --notes .github/release-notes.md --assets artifacts --out artifacts/update-manifest.json \
 *     [--repo lyr339/SG-Team] [--published-at 2026-09-17T02:00:00Z]
 *
 * 只登记文件名与 --version 完全匹配的产物（`ShiGuang-<version>-mac-<arch>.zip`、`ShiGuang-Setup-<version>.exe`），
 * 上一版残留的文件会被忽略；没有 mac 产物时退出非零（清单机制就是为 mac 服务的）。零依赖，node ≥ 20。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      args[key.slice(2)] = 'true'
      continue
    }
    args[key.slice(2)] = value
    index += 1
  }
  return args
}

async function sha512Hex(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha512')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** 资产文件名 → 平台键；不属于本版本的文件返回 undefined。 */
export function classifyAsset(fileName, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mac = new RegExp(`^ShiGuang-${escaped}-mac-(arm64|x64|universal)\\.zip$`).exec(fileName)
  if (mac) return mac[1] === 'x64' ? 'mac-x64' : mac[1] === 'arm64' ? 'mac-arm64' : undefined
  if (new RegExp(`^ShiGuang-Setup-${escaped}\\.exe$`).test(fileName)) return 'win-x64'
  return undefined
}

export async function buildManifest({ version, tag, assetsDir, repo, notes, publishedAt }) {
  const assets = {}
  for (const fileName of readdirSync(assetsDir).sort()) {
    const key = classifyAsset(fileName, version)
    if (!key) continue
    const path = join(assetsDir, fileName)
    if (!statSync(path).isFile()) continue
    assets[key] = {
      name: fileName,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(fileName)}`,
      size: statSync(path).size,
      sha512: await sha512Hex(path)
    }
  }
  if (!assets['mac-arm64'] && !assets['mac-x64']) {
    throw new Error(`${assetsDir} 里没有版本 ${version} 的 mac 产物（ShiGuang-${version}-mac-<arch>.zip）`)
  }
  return {
    schemaVersion: 1,
    version,
    tag,
    publishedAt,
    ...(notes ? { notesMarkdown: notes } : {}),
    assets
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = (args.version ?? '').trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`--version 不合法：${args.version ?? '（缺失）'}`)
  }
  const tag = (args.tag ?? `v${version}`).trim()
  if (tag !== `v${version}`) throw new Error(`--tag ${tag} 与 --version ${version} 不一致（tag 必须是 v<version>）`)
  const assetsDir = resolve(args.assets ?? 'artifacts')
  if (!existsSync(assetsDir)) throw new Error(`--assets 目录不存在：${assetsDir}`)
  const out = resolve(args.out ?? join(assetsDir, 'update-manifest.json'))
  const repo = args.repo ?? 'lyr339/SG-Team'
  const notes = args.notes ? readFileSync(resolve(args.notes), 'utf8') : undefined
  const publishedAt = args['published-at'] ?? new Date().toISOString()
  const manifest = await buildManifest({ version, tag, assetsDir, repo, notes, publishedAt })
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[update-manifest] ${out}`)
  for (const [key, asset] of Object.entries(manifest.assets)) {
    console.log(`[update-manifest]   ${key}: ${asset.name} (${asset.size} bytes) sha512=${asset.sha512.slice(0, 16)}…`)
  }
}

// 被测试 import 时不执行；只有作为脚本直接运行才走 main。
const invokedDirectly = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[update-manifest] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
