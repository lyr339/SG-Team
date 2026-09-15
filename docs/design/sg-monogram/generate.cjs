#!/usr/bin/env node
// 拾光 SG 字母标 · 设计源 → build/ 里的五份 SVG。
//
//   node docs/design/sg-monogram/generate.cjs   # 重写 build/icon-shiguang*.svg 与 build/trayTemplate.svg
//   npm run icons                                # 再由 SVG 栅格化出 png / icns / ico / 托盘模板 / 应用内品牌标
//
// 五份 SVG 出自同一套参数（icon-lib.cjs 的 DEFAULTS），只在四个维度上分叉：
//   - 底板：mac 主图内缩 86% 并带投影；Windows 放大到 1.135（≈98% 画布）、无投影
//   - 尺寸：≤64px 的小图去光晕、光束 32→60、接缝 16→22、字母 400→430，缩到 16px 仍是"两个橙字 + 一道斜切"
//   - 单色：菜单栏模板图不画底板与渐变，字母贴满画布，光束变成 2.8 倍宽的斜向缺口
// 字形来源：macOS 自带 Futura Bold 的 S / G 轮廓（glyphs.json，由 extract-glyphs.cjs 提取），
// 再同色描边加粗 22px；字母本身不是文本，SVG 不依赖任何字体。
const fs = require('node:fs')
const path = require('node:path')
const { iconSvg } = require('./icon-lib.cjs')

const BUILD = path.resolve(__dirname, '../../../build')
const SMALL = { glow: 0, beamWidth: 60, capHeight: 430, seam: 22, tileShadow: false }
const WINDOWS = { scale: 1.135, tileShadow: false }

const FILES = [
  ['icon-shiguang.svg', {}, '主图（macOS：底板占画布 86% 并带投影，Dock 视觉重量与原生图标一致）'],
  ['icon-shiguang-small.svg', SMALL, '小尺寸版（≤64px：去光晕、光束加宽到 60、字母略大，保证 16/32px 仍可读）'],
  ['icon-shiguang-win.svg', WINDOWS, 'Windows 版（底板放大到约 98% 画布、无投影：Windows 图标不做 mac 式内缩）'],
  ['icon-shiguang-win-small.svg', { ...WINDOWS, ...SMALL }, 'Windows 小尺寸版（任务栏 / 通知区 16–64px）'],
  ['trayTemplate.svg', { mono: '#000', monoBeamFactor: 2.8 }, 'macOS 菜单栏模板图（纯黑 + alpha，系统按明暗上色）：字母剪影贴满画布，光束变成斜向缺口']
]

for (const [name, overrides, what] of FILES) {
  const note = `<!-- 拾光 SG 字母标 · ${what}
     字形取自 Futura Bold（macOS 自带）的 S / G 轮廓并同色描边加粗 22px；光束 20° 斜切、只在笔画内出现。
     本文件由 docs/design/sg-monogram/generate.cjs 生成（参数见该文件），不要手改；栅格产物用 npm run icons 重新生成。 -->
`
  const target = path.join(BUILD, name)
  fs.writeFileSync(target, note + iconSvg(overrides))
  console.log(`✓ ${path.relative(process.cwd(), target)}`)
}
