import { describe, expect, it } from 'vitest'
import type { ProcessBlock } from '../src/domain/conversation-entry'
import {
  clipProcessBlockForPersistence,
  PERSISTED_COMMAND_OUTPUT_TAIL_CHARS,
  PERSISTED_DIFF_MAX_LINES
} from '../src/domain/process-block-persistence'

describe('clipProcessBlockForPersistence', () => {
  const long = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n')

  it('keeps the same reference when nothing needs clipping', () => {
    const short: ProcessBlock = { kind: 'tool', id: 't', toolName: 'run_terminal_command_v2', toolKind: 'command', output: 'ok', status: 'done' }
    expect(clipProcessBlockForPersistence(short)).toBe(short)
    const read: ProcessBlock = { kind: 'tool', id: 'r', toolName: 'read_file_v2', toolKind: 'read', output: long, status: 'done' }
    expect(clipProcessBlockForPersistence(read)).toBe(read)
    const thinking: ProcessBlock = { kind: 'thinking', id: 'th', text: long, status: 'done' }
    expect(clipProcessBlockForPersistence(thinking)).toBe(thinking)
  })

  it('keeps only the 4k tail of a shell tool output and states how much was dropped', () => {
    const block: ProcessBlock = { kind: 'tool', id: 't', toolName: 'run_terminal_command_v2', toolKind: 'command', output: long, status: 'done' }
    const clipped = clipProcessBlockForPersistence(block)
    expect(clipped).not.toBe(block)
    const output = clipped.kind === 'tool' ? clipped.output ?? '' : ''
    expect(output.startsWith(`…[已省略前 ${long.length - PERSISTED_COMMAND_OUTPUT_TAIL_CHARS} 字符，仅保留输出尾部]\n`)).toBe(true)
    expect(output.endsWith(long.slice(-PERSISTED_COMMAND_OUTPUT_TAIL_CHARS))).toBe(true)
    // 其余字段原样保留。
    expect(clipped).toMatchObject({ id: 't', toolKind: 'command', status: 'done' })
  })

  it('clips legacy command blocks the same way', () => {
    const block: ProcessBlock = { kind: 'command', id: 'c', command: 'npm test', output: long, status: 'done' }
    const clipped = clipProcessBlockForPersistence(block)
    expect(clipped.kind === 'command' ? clipped.output.length : 0).toBeLessThan(long.length)
    expect(clipped.kind === 'command' ? clipped.output.endsWith('line 599') : false).toBe(true)
  })

  it('keeps the head of an oversized structured diff and adds the dropped lines to truncatedLineCount', () => {
    const lines = Array.from({ length: 200 }, (_, index) => ({ type: 'added' as const, text: `line ${index}`, newLine: index + 1 }))
    const block: ProcessBlock = { kind: 'tool', id: 'e', toolName: 'edit_file_v2', toolKind: 'edit', status: 'done', diff: { lines, truncatedLineCount: 10 } }
    const clipped = clipProcessBlockForPersistence(block)
    expect(clipped).not.toBe(block)
    const diff = clipped.kind === 'tool' ? clipped.diff : undefined
    expect(diff?.lines).toHaveLength(PERSISTED_DIFF_MAX_LINES)
    expect(diff?.lines[0]).toEqual(lines[0])
    expect(diff?.truncatedLineCount).toBe(10 + 200 - PERSISTED_DIFF_MAX_LINES)
    const small: ProcessBlock = { kind: 'tool', id: 'e2', toolName: 'edit_file_v2', toolKind: 'edit', status: 'done', diff: { lines: lines.slice(0, 5) } }
    expect(clipProcessBlockForPersistence(small)).toBe(small)
  })

  it('honours a custom limit', () => {
    const block: ProcessBlock = { kind: 'tool', id: 't', toolName: 'sh', toolKind: 'command', output: 'abcdefghij', status: 'done' }
    const clipped = clipProcessBlockForPersistence(block, 4)
    expect(clipped.kind === 'tool' ? clipped.output : '').toBe('…[已省略前 6 字符，仅保留输出尾部]\nghij')
  })
})
