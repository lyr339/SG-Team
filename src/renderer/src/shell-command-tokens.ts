/**
 * Shell 命令行的轻量着色分词（对齐 Cursor shell 卡的 `$ command` 行）：
 * 首词与每个 `&& || | ;` 之后的词是 command，`-x/--flag` 是 flag，引号串是 string，
 * `$VAR` 是 variable，`&& || | ; > >> < 2>&1` 是 operator，其余是 text；空白原样保留。
 * 不做真正的 shell 解析（heredoc、子 shell 等按 text 处理即可），但保证各 token 拼回即原文。
 */
export type ShellTokenType = 'command' | 'flag' | 'string' | 'variable' | 'operator' | 'text' | 'whitespace'

export interface ShellToken {
  type: ShellTokenType
  text: string
}

/** 控制操作符：其后的词重新视为命令。 */
const CONTROL_OPERATORS = new Set(['&&', '||', '|', ';'])
const OPERATOR_PATTERN = /^(&&|\|\||2>&1|>>|>|<|\||;)/

function isWordBoundary(command: string, index: number): boolean {
  const char = command[index]!
  if (/\s/.test(char) || char === '"' || char === "'" || char === ';' || char === '|' || char === '<' || char === '>') return true
  return char === '&' && command[index + 1] === '&'
}

export function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let expectCommand = true
  let index = 0
  const push = (type: ShellTokenType, text: string): void => {
    if (text) tokens.push({ type, text })
  }
  while (index < command.length) {
    const char = command[index]!
    if (/\s/.test(char)) {
      let end = index
      while (end < command.length && /\s/.test(command[end]!)) end += 1
      push('whitespace', command.slice(index, end))
      index = end
      continue
    }
    if (char === '"' || char === "'") {
      let end = index + 1
      while (end < command.length && command[end] !== char) {
        if (command[end] === '\\' && char === '"') end += 1
        end += 1
      }
      end = Math.min(command.length, end + 1)
      push('string', command.slice(index, end))
      expectCommand = false
      index = end
      continue
    }
    const operator = OPERATOR_PATTERN.exec(command.slice(index, index + 4))?.[1]
    if (operator) {
      push('operator', operator)
      if (CONTROL_OPERATORS.has(operator)) expectCommand = true
      index += operator.length
      continue
    }
    let end = index + 1
    while (end < command.length && !isWordBoundary(command, end)) end += 1
    const word = command.slice(index, end)
    index = end
    if (word.startsWith('$')) {
      push('variable', word)
      expectCommand = false
      continue
    }
    if (/^-{1,2}[\w[\]]/.test(word)) {
      push('flag', word)
      expectCommand = false
      continue
    }
    if (expectCommand) {
      push('command', word)
      expectCommand = false
      continue
    }
    push('text', word)
  }
  return tokens
}
