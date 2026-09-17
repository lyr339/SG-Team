import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 应用自有 store 文件的落盘工具。
 *
 * 事故背景（2026-09-17 意外断电）：cursor-usage.json 用「writeFileSync 临时文件 +
 * renameSync」保存，这只防进程崩溃、不防断电——NTFS 只对元数据做日志，rename 先于
 * 数据页落盘时，重启后读到的是零填充/截断的文件；load 又把解析失败静默吞成空数据，
 * 下一次 save 就用空数据覆写了唯一的副本，全部历史随之丢失。这里统一补齐三件事：
 *
 * 1. writeStoreFileSync：临时文件写完先 fsync 再 rename——断电后要么旧文件完好、
 *    要么新文件完整，不再出现两头皆空；
 * 2. rename 之后尽力 fsync 目录，让改名本身也落盘（Windows 打不开目录句柄则跳过，
 *    NTFS 元数据日志兜底；POSIX 上生效）；
 * 3. readStoreJsonSync / quarantineStoreFileSync：读不出或解析不了的文件改名留档
 *    （`<原名>.corrupt-<时刻>`）并写 stderr，绝不留在原路径等着被下一次保存覆写——
 *    留档文件就是事后取证与人工恢复的现场。
 */

export type StoreJsonRead =
  | { kind: 'missing' }
  | { kind: 'json'; value: unknown }
  | { kind: 'quarantined'; keptPath?: string }

/** 写入并 fsync 后原子替换目标文件；mode 缺省时不改权限（沿用 umask/既有权限）。 */
export function writeStoreFileSync(
  path: string,
  data: string,
  options: { mode?: number; temporaryPath?: string } = {}
): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = options.temporaryPath ?? `${path}.tmp`
  const buffer = Buffer.from(data, 'utf8')
  const fd = openSync(temporary, 'w', options.mode)
  try {
    let offset = 0
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // open 的 mode 只在新建时生效；临时文件若是崩溃残留（'w' 复用旧 inode），权限要补齐。
  if (options.mode !== undefined) chmodSync(temporary, options.mode)
  renameSync(temporary, path)
  if (options.mode !== undefined) chmodSync(path, options.mode)
  try {
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch {
    // Windows 打不开目录句柄（rename 的持久性由 NTFS 元数据日志保证）；其余平台尽力而为。
  }
}

/** 把损坏/读不出的 store 文件改名留档，避免下一次保存覆写仅存的现场；返回留档路径。 */
export function quarantineStoreFileSync(path: string, reason: string): string | undefined {
  const target = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    renameSync(path, target)
    process.stderr.write(`[store-file] ${reason}：${path} 已留档为 ${target}\n`)
    return target
  } catch (error) {
    process.stderr.write(`[store-file] ${reason}：${path} 留档失败（${error instanceof Error ? error.message : String(error)}），文件保持原位\n`)
    return undefined
  }
}

/**
 * 读 store 的 JSON：文件不存在 → missing；读出且解析成功 → json；
 * 读不出（非 ENOENT）或解析失败 → 留档后报 quarantined。
 * 结构/版本校验由各 store 自理——不合格时应调用 quarantineStoreFileSync 而不是静默回空。
 */
export function readStoreJsonSync(path: string): StoreJsonRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'quarantined', keptPath: quarantineStoreFileSync(path, `读取失败（${code ?? 'unknown'}）`) }
  }
  try {
    return { kind: 'json', value: JSON.parse(text) }
  } catch {
    return { kind: 'quarantined', keptPath: quarantineStoreFileSync(path, 'JSON 解析失败') }
  }
}
