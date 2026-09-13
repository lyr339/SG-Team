import { describe, expect, it } from 'vitest'
import { tokenizeShellCommand } from '../src/renderer/src/shell-command-tokens'

const types = (command: string): string => tokenizeShellCommand(command)
  .filter((token) => token.type !== 'whitespace')
  .map((token) => `${token.type}:${token.text}`)
  .join(' ')

describe('tokenizeShellCommand', () => {
  it('marks the first word and every word after a control operator as command', () => {
    expect(types('cd /tmp && npm test | tail -5; echo ok')).toBe(
      'command:cd text:/tmp operator:&& command:npm text:test operator:| command:tail flag:-5 operator:; command:echo text:ok'
    )
  })

  it('keeps quoted strings whole and recognises variables and redirections', () => {
    expect(types('echo "a b" \'c d\' $HOME > out.txt 2>&1')).toBe(
      'command:echo string:"a b" string:\'c d\' variable:$HOME operator:> text:out.txt operator:2>&1'
    )
  })

  it('preserves whitespace tokens so the rendered line reproduces the command verbatim', () => {
    const command = 'npx  vitest run\ttests/x.test.ts'
    expect(tokenizeShellCommand(command).map((token) => token.text).join('')).toBe(command)
  })

  it('treats a lone dash or a negative-looking word after a command as text, not a flag', () => {
    expect(types('git log - --oneline')).toBe('command:git text:log text:- flag:--oneline')
  })
})
