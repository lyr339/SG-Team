// 拾光 SG 字母标（「光束」方向）的矢量构造：字形轮廓 + 参数 → 1024 viewBox 的 SVG 文本。
// 只被同目录 generate.cjs 调用；build/ 里的五份 SVG 全部由它产出，改参数后重跑 generate.cjs 再 `npm run icons`。
const glyphs = require('./glyphs.json')

/** 与上一代图标相同的 macOS 圆角方块（squircle），底板占 1024 画布的 86%。 */
const TILE_PATH = 'M330 72H694C800 72 860 72 906 118C952 164 952 224 952 330V694C952 800 952 860 906 906C860 952 800 952 694 952H330C224 952 164 952 118 906C72 860 72 800 72 694V330C72 224 72 164 118 118C164 72 224 72 330 72Z'
const TILE_DARK = '#141416'

const DEFAULTS = {
  font: 'Futura-Bold',
  capHeight: 430,          // 字母大写高度（px，1024 画布）：两字箱体约占底板宽 90%，向 V12 的"字撑满底板"靠
  overlap: 0.14,           // G 压在 S 上的比例（相对 S 宽）：两字紧咬，光刃正好落在交界上
  embolden: 32,            // 字形加粗（同色描边宽，px）：Futura Bold → 视觉上接近 Heavy，V12 的字就是这个分量
  beamWidth: 27,           // 光刃刃身宽（px）：等宽，不是中间鼓的透镜——V12 的光是一根细直的针（实测亮核 ≈ 26px）
  beamAngle: 28,           // 光刃倾角（度，顺时针，顶端靠右）：按 V12 参考实测 ≈ 27.9°
  beamOffset: 0,           // 光刃中心相对两字交界的水平偏移（px）
  mono: '#000',              // 单色模式：'#000' / '#fff'（无渐变、无光晕，光刃变成等宽的斜向缺口）
  monoBeamFactor: 1,       // 单色版缺口相对 beamWidth 的倍数（托盘 18px 需要更宽才看得见）
  fit: 0.94,               // 单色版字母外框占画布的比例
}

/** 字母布局：两枚字形的 transform、接缝位置与联合外框（1024 画布坐标）。 */
function layout(o) {
  const entry = glyphs[o.font]
  if (!entry) throw new Error(`unknown font ${o.font}`)
  const S = entry.glyphs.S, G = entry.glyphs.G
  const k = o.capHeight / entry.capHeight
  const sWidth = (S.bbox.maxX - S.bbox.minX) * k + o.embolden
  const gWidth = (G.bbox.maxX - G.bbox.minX) * k + o.embolden
  const overlapPx = sWidth * o.overlap
  const total = sWidth + gWidth - overlapPx
  const left = 512 - total / 2
  const baseline = 512 + o.capHeight / 2
  const sX = left + o.embolden / 2 - S.bbox.minX * k
  const gX = left + sWidth - overlapPx + o.embolden / 2 - G.bbox.minX * k
  return {
    S: { d: S.d, transform: `translate(${sX.toFixed(2)} ${baseline.toFixed(2)}) scale(${k.toFixed(5)})` },
    G: { d: G.d, transform: `translate(${gX.toFixed(2)} ${baseline.toFixed(2)}) scale(${k.toFixed(5)})` },
    seamX: left + sWidth - overlapPx / 2,
    box: { left, right: left + total, top: 512 - o.capHeight / 2 - o.embolden / 2, bottom: baseline + o.embolden / 2 },
    k
  }
}

/** 一枚字形：填充 + 同色描边加粗（描边在字形坐标系外施加，宽度按 1024 画布计）。 */
function glyph(letter, fill, o) {
  const strokeWidth = o.embolden
  const stroke = strokeWidth > 0 ? ` stroke="${fill}" stroke-width="${(strokeWidth / letter.k).toFixed(3)}" stroke-linejoin="miter"` : ''
  return `<path d="${letter.d}" transform="${letter.transform}" fill="${fill}"${stroke}/>`
}

/** 单色版的缺口：等宽竖条（旋转后成斜向切口）。 */
function beamRect(o, beamX, widthFactor = 1, extra = '') {
  const w = o.beamWidth * widthFactor
  return `<rect x="${(beamX - w / 2).toFixed(1)}" y="-200" width="${w.toFixed(1)}" height="1424"${extra}/>`
}

/**
 * V12 光栅图（1024×1024）：图标画面直接用选定 / 衍生的 AI 原图，不再矢量重绘。
 * 用户定稿：矢量版的光刃落在 S/G 交界上，而 Futura 的 S 窄 G 宽，交界天然偏离底板中心约 6.5%——
 * V12 原图的光刃过正中，字形也是为此定制的；两者不可兼得，用户选原图。
 * 几何（全部按像素实测）：src 描述原图里底板的位置（tileX/tileY/tileSide 及原图宽高），
 * 按边精确映射到 TILE_PATH 的 72–952。AI 原图底板的圆角弧和 macOS squircle 形状不一致
 * （主图的弧中段比 squircle 深最多 ~27px），直接用 TILE_PATH 剪裁会在角部采到原图的浅色背景——
 * 所以图像单独用一个"更深圆角"的圆角矩形剪裁（内缩 6px、rx 240，处处包住原图自己的角弧），
 * 角部缺口由底下的纯色底板补齐：那里本来就是平坦的深色。
 * 两份源图：v12-master.png（大尺寸档，带光晕渐变）；v12-small.png（≤64px 档，纯平色、粗光刃，
 * 按小尺寸可读性专门生成，全出血方形）。托盘模板仍走矢量（trayIconSvg）：系统要求纯黑 + alpha。
 */
const RASTER_SRC = {
  master: { w: 1152, h: 864, tileX: 88, tileY: 119, tileSide: 601.5 }, // v12-master.png 底板实测
  small: { w: 1024, h: 1024, tileX: 0, tileY: 0, tileSide: 1024 }      // v12-small.png 全出血
}

function rasterIconSvg(pngBase64, overrides = {}) {
  const o = { scale: 1, tileShadow: true, src: RASTER_SRC.master, ...overrides }
  const s = 880 / o.src.tileSide // 源底板边长 → 画布 880px（72–952）
  const x = 72 - o.src.tileX * s, y = 72 - o.src.tileY * s
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <clipPath id="v12-img-clip"><rect x="78" y="78" width="868" height="868" rx="240"/></clipPath>
    <clipPath id="v12-tile-clip"><path d="${TILE_PATH}"/></clipPath>
    ${o.tileShadow ? `<filter id="v12-tile-shadow" x="-15%" y="-15%" width="130%" height="135%"><feDropShadow dx="0" dy="13" stdDeviation="18" flood-color="#0b0608" flood-opacity="0.22"/></filter>` : ''}
  </defs>
  <g transform="translate(512 512) scale(${o.scale.toFixed(4)}) translate(-512 -512)">
  <path d="${TILE_PATH}" fill="${TILE_DARK}"${o.tileShadow ? ` filter="url(#v12-tile-shadow)"` : ''}/>
  <g clip-path="url(#v12-tile-clip)"><g clip-path="url(#v12-img-clip)"><image href="data:image/png;base64,${pngBase64}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(o.src.w * s).toFixed(1)}" height="${(o.src.h * s).toFixed(1)}"/></g></g>
  <path d="${TILE_PATH}" fill="none" stroke="#fff" stroke-opacity="0.05" stroke-width="2"/>
  </g>
</svg>`
}

/** 仅供系统托盘使用的单色 SVG；彩色图标统一走已定稿的光栅源。 */
function trayIconSvg(overrides = {}) {
  const o = { ...DEFAULTS, ...overrides }
  const l = layout(o)
  const S = { ...l.S, k: l.k }, G = { ...l.G, k: l.k }
  const id = o.idPrefix || 'sg'
  const beamX = l.seamX + o.beamOffset
  const rotate = `rotate(${o.beamAngle} ${beamX.toFixed(1)} 512)`
  // 单色模板：两字剪影，光束变成一道斜向缺口（菜单栏 / 单色场合的记忆点）。
  // 字母整体放大到贴满画布（fit），托盘 18px 格子里才有足够像素；缺口按 monoBeamFactor 加宽。
  const boxW = l.box.right - l.box.left, boxH = l.box.bottom - l.box.top
  const fit = o.fit * 1024 / Math.max(boxW, boxH)
  const cx = (l.box.left + l.box.right) / 2, cy = (l.box.top + l.box.bottom) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <mask id="${id}-cut"><rect x="-2000" y="-2000" width="5024" height="5024" fill="#fff"/><g transform="${rotate}">${beamRect(o, beamX, o.monoBeamFactor, ' fill="#000"')}</g></mask>
  </defs>
  <g transform="translate(512 512) scale(${fit.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})"><g mask="url(#${id}-cut)">${glyph(S, o.mono, o)}${glyph(G, o.mono, o)}</g></g>
</svg>`
}

module.exports = { trayIconSvg, rasterIconSvg, RASTER_SRC }
