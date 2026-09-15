#!/usr/bin/env node
// 拾光 SG 字母标 · 设计源 → build/ 里的五份 SVG。
//
//   node docs/design/sg-monogram/generate.cjs   # 重写 build/icon-shiguang*.svg 与 build/trayTemplate.svg
//   npm run icons                                # 再由 SVG 栅格化出 png / icns / ico / 托盘模板 / 应用内品牌标
//
// 四份彩色 SVG 全部嵌 AI 原图（用户定稿：以出图为准，不做矢量重绘）：
//   - 大尺寸（主图 / Windows）：v12-master.png——选定的 V12 原板（光晕、渐变齐全）
//   - 小尺寸（≤64px 两份）：v12-small.png——按小尺寸可读性专门生成的衍生版（纯平色、无光晕、粗光刃）
//   - 底板：mac 内缩 86% 并带投影；Windows 放大到 1.135（≈98% 画布）、无投影
// 托盘模板仍是矢量（icon-lib.cjs iconSvg 的单色模式）：系统要求纯黑 + alpha，字母贴满画布，
// 光刃变成 3 倍宽的斜向缺口。矢量字形取自 macOS Futura Bold 轮廓（glyphs.json），不依赖字体。
const fs = require('node:fs')
const path = require('node:path')
const { iconSvg, rasterIconSvg, RASTER_SRC } = require('./icon-lib.cjs')

const BUILD = path.resolve(__dirname, '../../../build')
const V12 = fs.readFileSync(path.join(__dirname, 'v12-master.png')).toString('base64')
const V12_SMALL = fs.readFileSync(path.join(__dirname, 'v12-small.png')).toString('base64')
const WINDOWS = { scale: 1.135, tileShadow: false }
const SMALL = { tileShadow: false, src: RASTER_SRC.small }
const TRAY = { mono: '#000', monoBeamFactor: 3 }

const MASTER_NOTE = 'V12 定稿原图（AI 出图）裁出底板区域按 squircle 剪裁嵌入，光刃过正中——矢量重绘的光刃只能落在 S/G 交界（Futura 的 S 窄 G 宽，交界偏离中心），用户选原图'
const SMALL_NOTE = 'V12 的小尺寸衍生 AI 图（纯平色、无光晕、粗光刃，专为 16–64px 可读性生成）全出血嵌入'
const TRAY_NOTE = '字形取自 Futura Bold（macOS 自带）的 S / G 轮廓并同色描边加粗 32px；光刃为 3 倍宽斜向缺口'

const FILES = [
  ['icon-shiguang.svg', () => rasterIconSvg(V12), '主图（macOS：底板占画布 86% 并带投影，Dock 视觉重量与原生图标一致）', MASTER_NOTE],
  ['icon-shiguang-small.svg', () => rasterIconSvg(V12_SMALL, SMALL), '小尺寸版（≤64px）', SMALL_NOTE],
  ['icon-shiguang-win.svg', () => rasterIconSvg(V12, WINDOWS), 'Windows 版（底板放大到约 98% 画布、无投影：Windows 图标不做 mac 式内缩）', MASTER_NOTE],
  ['icon-shiguang-win-small.svg', () => rasterIconSvg(V12_SMALL, { ...WINDOWS, src: RASTER_SRC.small }), 'Windows 小尺寸版（任务栏 / 通知区 16–64px）', SMALL_NOTE],
  ['trayTemplate.svg', () => iconSvg(TRAY), 'macOS 菜单栏模板图（纯黑 + alpha，系统按明暗上色）：字母剪影贴满画布，光刃变成斜向缺口', TRAY_NOTE]
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
