# 自带网关：纯 CDP 定位 composerService 可行性档案（2026-09-12）

> 任务背景：图一 P1「自带网关，摘掉遗留补丁依赖」。拾光当前的会话创建、`getStatus`、
> `listComposers`、问卷提交、删会话全部依赖晴天时代补丁在 Cursor 主 bundle 尾部注入的
> `window.__qtComposerService` / `window.__qtComposerBridge`（5025 行 / 243KB）。该补丁是
> Cursor 运行 1h+ 卡顿主因之一（`_qtTrace` 对整对象图带 replacer 的 `JSON.stringify`，
> 每次 34–97ms 的 stringify 税），且清洁安装的 Windows Cursor 没有它 → 一键建会话直接
> `bridge_not_ready`。ARCHITECTURE 的 Windows readiness 条目记录了三条出路，其中之一是
> 「build the minimal CDP-injected bridge」。本档案验证这条路线（记为路线 B）的可行性。
>
> **结论：路线 B 可行（实测）。纯 CDP、零文件修改、零副作用即可拿到功能完备的
> `composerService` 句柄，且优于补丁——拿到的是 Cursor 对外正式暴露的服务门面。**

## 验证方法

本机运行中的 Cursor 3.6.31（`--remote-debugging-port=9333`），五版只读 CDP 探针：
`Runtime.enable` → `Runtime.evaluate('Map.prototype')` → `Runtime.queryObjects` →
`Runtime.callFunctionOn`（页面内筛选）→ `Runtime.releaseObjectGroup`。全程独立 objectGroup
并用后释放，不改页面状态（不干扰同时在跑的其他 Agent）。用补丁暴露的
`window.__qtComposerService` 作地面真值（oracle），验证「不靠补丁能否定位到等价句柄」。

探针脚本（复现用）：`/tmp/sg-route-b-probe{1..5}.mjs`（临时目录，非仓库产物）。核心复现命令：
`node /tmp/sg-route-b-probe5.mjs`（或按下文「落地核心表达式」重建）。

## 证据链（五步，均本机实测）

| # | 问题 | 实测结果 |
| --- | --- | --- |
| 1 | CDP 全链路能否用 | ✅ `queryObjects(Map.prototype)` 返回 ~7100 个 Map，页面内扫 4.7 万条目仅 9–12ms；`queryObjects` 本身 ~5s（遍历堆，一次性）。地面真值确认补丁服务/桥在主世界 |
| 2 | 服务实例在不在 Map value | ❌ 不在。按形状扫 Map value 会抓到假身（`sameAsPatch:false`）——「hook `Map.prototype.set` 嗅探」这条子路线不可靠 |
| 3 | 实例能否精确定位 | ✅ `queryObjects(构造函数.prototype)` 返回 `count:1, containsTarget:1`——全堆只有 1 个 `kL` 实例。构造函数 `kL`，`composerDataService` 为 own-data（cds 构造函数 `Fx`），实例带 40 个具名服务字段 |
| 4 | service identifier 是否明文 | ✅ 434 个 `InstantiationService` 容器、1056 个注册项，`key.toString()` 全明文（`composerDataService`、`modelConfigService`…）；`invokeFunction`/`createInstance` 也是明文方法名。名单里有明文 **`composerService`**——主聚合服务的注册名。`kL` 原型 60+ 明文方法（`getComposer`/`cancelCurrentStep`/`acceptAllDiffs`/`openWorktreePR`…） |
| 5 | 无补丁能否取回等价句柄 | ✅ 唯一注册 `composerService` 的容器上 `invokeFunction(a=>a.get(id))` → 取回实例 `getOk:true`、`createComposer` ✓、`composerDataService.getComposerDataIfLoaded` ✓ |

## 关键细节：`bound kL` 门面（比补丁更稳）

第 5 步取回的实例构造函数名是 **`bound kL`**，不是裸 `kL`，因此 `!== window.__qtComposerService`
（补丁在构造函数里存的是裸 `this`；`accessor.get` 返回的是 Cursor 对外正式暴露的 bound 门面）。

**这不影响可行性，反而更好**：拾光只需要一个功能完备的 `composerService` 句柄，不需要「等于补丁那个实例」。
bound 门面是官方对外接口，比补丁抓的裸 `this` 更稳定；字段访问
（`composerDataService` / `composerChatService` / `modelConfigService` / ToolFormer 链）
都穿透到同一底层单例。stream hook 需要的 `composerDataService.composerDataHandleManager` 同样可达。

## 无补丁定位链（落地形态）

```
CDP queryObjects(Map.prototype)
  → 找任一 InstantiationService（形状：invokeFunction + createInstance + _services._entries，均明文）
  → 在唯一注册 composerService 的容器上 invokeFunction(a => a.get(id))
  → 得功能完备的服务句柄（bound kL）
  → callFunctionOn 挂到页面全局 window.__sgComposerService
```

零文件修改、零校验和问题、免疫 Cursor 升级、无 243KB 死代码、无 stringify 税、无 500ms 死轮询
（补丁尾段向 `127.0.0.1:36530/api/pending-switch` 的轮询早已是死代码，被冷切/ZMO 热泵取代）。

### 落地核心表达式（callFunctionOn，this = queryObjects 返回的 Map 数组）

```js
function () {
  const asData = (o, n) => { const d = Object.getOwnPropertyDescriptor(o, n); return d && ('value' in d) ? d.value : undefined }
  for (const m of this) {
    let size = 0; try { size = m.size } catch { continue }
    if (typeof size !== 'number' || size > 20000) continue
    try {
      for (const [, v] of m) {
        if (!v || typeof v !== 'object') continue
        if (typeof v.invokeFunction !== 'function' || typeof v.createInstance !== 'function') continue
        const services = asData(v, '_services') ?? v._services
        const entries = services && (asData(services, '_entries') ?? services._entries)
        if (!entries || typeof entries[Symbol.iterator] !== 'function') continue
        for (const [key] of entries) {
          if (String(key) !== 'composerService') continue
          const inst = v.invokeFunction((a) => a.get(key)) // 已实例化，取现有实例，零副作用
          if (inst && typeof inst.createComposer === 'function') {
            globalThis.__sgComposerService = inst
            return true
          }
        }
      }
    } catch {}
  }
  return false
}
```

捕获成功后，所有现有 `window.__qtComposerService` 读点改读 `window.__sgComposerService` 即等价。

## 拾光对补丁的依赖面（切换清单，共 4 文件 20 处）

| 文件 | 用途 | 换桥后 |
| --- | --- | --- |
| `src/infrastructure/cursor/cursor-cdp-session-creator.ts`（11 处） | 建会话（`createComposer`+`submitByComposerId`）、`getStatus`/`listComposers`、`ready` 探针 | 基于 `__sgComposerService` 重写约 40 行薄封装（已有 `buildRuntimeInspectionExpression` 范式） |
| `src/infrastructure/cursor/cursor-stream-observer.ts`（4 处） | hook v31 包装 `composerDataHandleManager` 写方法 + `getComposerDataIfLoaded` | 只需换服务引用，逻辑零改动 |
| `src/infrastructure/cursor/cursor-question-responder.ts`（4 处） | ToolFormer 定位链 + `submitByComposerId` | 只需换服务引用 + 提交一行 |
| `src/application/session-warmup-service.ts`（1 处） | `deleteComposer` | 只需换服务引用 |

## 成本与范围注意

- **捕获成本**：`queryObjects` 每次 ~5s（遍历堆），但每文档一次性；捕获后挂全局，后续零成本。
  优化：先探 `window.__sgComposerService` 是否还在，不在才重跑。
- **文档重载重捕获**：Reload Window / 同窗口切文件夹 / 切号重启后是新文档新实例，需重新定位——
  复用 stream hook 现有的 `executionContextCreated` 重装机制触发即可。
- **范围**：本次只验了 `composerService`（建会话/getStatus/listComposers/问卷/删会话全靠它）。
  补丁的 `__mcAuthService`（热切号）**不在本次网关 P1 范围**；其 `pollSwitch` 尾段已是死代码。
  auth 服务同样可用 identifier 明文名定位，需时再验。
- **校验和**：路线 B 零文件修改，不触发 Cursor 的 checksum 告警（补丁靠改 `_showNotification` 静默，路线 B 不需要）。

## 下一步（待批准后进入实现）

1. 把定位逻辑封成 `src/infrastructure/cursor/cursor-composer-service-locator.ts`
   （queryObjects + get `composerService` + 挂全局 + reload 重捕获），配套 CDP VM 测试。
2. 4 文件 20 处 `__qtComposerService` → `__sgComposerService` 切换。
3. `__qtComposerBridge` 薄封装用自有 CDP 表达式重写。
4. 全绿后：`legacy-patch` 存储清理项从「仅盘点」转正为可清理；Windows 一键建会话解锁。

本档案为只读调查产出，业务源码在调查期间零变更。

---

## 落地记录（2026-09-12，网关实现完成）

上述第 1–3 步已实现并验证（第 4 步「清理项转正」留待网关在生产运行一段时间后再动）：

- **`cursor-composer-service-locator.ts`**（新模块）：
  - `COMPOSER_SERVICE_LOCATE_FUNCTION`——探针 v5 同款定位算法（形状嗅探容器 → 明文
    `composerService` identifier → `invokeFunction(a=>a.get(id))` → 能力校验 → 挂
    `window.__sgComposerService`）；
  - `locateComposerServiceViaCall(call)`——幂等定位序列（present 短路 → `queryObjects`
    30s 上限 → `callFunctionOn` → `releaseObjectGroup`），供观察器持久 socket 复用；
  - `ensureComposerServiceLocated(wsUrl)`——一次性多命令 socket 版，供会话创建冷启动兜底；
  - `SG_COMPOSER_BRIDGE_PRELUDE`——自有薄桥（`ready`/`listComposers`/`createAgent`/
    `submitByComposerId`/`getStatus`/`getComposerData`/`getRecentlyCreatedComposers`），
    与补丁桥同名同契约、纯数据源派生（无 `_qtTrace`、无 DOM 查询、无轮询死重）。
- **定位时序**：观察器 `installHook()` 首步定位（attach 与文档重载重装链路都覆盖），
  失败走 3s×40 低频重试（与页面 hook 自轮询 2s×60 同窗口会师）；`createAgentSession`
  在 resolveTarget 后独立幂等 ensure 一次，覆盖「创建早于观察器 attach」的冷启动竞态。
- **切换范围**（较原清单多一处发现）：4 文件全部切换，另发现 `WINDOW_PROBE_EXPRESSION`
  里的 `__qtBatchWorkspaceScopeId` 也是补丁全局——已换成原生 `vscode.context.configuration()`
  工作区文件夹读数，scope 哈希改在 Node 侧计算（`CursorCdpWindowInfo.workspaceFolder`），
  多窗口 scope 匹配语义保持。hook 版本 v32 → v33（全局名切换；版本守卫自动替换旧 wrapper）。
- **有意的行为差异**：inspect 的 `getStatus` 纯数据派生，不再有补丁的 DOM 兜底——
  「数据水合空壳期从 DOM 捞实时正文」随补丁退役（该窗口期正文由 observer 写后帧承担，
  状态判定不受影响，测试已按新语义钉住）。
- **验证**（全部通过）：`tsc --noEmit`；vitest 166 文件 / 1632 用例（含新增 locator
  单测 17 例：定位算法 VM 直跑、CDP 序列、一次性 socket、PRELUDE 派生契约）；
  `npm run build`；`smoke:channel`；**本机运行中 Cursor 实弹冒烟**——生产 ensure 链路
  7.0s 完成挂载，等价性五项全绿（`sg.composerDataService === qt.composerDataService`
  同一实例、manager/chatService/modelConfigService/deleteComposer 全可达、ctor
  `bound kL`），原生工作区探针读到真实 folder，PRELUDE 桥在 51 个真实 composer 上
  派生正确（listComposers 状态口径、getStatus found/气泡计数/lastHumanText）。
- **不在本次范围**：`scripts/patch-cursor-usage-hook.ts`（拾光自有的 turnEnded 用量
  微补丁，`__SG_TEAM_USAGE_PATCH__` 标记）与热切号 `__mcAuthService`——两者独立于
  晴天补丁的 composer 依赖面；存储盘点的 `LEGACY_PATCH_MARKERS`（`__QINGTIAN_*`）
  检测逻辑不受影响。
- **补丁摘除条件已成立**：拾光侧对 `__qtComposerService`/`__qtComposerBridge` 的代码
  引用清零。摘除动作本身（真删 bundle 尾段）建议等新网关在日常运行中验证若干天后，
  配合存储清理项转正一起做。

---

## 运行时缴械（2026-09-12，随网关一起落地）

补丁自己留了停机口子：`window.__qingtianSeamlessRuntime.stop(reason)`（插件重装时停旧运行时用，
清掉全部 `_qtSetInterval/_qtSetTimeout` 登记的定时器）；桥的 10 个 trace 包装函数都保留
`__qtOriginal`。`cursor-legacy-patch-disarm.ts` 在观察器定位到 `__sgComposerService` 之后执行
一段幂等表达式：stop → 桥方法换回原函数（保留 `bridge.__qtTraceWrapped=true` 让残存 installer
短路）→ `__QT_TRACE_CURSOR_INTERNALS=false` → 打 `__sgLegacyPatchDisarmed` 标记；文档重载后随
hook 重装再走一遍。零文件修改，被动全局保留。测试：表达式 VM 直跑（停一次 / 原函数复位 / 幂等 /
清洁页纯只读 / stop 抛错容忍）+ 观察器时序（定位失败不缴械、补试成功即缴械、重载再缴械、缴械抛错
不阻断 hook）。生效时机：桌面端重启后观察器 attach。

## 真摘补丁可行性核对（2026-09-12，只读，未写盘）

对 `workbench.desktop.main.js` 及其同目录 4 份备份做了逐字节重同步差异（脚本留在
`/tmp/sg-probe/unpatch-survey2.mjs`，只读）：

| 文件 | 大小 | mtime | debugId | 内容 |
|---|---|---|---|---|
| `workbench.desktop.main.js`（现行） | 61,617,154 | 09-10 | `d345fa05-…-1c7b570e4161` | 晴天 4 段 + 拾光 4 段 |
| `.qingtian.backup` | 61,370,162 | 08-16 | 同 | **零标记，原始 bundle** |
| `.before-usage-limit-hotfix` / `.sg-usage-backup` | 61,616,418 | 08-20 / 09-01 | 同 | 晴天 4 段 + 旧版热切泵 |
| `.sg-runtime-switch-backup` | 61,617,112 | 08-30 | 同 | 晴天 4 段 + 旧版热切泵 + 旧用量补丁 |

结论：

1. **同一构建**：五个文件 `debugId` 完全一致，`.qingtian.backup` 就是当前 Cursor 3.6.31 这份
   bundle 的原始版本，可直接作为「摘干净」的对照基线。
2. **`clean → current` 是纯插入**：8 段插入、0 删除、0 修改，共 244,096 字符——
   - 晴天 4 段：ComposerService 构造函数内联 `window.__qtComposerService=this,`（75 字符，
     @36.13MB）与 `createComposer` 内联兜底（106 字符，@36.20MB）、`_showNotification` 的校验和
     提示静默 `/* __QINGTIAN_SEAMLESS__ */return;`（34 字符，@57.66MB）、`//# debugId` 行之后的
     整个尾段运行时（240,608 字符，@58.53MB 至文件末尾）；
   - 拾光 4 段：turnEnded 用量钩子 ×2（341 + 353，@25.36 / 28.35MB，`__SG_TEAM_USAGE_PATCH__`）、
     profile 刷新 `/*SG_PROFILE_REFRESH_V1*/e.displayEmail();`（42，@35.78MB）、热切泵
     `/*ZMO_SWITCH_V1_START*/…END*/`（2,537，@41.22MB，含 base64 配置）。
3. **摘除预演通过**：内存中删掉晴天 4 段后，与 `.qingtian.backup` 的残差恰好只剩拾光 4 段——
   即「真摘」= 按 4 个精确标记删 4 段，其余字节与原始 bundle 一致，无需整体回滚备份、也不用重打
   拾光自有补丁。
4. **9/10 usage-limit-hotfix 改了什么**：相对 08-20 / 09-01 备份，加了用量钩子 2 段 + profile
   刷新 1 段，并把热切泵 base64 配置改了 4 个字符（端口 / 密钥更新）；与晴天补丁无关。
5. **摘除后的配套动作**（现成工具都有）：同步 `product.json` 校验和（`_isPure` 随之为真，晴天的
   `return;` 静默也就不再需要）、macOS 临时重签、写前语法校验、写前备份；然后重启 Cursor。
6. **顺序约束**：运行中的拾光桌面端（15:33 包，hook v30）仍经 `__qtComposerService` /
   `__qtComposerBridge` 取数，**必须先部署 v33 自带网关的桌面端，再摘补丁**；反过来会让旧包的
   建会话 / inspect 全部失效。

## 真摘执行记录（2026-09-12 21:04，已落盘）

- 实现：`cursor-legacy-patch-remover.ts`（锚点精确纯函数摘除 + 落盘器，复用切号泵安装器的
  语法自检 / 原子写 / product.json 校验和 / macOS 重签）+ `scripts/unpatch-cursor.ts`
  （`--dry-run` 只读预演 / 无参执行）。内联三段按唯一全文锚点删除（多处命中整体拒绝、缺位
  幂等跳过）；尾段要求 debugId 行后内容以既知晴天头部开头才截断，未知内容一律拒绝。
- 执行结果：dry-run 与落盘均删除 4 段共 240,823 字符（75 / 106 / 34 / 240,608——与上表
  可行性核对逐一吻合）。落盘后审计：与 `.qingtian.backup` 的重同步残差恰好 = 拾光 4 段
  （341 / 353 / 42 / 2,537），晴天标记（`__QINGTIAN_*` / `__qtComposerService` /
  `__qtComposerBridge`）全部归零，拾光标记计数不变；`product.json` 校验和已同步
  （`_isPure` 恢复为真，被删的 `_showNotification` 静默不再需要）；ad-hoc 重签后
  `codesign --verify --deep` 通过。
- 回滚锚点：`workbench.desktop.main.js.sg-unpatch-backup`（摘除前完整字节，含补丁）。
  恢复即 `cp` 回去再跑一次校验和同步（或直接重装 Cursor）。
- 生效与部署时序：磁盘已干净，运行中的 Cursor 在重启前仍跑内存里的旧 bundle（补丁仍在其中，
  运行时缴械待新桌面端部署后生效）。**Cursor 重启前必须先部署 v33 自带网关的桌面端**——
  15:33 旧包在补丁消失后将失去建会话 / inspect（长会话 MCP 不受影响）；若意外重启，恢复
  备份即可回到摘除前状态。
