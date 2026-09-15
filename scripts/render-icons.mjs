#!/usr/bin/env node
/**
 * 由 build/ 里的 SVG 设计源重新生成全部图标栅格产物（`npm run icons`）：
 *
 *   build/icon-shiguang-1024.png          Dock 运行时图标（app.dock.setIcon）= mac 图标最大一档
 *   build/icon-shiguang.icns              mac 应用图标：16–1024 十档（iconutil，仅 macOS 可产）
 *   build/icon-shiguang.ico               Windows 应用 / 任务栏 / 通知区图标：16–256 九档
 *   build/trayTemplate.png, @2x           mac 菜单栏模板图（18 / 36，纯黑 + alpha，系统按明暗上色）
 *   src/renderer/public/brand-shiguang.png 应用内品牌标（顶栏 32px、开工页 40px；全出血源 512px）
 *
 * 设计源分四份是因为同一张矢量图不能同时在 1024 与 16px 下都对：
 *   icon-shiguang.svg        mac 主图 —— 底板占画布 86% 并带投影（Dock 视觉重量与原生图标一致）
 *   icon-shiguang-small.svg  ≤64px —— 去光晕、光束加宽、字母略大，缩到 16px 仍是"两个橙字 + 一道斜切"
 *   icon-shiguang-win.svg    Windows —— 底板放大到约 98% 画布、无投影（Windows 图标不做 mac 式内缩）
 *   icon-shiguang-win-small.svg  Windows ≤64px（任务栏 / 通知区 16–32px 主要靠它）
 *   trayTemplate.svg         菜单栏剪影：字母贴满画布，光束变成斜向缺口
 *
 * 栅格化用本机 Chromium 内核浏览器（Chrome / Edge，PREVIEW_BROWSER 可指定，同 preview-shots.mjs）：
 * 每档尺寸都把 SVG 以该尺寸排版后截图，而不是 1024 缩小 —— 光晕、光束、接缝都按目标像素重算，
 * 小图不糊；Node 24 内建 fetch / WebSocket，脚本零依赖。
 *
 * .ico 的 ≤48px 帧存未压缩 32 位 DIB（最老的资源查看器也认），更大的帧存 PNG（Vista+ / NSIS 3 均支持）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build')
const SOURCES = {
  mac: join(BUILD, 'icon-shiguang.svg'),
  macSmall: join(BUILD, 'icon-shiguang-small.svg'),
  win: join(BUILD, 'icon-shiguang-win.svg'),
  winSmall: join(BUILD, 'icon-shiguang-win-small.svg'),
  tray: join(BUILD, 'trayTemplate.svg')
}
/** 这个像素尺寸及以下改用 -small 源（实测 48 / 64px 上主图的光晕把光束糊成一团，小图源仍是干脆的一道）。 */
const SMALL_MAX_PX = 64
const MAC_ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
]
/** Windows 在 100–200% DPI 的任务栏 / 通知区 / 资源管理器里会用到的全部档位。 */
const WIN_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const WIN_DIB_MAX_PX = 48
const TRAY_SIZES = [['trayTemplate.png', 18], ['trayTemplate@2x.png', 36]]
const BRAND_MARK = { path: join(ROOT, 'src/renderer/public/brand-shiguang.png'), size: 512 }

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function resolveBrowser() {
  if (process.env.PREVIEW_BROWSER) return process.env.PREVIEW_BROWSER
  const candidates = process.platform === 'win32'
    ? [
        `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  const found = candidates.find((candidate) => candidate && existsSync(candidate))
  if (!found) throw new Error('未找到 Chrome / Edge；用 PREVIEW_BROWSER 指定可执行文件')
  return found
}

/** 一个无头页面，按精确像素尺寸栅格化 SVG；同一 (源, 尺寸) 只渲染一次。 */
class Rasterizer {
  static async launch() {
    const profile = mkdtempSync(join(tmpdir(), 'sg-render-icons-'))
    const child = spawn(resolveBrowser(), [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--hide-scrollbars',
      'about:blank'
    ], { stdio: 'ignore' })
    const rasterizer = new Rasterizer(child, profile)
    try {
      await rasterizer.connect()
    } catch (error) {
      await rasterizer.close()
      throw error
    }
    return rasterizer
  }

  constructor(child, profile) {
    this.child = child
    this.profile = profile
    this.seq = 0
    this.pending = new Map()
    this.cache = new Map()
  }

  async connect() {
    // 端口由浏览器自选，写在 profile 的 DevToolsActivePort 里（第一行端口号）。
    const portFile = join(this.profile, 'DevToolsActivePort')
    let port
    for (let i = 0; i < 150 && !port; i++) {
      if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
      if (!port) await sleep(100)
    }
    if (!port) throw new Error('浏览器没有在 15s 内暴露调试端口')
    let endpoint
    for (let i = 0; i < 50 && !endpoint; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) endpoint = (await response.json()).webSocketDebuggerUrl
      } catch {}
      if (!endpoint) await sleep(100)
    }
    if (!endpoint) throw new Error('浏览器调试端点不可达')
    this.socket = new WebSocket(endpoint)
    await new Promise((done, fail) => { this.socket.onopen = done; this.socket.onerror = () => fail(new Error('调试 WebSocket 连接失败')) })
    this.socket.onmessage = (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      const settle = message.id && this.pending.get(message.id)
      if (settle) { this.pending.delete(message.id); settle(message) }
    }
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    this.sessionId = (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    this.frameId = (await this.send('Page.getFrameTree')).frameTree.frame.id
  }

  send(method, params = {}) {
    return new Promise((done, fail) => {
      const id = ++this.seq
      this.pending.set(id, (message) => message.error ? fail(new Error(`${method}: ${JSON.stringify(message.error)}`)) : done(message.result))
      // 附着到页面之前的两条 Target.* 走浏览器级会话，之后全部带页面 sessionId。
      this.socket.send(JSON.stringify({ id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }))
    })
  }

  /** SVG 文件 → 该尺寸的透明 PNG（Buffer）。 */
  async png(svgPath, size) {
    const key = `${svgPath}@${size}`
    if (!this.cache.has(key)) this.cache.set(key, this.renderPng(svgPath, size))
    return this.cache.get(key)
  }

  async renderPng(svgPath, size) {
    const svg = readFileSync(svgPath, 'utf8')
    await this.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false })
    // 不导航（about:blank → data:/file: 会换渲染进程，flatten 会话随之失效）：直接写文档内容。
    await this.send('Page.setDocumentContent', {
      frameId: this.frameId,
      html: `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`
    })
    await this.send('Runtime.evaluate', { expression: 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))', awaitPromise: true })
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 }, captureBeyondViewport: false })
    return Buffer.from(data, 'base64')
  }

  /** PNG → 直通 RGBA 像素（在页面里经 canvas 解码；只用于 .ico 的小尺寸 DIB 帧）。 */
  async rgba(png, size) {
    const { result } = await this.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const image = new Image()
        image.src = 'data:image/png;base64,${png.toString('base64')}'
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = ${size}; canvas.height = ${size}
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0)
        const data = context.getImageData(0, 0, ${size}, ${size}).data
        let text = ''
        for (let i = 0; i < data.length; i++) text += String.fromCharCode(data[i])
        return btoa(text)
      })()`
    })
    const pixels = Buffer.from(result.value, 'base64')
    if (pixels.length !== size * size * 4) throw new Error(`像素数不对：${pixels.length} ≠ ${size}×${size}×4`)
    return pixels
  }

  async close() {
    try { this.socket?.close() } catch {}
    this.child.kill()
    await sleep(200)
    rmSync(this.profile, { recursive: true, force: true })
  }
}

/** 32 位 BGRA + 1 位 AND 掩码的 ICO 位图帧（BITMAPINFOHEADER，高度写成两倍，行序自下而上）。 */
function dibFrame(rgba, size) {
  const maskRowBytes = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4 + maskRowBytes * size, 20)
  const xor = Buffer.alloc(size * size * 4)
  const and = Buffer.alloc(maskRowBytes * size)
  for (let row = 0; row < size; row++) {
    const source = (size - 1 - row) * size * 4
    for (let x = 0; x < size; x++) {
      const from = source + x * 4
      const to = (row * size + x) * 4
      xor[to] = rgba[from + 2]
      xor[to + 1] = rgba[from + 1]
      xor[to + 2] = rgba[from]
      xor[to + 3] = rgba[from + 3]
      if (rgba[from + 3] === 0) and[row * maskRowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([header, xor, and])
}

/** ICONDIR + ICONDIRENTRY 表 + 各帧数据；256px 在目录里以 0 表示。 */
function icoFile(frames) {
  const directory = Buffer.alloc(6)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(frames.length, 4)
  let offset = 6 + 16 * frames.length
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return Buffer.concat([directory, ...entries, ...frames.map((frame) => frame.data)])
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  console.log(`✓ ${relative(ROOT, path)}  ${(statSync(path).size / 1024).toFixed(1)} KB`)
}

const rasterizer = await Rasterizer.launch()
try {
  const macSource = (size) => (size <= SMALL_MAX_PX ? SOURCES.macSmall : SOURCES.mac)
  const winSource = (size) => (size <= SMALL_MAX_PX ? SOURCES.winSmall : SOURCES.win)

  write(join(BUILD, 'icon-shiguang-1024.png'), await rasterizer.png(SOURCES.mac, 1024))

  if (process.platform === 'darwin') {
    const iconset = mkdtempSync(join(tmpdir(), 'sg-iconset-'))
    const iconsetDirectory = join(iconset, 'icon-shiguang.iconset')
    mkdirSync(iconsetDirectory)
    for (const [name, size] of MAC_ICONSET) writeFileSync(join(iconsetDirectory, name), await rasterizer.png(macSource(size), size))
    const icns = join(BUILD, 'icon-shiguang.icns')
    execFileSync('iconutil', ['-c', 'icns', iconsetDirectory, '-o', icns])
    rmSync(iconset, { recursive: true, force: true })
    console.log(`✓ ${relative(ROOT, icns)}  ${(statSync(icns).size / 1024).toFixed(1)} KB（${MAC_ICONSET.length} 档）`)
  } else {
    console.log('· 跳过 icon-shiguang.icns：iconutil 只有 macOS 有')
  }

  const frames = []
  for (const size of WIN_ICO_SIZES) {
    const png = await rasterizer.png(winSource(size), size)
    frames.push({ size, data: size <= WIN_DIB_MAX_PX ? dibFrame(await rasterizer.rgba(png, size), size) : png })
  }
  write(join(BUILD, 'icon-shiguang.ico'), icoFile(frames))

  for (const [name, size] of TRAY_SIZES) write(join(BUILD, name), await rasterizer.png(SOURCES.tray, size))
  write(BRAND_MARK.path, await rasterizer.png(SOURCES.win, BRAND_MARK.size))
} finally {
  await rasterizer.close()
}
