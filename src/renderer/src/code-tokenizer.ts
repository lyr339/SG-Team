/** 会话编辑预览与右栏 diff 共用的轻量行内分词，不加载完整语法高亮器。 */
const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import',
  'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'return', 'switch', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'
])

export type CodeTokenTone = 'plain' | 'comment' | 'keyword' | 'string' | 'number' | 'name' | 'operator'
export interface CodeToken { text: string; tone: CodeTokenTone }

export function tokenizeCodeLine(line: string, hashComments = true): CodeToken[] {
  const pattern = /(\/\*.*?\*\/|\/\/.*$|#|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b|[=!<>+\-*/|&?:]+)/gi
  const tokens: CodeToken[] = []
  let cursor = 0
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ text: line.slice(cursor, index), tone: 'plain' })
    const text = match[0]
    if (text === '#' && hashComments) {
      tokens.push({ text: line.slice(index), tone: 'comment' })
      cursor = line.length
      break
    }
    const tone: CodeTokenTone = text.startsWith('//') || text.startsWith('/*')
      ? 'comment'
      : /^['"`]/.test(text) ? 'string'
        : /^(?:0x[\da-f]+|\d)/i.test(text) ? 'number'
          : KEYWORDS.has(text) ? 'keyword'
            : /^[A-Za-z_$]/.test(text) ? 'name' : 'operator'
    tokens.push({ text, tone })
    cursor = index + text.length
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), tone: 'plain' })
  return tokens.length ? tokens : [{ text: line || ' ', tone: 'plain' }]
}
