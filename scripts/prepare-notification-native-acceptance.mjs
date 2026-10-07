import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

// PREPARE ONLY. A native notice is sent only by the explicit UI button, once.
// Own bundle/profile: never boot production main or read user accounts/config.
if (process.platform !== 'darwin') throw Error('此隔离验收准备器仅用于本机 macOS；Windows 工程适配由正式包/契约检查验收')
const root = resolve(import.meta.dirname, '..'), output = join(root, 'preview-screenshots/notification-implementation/acceptance/native')
const layoutOnly = process.argv.includes('--layout-only')
const app = join(output, 'SGNotificationQA.app'), source = join(output, 'source')
if (existsSync(app)) throw Error('隔离验收 bundle 已存在；不要覆盖正在运行的验收应用')
const profile = mkdtempSync(join(tmpdir(), 'sg-notification-native-'))
mkdirSync(source, { recursive: true })
cpSync(join(root, 'node_modules/electron/dist/Electron.app'), app, { recursive: true, verbatimSymlinks: true })
const resource = join(app, 'Contents/Resources/app'); mkdirSync(resource, { recursive: true })
const workerRoot = join(root, 'release/mac-arm64/拾光.app/Contents/Resources/app.asar/out/main')
// The ASAR path is read at runtime by Electron, not by unpatched host Node fs.
const entry = readdirSync(join(root, 'out/main')).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('需要当前编译的 notification worker 和 mac 目录包')
const imported = file => JSON.stringify(join(root, file))
const main = `
import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { Worker } from 'node:worker_threads'
import { writeFileSync } from 'node:fs'
import { NotificationService } from ${imported('src/application/notification-service.ts')}
import { NotificationWorkerPort } from ${imported('src/main/notification-worker-port.ts')}
import { NotificationDeliveryService } from ${imported('src/application/notification-delivery-service.ts')}
import { createNativeNotificationPort } from ${imported('src/main/native-notification-port.ts')}
const profile = ${JSON.stringify(profile)}, result = profile + '/result.json'
const layoutOnly = ${JSON.stringify(layoutOnly)}
app.setName('SGNotificationQA'); app.setPath('userData', profile)
const events = { requests: 0, shown: 0, clicks: 0, closes: 0, failures: 0, windowsOpened: 0 }, observed = [], setupErrors = []
let win, owner, delivery, sent = false, unread = 0, quitting = false
const save = () => { const state = { platform: process.platform, arch: process.arch, electron: process.versions.electron, isolated: true,
  actualNativeApi: true, silent: true, sent, events: { ...events }, unread, delivery: delivery?.status(), openRequested: delivery?.openRequested(), observed,
  layoutOnly, zoomFactor: win?.webContents.getZoomFactor(), setupErrors, noBusinessAccountCursorOrPermissionChanges: true }; writeFileSync(result, JSON.stringify(state, null, 2)); if(win && !win.isDestroyed())win.webContents.send('qa:state', state); return state }
app.whenReady().then(async () => {
  owner = new NotificationService(new NotificationWorkerPort(options => { const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(join(workerRoot, entry)).href)}), options);
    worker.on('error', error => { setupErrors.push(String(error)); save() }); worker.on('message', message => { if(message.id===0 && !message.ok){setupErrors.push(message.error);save()} }); return worker }, profile + '/private.sqlite'))
  const native = createNativeNotificationPort()
  delivery = new NotificationDeliveryService(owner, { foreground: () => Boolean(win?.isVisible() && win.isFocused()),
    native: { supported: () => native.supported(), show: (content, callbacks) => { events.requests++; save(); return native.show(content, {
      shown: () => { events.shown++; observed.push('show'); callbacks.shown(); save() },
      clicked: () => { events.clicks++; observed.push('click'); callbacks.clicked(); save() },
      closed: reason => { events.closes++; observed.push('close:' + reason); callbacks.closed(reason); save() },
      failed: () => { events.failures++; observed.push('failed'); callbacks.failed(); save() }
    }) } }, openWindow: () => { if(quitting)return; events.windowsOpened++; win.show(); win.focus(); save() } })
  owner.subscribe(event => { if(event.change)unread=event.change.summary.unread; save() })
  await delivery.flush()
  win = new BrowserWindow({ width: layoutOnly ? 1280 : 680, height: layoutOnly ? 820 : 420, title: '拾光 · 隔离验收', webPreferences: { preload: ${JSON.stringify(join(resource, 'preload.cjs'))}, contextIsolation: true, sandbox: true } })
  const allowed = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  ipcMain.handle('qa:state', event => { if(!allowed(event))throw Error('非验收窗口'); return save() })
  ipcMain.handle('qa:send', async event => {
    if(layoutOnly)throw Error('布局验收不允许发送原生通知')
    if(!allowed(event))throw Error('非验收窗口'); if(sent)return save(); sent=true; save()
    await owner.savePreferences({ nativeEnabled: true, sound: false, preview: true }); win.hide()
    owner.offer({ key: 'native:isolated:one', category: 'automation', source: '隔离验收', title: '拾光静音通知验收 · 请点击此条',
      detail: '只是一条隔离测试消息，没有读取账号、连接 Cursor 或执行真实业务。', scope: {}, tone: 'info', attention: 'notice', state: 'resolved', occurredAt: Date.now(), sourceRevision: 1, announce: true })
    await owner.flush(); await delivery.flush(); return save()
  })
  if(layoutOnly) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'验收',submenu:[
      {label:'通知中心长文',click:()=>win.loadURL('http://127.0.0.1:5207/preview.html?notifications=long')},
      {label:'关联会话偏好',click:()=>win.loadURL('http://127.0.0.1:5207/preview.html?notifications=reply-body')},
      {label:'100% 缩放',accelerator:'CmdOrCtrl+1',click:()=>{win.webContents.setZoomFactor(1);save()}},
      {label:'200% 缩放',accelerator:'CmdOrCtrl+2',click:()=>{win.webContents.setZoomFactor(2);save()}},
      {label:'退出验收',accelerator:'CmdOrCtrl+Q',click:()=>app.quit()}
    ]}]))
    win.webContents.setZoomFactor(2)
    await win.loadURL('http://127.0.0.1:5207/preview.html?notifications=long')
  } else await win.loadFile(${JSON.stringify(join(resource, 'index.html'))}); save()
}).catch(error => { writeFileSync(result, JSON.stringify({ setupFailed: String(error), isolated: true })); app.quit() })
app.on('before-quit', event => { if(quitting)return; event.preventDefault(); quitting=true; delivery?.dispose(); Promise.resolve(owner?.close()).finally(() => { save(); app.quit() }) })
app.on('window-all-closed', () => app.quit())
`
const preload = `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qa',{state:()=>ipcRenderer.invoke('qa:state'),send:()=>ipcRenderer.invoke('qa:send'),watch:cb=>ipcRenderer.on('qa:state',(_e,state)=>cb(state))});`
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"><title>拾光 · 隔离静音通知验收</title><style>body{margin:32px;font:15px/1.65 -apple-system,BlinkMacSystemFont,sans-serif;color:#25282d;background:#fafafa}h2{margin:0 0 12px;font-size:21px}p{color:#62666d}button{padding:10px 16px;border:1px solid #bd784e;border-radius:8px;background:#c98053;color:white;font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:default}pre{white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace;background:#f0f1f2;padding:14px;border-radius:8px}</style><h2>隔离静音通知验收</h2><p>只发送一条测试通知，点击系统通知后回到本窗口。不会读取账号、启动 Cursor、修改系统权限或执行真实业务。</p><button id="send">发送一条静音测试通知</button><pre id="state">正在连接隔离通知 worker…</pre><script src="renderer.js"></script></html>`
const renderer = String.raw`const b=document.getElementById('send'),s=document.getElementById('state');function render(v){b.disabled=!!v.sent;s.textContent='原生请求：'+v.events.requests+'　显示回执：'+v.events.shown+'　原生点击：'+v.events.clicks+'\n验收窗口恢复：'+v.events.windowsOpened+'　通知仍未读：'+v.unread+'\n'+(v.delivery?.message||'显示回执不代表系统权限或自动已读。')}window.qa.watch(render);window.qa.state().then(render).catch(e=>s.textContent=String(e));b.addEventListener('click',()=>window.qa.send().then(render).catch(e=>s.textContent=String(e)));`
writeFileSync(join(source, 'main.ts'), main)
await build({ configFile: false, logLevel: 'warn', build: { target: 'node22', outDir: resource, emptyOutDir: false, minify: false,
  lib: { entry: join(source, 'main.ts'), formats: ['cjs'], fileName: () => 'main.cjs' }, rollupOptions: { external: ['electron', /^node:/] } } })
writeFileSync(join(resource, 'package.json'), JSON.stringify({ name: 'sg-notification-qa', version: '1.0.0', main: 'main.cjs' }))
writeFileSync(join(resource, 'preload.cjs'), preload); writeFileSync(join(resource, 'index.html'), html); writeFileSync(join(resource, 'renderer.js'), renderer)
const plist = join(app, 'Contents/Info.plist')
for (const [key, value] of [['CFBundleIdentifier', 'app.shiguang.team.notification-acceptance'], ['CFBundleName', 'SGNotificationQA'], ['CFBundleDisplayName', '拾光通知验收']])
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist])
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app])
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
const manifest = { preparedOnly: true, noNoticeSent: true, layoutOnly, app, profile, result: join(profile, 'result.json'), livePhysicalAttemptLimit: layoutOnly ? 0 : 1, isolated: true }
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(manifest, null, 2))
