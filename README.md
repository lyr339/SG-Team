# 拾光

Independent Electron control plane for Cursor multi-Agent teamwork (macOS + Windows).
通道消息与活性经拾光内嵌 MCP（SG Team 单条目）+ SQLite 队列直达 Cursor；
本应用拥有会话投影、持久任务调度、带回执的 Agent 间协作、会话池内随建随拆的协作组、
席位重建与上下文交接，以及进程绑定的 Agent MCP 接入。

```bash
npm install             # package.json 的 allowScripts 已放行 electron / esbuild 的安装脚本（npm 11）
npm run dev
```

Verification:

```bash
npm run typecheck       # 含 tests/**/*.tsx
npm test
npm run build
npm run smoke:mcp       # 团队角色 stdio 冒烟（构建产物）
npm run smoke:channel   # 通道角色 stdio 冒烟（构建产物）
npm run verify:mac      # 或 verify:win：打包产物 + 真实多进程冒烟
```

Packaged output: `release/mac-arm64/拾光.app` (directory target, unsigned) and
`release/ShiGuang-Setup-<version>.exe` (NSIS installer; `pack:win:dir` gives the
bare `release/win-unpacked/ShiGuang.exe`). Both `pack:*` scripts reuse the Electron in
`node_modules/electron/dist`, so no Electron download is needed at pack time —
provided electron's postinstall actually ran; npm ≥ 12 skips dependency install
scripts by default, so the CI packaging jobs run `node node_modules/electron/install.js`
after `npm ci` (idempotent; do the same locally if `electronDist does not exist`).

Handing a build to someone else:

- `npm run dist:mac` → `release/ShiGuang-<version>-mac-arm64.zip`: re-signs the app
  ad hoc (an unsigned Electron bundle that arrives with a quarantine flag is shown as
  "damaged" by Gatekeeper) and zips it with `ditto` so the framework symlinks survive.
  The recipient drags `拾光.app` into Applications and runs once
  `xattr -dr com.apple.quarantine /Applications/拾光.app`.
- Pushing a tag `v<version>` (must equal `package.json` `version`) runs
  `.github/workflows/release.yml`: mac zip + Windows installer → GitHub Release with
  `.github/release-notes.md` as the body. The repository is public, so recipients only
  need the link. `pack:mac` / `dist:mac` rewrite `release/mac-arm64/拾光.app` in place —
  quit 拾光 first if `~/.cursor/mcp.json` points at that build (its MCP server runs from it).
On Windows, electron-builder shells out to `powershell.exe`; make sure
`C:\Windows\System32\WindowsPowerShell\v1.0` is on `PATH` in the shell you run
it from.

Windows checklist (the items that have produced "many errors" before):

- Node **24+** for every `npm` script: the MCP bundle and the smoke scripts use
  `node:sqlite`, so an older Node fails with `ERR_UNKNOWN_BUILTIN_MODULE`.
- Behind a slow GitHub connection set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
  for `npm ci` and `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
  for the NSIS target; `pack:win` itself only needs the local Electron dist.
- Cursor must be the pinned **3.6.31** build installed **per user**
  (`%LOCALAPPDATA%\Programs\Cursor`). The hot account switch patches
  `resources\app\out\vs\workbench\workbench.desktop.main.js`; an all-users install
  under `Program Files` needs an elevated 拾光, and Cursor must be fully closed
  while the patch is written (Windows refuses to replace an open file).
- The hot-switch pump polls loopback port **51824**. Hyper-V / WSL2 / Docker
  reserve dynamic port ranges; check `netsh int ipv4 show excludedportrange protocol=tcp`
  before installing the patch, because the port is baked into the bundle.
- Process probes go through PowerShell with UTF-8 output; Chinese user names and
  install paths are supported, but `Cursor.exe` must not be renamed.

Design walkthrough (pure-browser preview with a mocked desktop API, plus a
headless screenshot matrix over the right-hand inspector and the 运行 page:
panels / run states × light/dark × narrow × transparent × reduced-motion ×
interactions):

```bash
npm run preview:ui      # http://127.0.0.1:5174/preview.html
npm run preview:shots   # writes preview-screenshots/*.png (needs Chrome or Edge)
node scripts/preview-shots.mjs --only run-team-active-light,run-independent-mixed-dark
```

If Vite binds to `localhost` only, point the shot script at it with
`PREVIEW_BASE=http://localhost:5174`.

App icons are generated, not drawn by hand: `build/*.svg` come from the design source
in `docs/design/sg-monogram/` (`node docs/design/sg-monogram/generate.cjs`), and
`npm run icons` rasterizes them into `build/icon-shiguang-1024.png`, `.icns` (macOS only),
`.ico`, the menu-bar `trayTemplate*.png` and the in-app `brand-shiguang.png` (needs
Chrome or Edge, same lookup as the shot script).

Architecture and protocol decisions live in `docs/`: `ARCHITECTURE.md` states the rules that hold now,
`ARCHITECTURE-LOG.md` is the dated, append-only record of how they got there, `TASK-MCP.md` is the
Agent tool contract; task books for work in flight are indexed in `.handoff/README.md`.
