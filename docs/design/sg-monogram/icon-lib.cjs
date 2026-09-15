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
  seam: 14,                // G 压住 S 处的暗色分隔缝宽（px），光刃盖不到的上下两端仍能分出两字
  beamWidth: 27,           // 光刃刃身宽（px）：等宽，不是中间鼓的透镜——V12 的光是一根细直的针（实测亮核 ≈ 26px）
  beamLength: 920,         // 光刃全长（px）：28° 下竖向跨度 ≈ 812，两端尖点离底板上下沿各 ≈ 34px——贯穿整块底板才读作"一道光"
  beamTaper: 200,          // 两端各用这么长收成尖（px）；刃身其余部分等宽
  beamAngle: 28,           // 光刃倾角（度，顺时针，顶端靠右）：按 V12 参考实测 ≈ 27.9°
  beamOffset: 0,           // 光刃中心相对两字交界的水平偏移（px）
  beamGlow: 16,            // 光刃周围的金色光晕模糊半径（0 = 无）
  glow: 24,                // 字母外发光模糊半径（0 = 无光晕，小尺寸版用）
  glowOpacity: 0.5,
  tile: true,              // 是否画底板（单色版不画）
  mono: null,              // 单色模式：'#000' / '#fff'（无渐变、无光晕，光刃变成等宽的斜向缺口）
  monoBeamFactor: 1,       // 单色版缺口相对 beamWidth 的倍数（托盘 18px 需要更宽才看得见）
  fit: 0.94,               // 单色版字母外框占画布的比例
  scale: 1,                // 整体缩放（Windows 全出血版 1.135）
  tileShadow: true,        // 底板投影（mac 主图有，Windows / 小尺寸无）
  letterFill: ['#f24b0e', '#ff6f2e', '#ffa348'],
  beamColor: '#fff1c9',    // 光刃两端的暖白
  beamGlowColor: '#ffc46b',
  letterOffsets: [0, 0.55, 1]
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
function glyph(letter, fill, o, extra = '') {
  const strokeWidth = (o.embolden + (extra.includes('data-seam') ? o.seam * 2 : 0))
  const stroke = strokeWidth > 0 ? ` stroke="${fill}" stroke-width="${(strokeWidth / letter.k).toFixed(3)}" stroke-linejoin="miter"` : ''
  return `<path d="${letter.d}" transform="${letter.transform}" fill="${fill}"${stroke}${extra.replace(' data-seam', '')}/>`
}

/** 单色版的缺口：等宽竖条（旋转后成斜向切口）。 */
function beamRect(o, beamX, widthFactor = 1, extra = '') {
  const w = o.beamWidth * widthFactor
  return `<rect x="${(beamX - w / 2).toFixed(1)}" y="-200" width="${w.toFixed(1)}" height="1424"${extra}/>`
}

/**
 * 彩色版的光刃：等宽的细长刃身、两端在 beamTaper 长度内收成尖（六边形），画在字母之上、只裁到底板：
 * 越过字母的部分落在炭黑底上，光刃才有"长度"。竖直构造，随后整体 rotate(beamAngle)。
 */
function bladePath(o, beamX, widthFactor = 1) {
  const half = o.beamLength / 2, w = o.beamWidth * widthFactor / 2, taper = Math.min(o.beamTaper, half)
  const x = (v) => (beamX + v).toFixed(1), y = (v) => (512 + v).toFixed(1)
  return `M${x(0)} ${y(-half)}L${x(w)} ${y(-half + taper)}L${x(w)} ${y(half - taper)}L${x(0)} ${y(half)}L${x(-w)} ${y(half - taper)}L${x(-w)} ${y(-half + taper)}Z`
}

/** 完整图标 SVG（1024×1024）。 */
function iconSvg(overrides = {}) {
  const o = { ...DEFAULTS, ...overrides }
  const l = layout(o)
  const S = { ...l.S, k: l.k }, G = { ...l.G, k: l.k }
  const id = o.idPrefix || 'sg'
  const beamX = l.seamX + o.beamOffset
  const rotate = `rotate(${o.beamAngle} ${beamX.toFixed(1)} 512)`
  if (o.mono) {
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
  const stops = o.letterFill.map((color, index) => `<stop offset="${o.letterOffsets[index].toFixed(2)}" stop-color="${color}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#21212a"/><stop offset="1" stop-color="#101013"/></linearGradient>
    <radialGradient id="${id}-vignette" cx="0.5" cy="0.5" r="0.72"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></radialGradient>
    <linearGradient id="${id}-letters" x1="0" y1="${l.box.bottom.toFixed(1)}" x2="0" y2="${l.box.top.toFixed(1)}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>
    <linearGradient id="${id}-beam" x1="0" y1="${(512 - o.beamLength / 2).toFixed(1)}" x2="0" y2="${(512 + o.beamLength / 2).toFixed(1)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${o.beamColor}" stop-opacity="0"/><stop offset="0.18" stop-color="${o.beamColor}" stop-opacity="0.9"/><stop offset="0.5" stop-color="#fffdf7"/><stop offset="0.82" stop-color="${o.beamColor}" stop-opacity="0.9"/><stop offset="1" stop-color="${o.beamColor}" stop-opacity="0"/></linearGradient>
    <mask id="${id}-s-mask">${glyph(S, '#fff', o)}</mask>
    <clipPath id="${id}-tile-clip"><path d="${TILE_PATH}"/></clipPath>
    <filter id="${id}-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${o.glow}"/></filter>
    ${o.beamGlow > 0 ? `<filter id="${id}-beam-glow" x="-200%" y="-20%" width="500%" height="140%"><feGaussianBlur stdDeviation="${o.beamGlow}"/></filter>` : ''}
    ${o.tileShadow ? `<filter id="${id}-tile-shadow" x="-15%" y="-15%" width="130%" height="135%"><feDropShadow dx="0" dy="13" stdDeviation="18" flood-color="#0b0608" flood-opacity="0.22"/></filter>` : ''}
  </defs>
  <g transform="translate(512 512) scale(${o.scale.toFixed(4)}) translate(-512 -512)">
  ${o.tile ? `<path d="${TILE_PATH}" fill="url(#${id}-tile)"${o.tileShadow ? ` filter="url(#${id}-tile-shadow)"` : ''}/><path d="${TILE_PATH}" fill="url(#${id}-vignette)"/>` : ''}
  <g clip-path="url(#${id}-tile-clip)">
    ${o.glow > 0 ? `<g filter="url(#${id}-glow)" opacity="${o.glowOpacity}">${glyph(S, '#ff6a2c', o)}${glyph(G, '#ff6a2c', o)}</g>` : ''}
    ${glyph(S, `url(#${id}-letters)`, o)}
    <g mask="url(#${id}-s-mask)">${glyph(G, TILE_DARK, o, ' data-seam opacity="0.9"')}</g>
    ${glyph(G, `url(#${id}-letters)`, o)}
    <g transform="${rotate}">
      ${o.beamGlow > 0 ? `<path d="${bladePath(o, beamX, 3)}" fill="${o.beamGlowColor}" opacity="0.55" filter="url(#${id}-beam-glow)"/>` : ''}
      <path d="${bladePath(o, beamX)}" fill="url(#${id}-beam)"/>
    </g>
  </g>
  ${o.tile ? `<path d="${TILE_PATH}" fill="none" stroke="#fff" stroke-opacity="0.05" stroke-width="2"/>` : ''}
  </g>
</svg>`
}

module.exports = { iconSvg, DEFAULTS }
