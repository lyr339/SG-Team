/**
 * 文件类型 → 图标族。文件栏、（将来的）审查页等任何要按类型给文件配图标的地方都从这里取，
 * 图标本体在 FileTypeIcon.tsx。
 */
export type FileIconKind =
  | 'typescript' | 'react' | 'javascript' | 'json' | 'styles' | 'markdown' | 'markup'
  | 'image' | 'shell' | 'config' | 'code' | 'file'

/**
 * 扩展名 → 图标族。tsx / jsx 归 React（与 Cursor 一致：组件文件看框架不看语言）；
 * 未列出的扩展名给通用文件图标——名字里本来就带着扩展名，图标只是辅助指认。
 */
const ICON_KINDS: Record<string, FileIconKind> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'react', jsx: 'react',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', jsonl: 'json',
  css: 'styles', scss: 'styles', less: 'styles',
  md: 'markdown', mdx: 'markdown',
  html: 'markup', htm: 'markup', svg: 'markup', xml: 'markup', vue: 'markup', svelte: 'markup',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', avif: 'image',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell',
  yml: 'config', yaml: 'config', toml: 'config', ini: 'config', env: 'config', lock: 'config', properties: 'config',
  py: 'code', rs: 'code', go: 'code', java: 'code', kt: 'code', swift: 'code', rb: 'code', php: 'code',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', cs: 'code', sql: 'code', graphql: 'code', gql: 'code'
}

/** 扩展名（含点或不含点，大小写不敏感）→ 图标族。 */
export function fileIconKind(ext: string): FileIconKind {
  return ICON_KINDS[ext.replace(/^\./, '').toLowerCase()] ?? 'file'
}
