#!/usr/bin/env node
// 拾光 SG 字母标 · 设计源 → build/ 里的五份 SVG。
//
//   node docs/design/sg-monogram/generate.cjs   # 重写 build/icon-shiguang*.svg 与 build/trayTemplate.svg
//   npm run icons                                # 再由 SVG 栅格化出 png / icns / ico / 托盘模板 / 应用内品牌标
//
// 大尺寸两份（主图 / Windows）直接嵌 V12 定稿原图（v12-master.png，squircle 剪裁 + 出血），
// 小尺寸与托盘仍是矢量（icon-lib.cjs 的 DEFAULTS），分叉维度：
//   - 底板：mac 主图内缩 86% 并带投影；Windows 放大到 1.135（≈98% 画布）、无投影
//   - 尺寸：≤64px 的小图去光晕、光刃 27→70、接缝 14→22，缩到 16px 仍是"两个橙字 + 一道斜光"
//   - 单色：菜单栏模板图不画底板与渐变，字母贴满画布，光刃变成 3 倍宽的斜向缺口
// 矢量字形来源：macOS 自带 Futura Bold 的 S / G 轮廓（glyphs.json，由 extract-glyphs.cjs 提取），
// 再同色描边加粗 32px；字母本身不是文本，SVG 不依赖任何字体。
const fs = require('node:fs')
const path = require('node:path')
const { iconSvg, rasterIconSvg } = require('./icon-lib.cjs')

const BUILD = path.resolve(__dirname, '../../../build')
const V12 = fs.readFileSync(path.join(__dirname, 'v12-master.png')).toString('base64')
const SMALL = { glow: 0, beamGlow: 0, beamWidth: 70, seam: 22, tileShadow: false }
const WINDOWS = { scale: 1.135, tileShadow: false }
const TRAY = { mono: '#000', monoBeamFactor: 3 }

const RASTER_NOTE = 'V12 定稿原图（AI 出图）裁出底板区域按 squircle 剪裁嵌入，光刃过正中——矢量重绘的光刃只能落在 S/G 交界（Futura 的 S 窄 G 宽，交界偏离中心），用户选原图'
const VECTOR_NOTE = '字形取自 Futura Bold（macOS 自带）的 S / G 轮廓并同色描边加粗 32px；光刃 28° 斜贯整块底板、两端收尖，落在 S/G 交界上'

const FILES = [
  ['icon-shiguang.svg', () => rasterIconSvg(V12), '主图（macOS：底板占画布 86% 并带投影，Dock 视觉重量与原生图标一致）', RASTER_NOTE],
  ['icon-shiguang-small.svg', () => iconSvg(SMALL), '小尺寸版（≤64px：去光晕、光刃加宽到 70，保证 16/32px 仍可读）', VECTOR_NOTE],
  ['icon-shiguang-win.svg', () => rasterIconSvg(V12, WINDOWS), 'Windows 版（底板放大到约 98% 画布、无投影：Windows 图标不做 mac 式内缩）', RASTER_NOTE],
  ['icon-shiguang-win-small.svg', () => iconSvg({ ...WINDOWS, ...SMALL }), 'Windows 小尺寸版（任务栏 / 通知区 16–64px）', VECTOR_NOTE],
  ['trayTemplate.svg', () => iconSvg(TRAY), 'macOS 菜单栏模板图（纯黑 + alpha，系统按明暗上色）：字母剪影贴满画布，光刃变成斜向缺口', VECTOR_NOTE]
]

for (const [name, build, what, how] of FILES) {
  const note = `<!-- 拾光 SG 字母标 · ${what}
     ${how}。
     本文件由 docs/design/sg-monogram/generate.cjs 生成（参数见该文件），不要手改；栅格产物用 npm run icons 重新生成。 -->
`
  const target = path.join(BUILD, name)
  fs.writeFileSync(target, note + build())
  console.log(`✓ ${path.relative(process.cwd(), target)}`)
}
