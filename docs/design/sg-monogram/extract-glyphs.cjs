#!/usr/bin/env node
// 从 macOS 自带的 Futura.ttc 里提取 Bold 字重的 S / G 轮廓，写成 glyphs.json（icon-lib.cjs 的字形来源）。
// 一次性工具，只在换字体 / 换字母时才需要重跑；依赖 fontkit（不在项目依赖里，临时装）：
//   npx --yes -p fontkit@2 node docs/design/sg-monogram/extract-glyphs.cjs
// 轮廓统一缩放到 1000 UPM、y 向下（SVG 坐标系），基线在 y=0；bbox 供 icon-lib 做字距与居中。
const fs = require('node:fs')
const path = require('node:path')
const fontkit = require('fontkit')

const SOURCE = '/System/Library/Fonts/Supplemental/Futura.ttc'
const STYLE = /Bold$/
const LETTERS = ['S', 'G']

const collection = fontkit.openSync(SOURCE)
const font = (collection.fonts ?? [collection]).find((candidate) => STYLE.test(candidate.postscriptName || ''))
if (!font) throw new Error(`${SOURCE}: no font matching ${STYLE}`)

const scale = 1000 / font.unitsPerEm
const entry = { name: font.postscriptName, unitsPerEm: font.unitsPerEm, capHeight: font.capHeight * scale, glyphs: {} }
for (const letter of LETTERS) {
  const glyph = font.glyphForCodePoint(letter.codePointAt(0))
  // fontkit 的 path 以 y 向上的字体坐标给出；这里翻转为 y 向下并缩放到 1000 UPM。
  const outline = glyph.path.scale(scale, -scale)
  entry.glyphs[letter] = { d: outline.toSVG(), advance: glyph.advanceWidth * scale, bbox: outline.bbox }
}
fs.writeFileSync(path.join(__dirname, 'glyphs.json'), JSON.stringify({ [entry.name]: entry }, null, 1) + '\n')
console.log(entry.name, 'capHeight', Math.round(entry.capHeight), LETTERS.map((letter) => `${letter} adv ${Math.round(entry.glyphs[letter].advance)}`).join(', '))
