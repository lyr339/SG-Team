import type { ProcessBlock } from './conversation-entry'

/**
 * 封口持久化时 shell 输出只保留尾部（用户拍板 4k）：实时层仍是 hook 的 12k 上限，
 * 落库的 `process_blocks_json` 不再随长命令输出线性膨胀。命令的结论几乎总在尾部
 *（测试汇总、exit 信息、最后的报错），前部被省略时如实标注省略量。
 */
export const PERSISTED_COMMAND_OUTPUT_TAIL_CHARS = 4096

/** 结构化 diff 落库保留的行数上限（头部；超出部分计入 truncatedLineCount）。 */
export const PERSISTED_DIFF_MAX_LINES = 120

function clipTail(output: string, limit: number): string {
  if (output.length <= limit) return output
  const omitted = output.length - limit
  return `…[已省略前 ${omitted} 字符，仅保留输出尾部]\n${output.slice(-limit)}`
}

/**
 * 返回可落库的块：仅 shell 类输出超限 / 结构化 diff 超行数时产生新对象，其余原样返回同一引用
 *（封口比较用引用相等判断「是否需要重写」，无变化必须保持引用不变）。
 */
export function clipProcessBlockForPersistence(
  block: ProcessBlock,
  limit = PERSISTED_COMMAND_OUTPUT_TAIL_CHARS
): ProcessBlock {
  if (block.kind === 'command') {
    if (block.output.length <= limit) return block
    return { ...block, output: clipTail(block.output, limit) }
  }
  if (block.kind !== 'tool') return block
  let next: ProcessBlock = block
  if (block.toolKind === 'command' && block.output && block.output.length > limit) {
    next = { ...next, output: clipTail(block.output, limit) }
  }
  if (block.diff && block.diff.lines.length > PERSISTED_DIFF_MAX_LINES) {
    const dropped = block.diff.lines.length - PERSISTED_DIFF_MAX_LINES
    next = {
      ...next,
      diff: {
        lines: block.diff.lines.slice(0, PERSISTED_DIFF_MAX_LINES),
        truncatedLineCount: (block.diff.truncatedLineCount ?? 0) + dropped
      }
    }
  }
  return next
}
