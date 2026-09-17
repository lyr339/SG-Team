# 拾光卡密授权系统 · 任务书

- 版本：v1.0（2026-09-18 · CH-6 起草）
- 状态：**决策已按建议锁定，待操作员最终确认后进入 P1**
- 读者：接手实施的任何 Agent 席位与操作员本人
- 交付原则：本文档自包含——不依赖起草会话的聊天上下文即可开工

## 0. 接手指引（新 Agent 从这里开始）

1. 通读本文档；有歧义先查「决策记录」和「术语表」，仍有歧义在通道里问操作员，不要自行猜测。
2. 开工前先读这些代码位置（本文档多处引用）：
   - `src/main/index.ts` —— 全部 `register*Ipc(...)` 注册点（门禁收口位置）
   - `src/mcp/index.ts`、`src/mcp/unified-channel-server.ts`、`src/mcp/team-tools.ts`、`src/mcp/channel-communication-tools.ts` —— MCP 进程与九个工具
   - `src/infrastructure/fs/store-file.ts` —— 耐断电存储工具（license 文件必须用它）
   - `src/application/aozai-card-vault.ts` —— 现有「奥仔卡密」（**与本系统无关**，命名要区分）
   - `src/infrastructure/cursor/cursor-machine-identity.ts` —— 换号用假机器码（**禁止**用作授权指纹）
   - `docs/TASK-MCP.md`、`docs/ARCHITECTURE.md` —— 系统背景
3. 里程碑按 P1→P2→P3 顺序做，每阶段 DoD 全绿再进下一阶段；每阶段结束提交一次。
4. 服务端私钥、Workers 账号等敏感物由操作员掌握，Agent 只写代码与部署脚本，不在仓库存任何私钥。

## 1. 背景与目标

拾光（SG Team）将对外分发/售卖。需要卡密授权系统：**无卡密用户只能使用 MCP 对话功能（免费层），其余能力需激活卡密解锁**。卡密经发卡平台自动发货；激活后绑定设备、按卡种计时。

**目标**

1. 可批量生成、可售卖、可撤销的卡密体系；
2. 免费/付费双层能力门禁，主进程与 MCP 进程双侧生效；
3. 断网可用（仅激活需联网），防随手传播。

**非目标（明确不做）**

- 加壳/混淆等侵入式反破解（伤合法用户体验，收益低）；
- 账号体系（不做注册登录，卡密即凭证）；
- 应用内支付（售卖走发卡平台）；
- 一期不做通道数分级 SKU（令牌预留 `plan` 字段即可）。

**安全边界的共识**：Electron 的 asar 可解包，本地任何检查可被 patch。防线是「破解成本 > 卡价 + 可撤销 + 随版本更新失效」，防的是随手传播，不是决心破解者。不要在客户端反破解上加码。

## 2. 决策记录（P1 开工前可被操作员推翻，推翻后更新本表）

| # | 决策项 | 结论 |
|---|---|---|
| D1 | 免费层通道数 | 2 个；用量统计、Cursor 存储清理放免费层（日常价值钩子），workspace-review 归付费 |
| D2 | 试用 | 7 天全功能试用，设备指纹限领 1 次，无需卡密 |
| D3 | 设备绑定 | 1 卡 1 设备；每 30 天可换绑 1 次，换绑即旧设备失效 |
| D4 | 卡种 | 月 / 季 / 年 / 永久（时长维度）；令牌预留 `plan` 字段 |
| D5 | 服务端 | Cloudflare Workers + D1（免运维；免费额度覆盖初期） |
| D6 | 老用户 | 发布前登记内测设备，每人赠一张内测季卡 |
| D7 | 命名 | UI 叫「激活码」；代码模块叫 `license`；设置页独立分区「授权与激活」，与「奥仔卡密」物理分开 |

## 3. 免费 / 付费能力矩阵（最终版）

依据 `src/main/index.ts` 现有 IPC 注册点与 MCP 工具面归类。**矩阵的唯一实现位置是 EntitlementGate 的能力表**，改归属只动一处。

### 免费层（无激活码即可用）

| 能力 | 对应代码面 | 说明 |
|---|---|---|
| MCP 安装与注册 | `registerMcpInstallerIpc`、`global-mcp-registrar` | 免费层的入口体验 |
| 通道对话全功能 | `registerSessionIpc`、channel relay、MCP `check_messages` / `record_reply` | **通信工具无条件放行**，这是免费承诺的兑现点 |
| 通道数量 | 通道/席位创建路径（team-control 服务） | **上限 2 个**；限额在创建处收口 |
| 用量统计 | `registerCursorUsageIpc` | 免费钩子（D1） |
| Cursor 存储清理 | `registerCursorStorageIpc` | 免费钩子（D1） |
| 应用自更新 | `registerAppUpdateIpc` | **永久免费**：安全修复必须触达所有用户 |
| 基础设置 / 窗口 / 托盘 | `registerWindowChromeIpc` 等 | 基础设施 |

### 付费层（激活解锁）

| 能力 | 对应代码面 |
|---|---|
| 团队编排全家（团队 run、任务池、验收、团队记忆、连续性/交接、协作组） | `registerTeamControlIpc`、`registerTaskPoolIpc`、`registerTeamCollaborationIpc`、`registerTeamContinuityIpc`、`registerTeamGroupIpc`、`registerSessionHandoffIpc`、MCP `team_*` 七工具 |
| 一键批量拉起 | `registerAgentLaunchIpc` |
| 通道数上限解除 | 通道创建路径 |
| 账号金库 / 换号 / 机器码 | `registerCursorAccountIpc`、`cursor-account-switcher` |
| 账号自动化 + 指纹窗口 | `registerAccountAutomationIpc` |
| session-warmup / cdp-keeper | `registerSessionWarmupIpc`、`registerCdpKeeperIpc` |
| workspace-review | `registerWorkspaceReviewIpc` |

### 降级规则

到期/撤销**只锁能力、不锁数据**：已有团队数据只读可见，通道对话不受影响。禁止任何"付费数据被劫持"式的设计。

## 4. 系统架构

```
┌─发卡平台(第三方)─┐      ┌──── 授权服务端 (CF Workers + D1) ────┐
│ 上架/自动发货卡密 │      │ /activate /heartbeat /transfer /trial │
└────────┬────────┘      │ 卡表·激活表·撤销表 · Ed25519 私钥     │
         │买家拿码        └──────────────┬──────────────────────┘
         ▼                              │签名令牌/撤销指令
┌──────── 拾光客户端 (Electron 主进程) ──┴─────────┐
│ LicenseService: 激活·验签·心跳·宽限·状态广播      │
│ license.json (writeStoreFileSync, 防篡改=验签)    │
│ EntitlementGate: allows(capability) 单一真源      │
│  └─ 在 21 个 register*Ipc 边界拦截 + 通道限额     │
│ 授权快照 → SQLite license_snapshot 表 ────────┐   │
└──────────────────────────────────────────────┼───┘
                                               ▼
                     ┌──── MCP 进程 (out/mcp/index.mjs) ────┐
                     │ team_* 调用前验签读快照；无效→提示激活 │
                     │ check_messages/record_reply 永不拦截  │
                     └──────────────────────────────────────┘
```

信任模型：私钥只在服务端；客户端与 MCP 内嵌**公钥集**（带 `kid` 支持轮换）；令牌与快照全部可离线验签；网络仅在激活/心跳时使用。

## 5. 需求分解（R1–R14，每条附验收标准）

### 5.1 授权服务端（Cloudflare Workers + D1）

- **R1 批量生成（CLI）**：生成 N 张卡（参数：卡种、批次号、备注），格式 `SG-XXXXX-XXXXX-XXXXX-XXXXX`（Crockford Base32，无 0/O/1/I，末组含校验位），入库状态 `unused`，导出 CSV 供发卡网上架。验收：生成 100 张，格式校验函数拒绝改动任一字符的假码。
- **R2 激活 `POST /activate`**：入参 `{ card, deviceHash, deviceName, appVersion }`。校验存在/未用/未封 → 写激活记录（绑定 deviceHash、activatedAt、按卡种算 expiresAt；永久卡 expiresAt=null）→ 返回签名令牌。验收：同卡二次激活被拒（`card_used`）；封禁卡被拒（`card_banned`）。
- **R3 心跳 `POST /heartbeat`**：入参 `{ licenseId, deviceHash, appVersion }`。有效 → 返回续签令牌（新 issuedAt）；已封禁/已换绑 → `{ revoked: true, reason }`。验收：封禁后下一次心跳收到撤销。
- **R4 换绑 `POST /transfer`**：入参 `{ card, oldDeviceHash?, newDeviceHash, deviceName }`。校验 30 天窗口与次数 → 更新绑定、旧令牌 licenseId 进撤销表 → 返回新令牌。验收：窗口内二次换绑被拒（`transfer_limited`）。
- **R5 试用 `POST /trial`**：入参 `{ deviceHash, deviceName, appVersion }`。该指纹首次请求 → 发 7 天试用令牌（`cardType: 'trial'`）；重复请求 → `trial_used`。
- **R6 管理**：P1 阶段用 CLI + SQL 完成：封禁（`ban <card>`，退款用）、查询（卡状态/激活记录/心跳时间）、批次作废。后台界面属 P4。
- **R7 密钥管理**：Ed25519 私钥仅存 Workers Secret；令牌头带 `kid`；客户端公钥集数组化，轮换=发新版加新公钥。仓库内**只允许出现公钥**。

### 5.2 客户端（Electron 主进程）

- **R8 `LicenseService`**（建议 `src/application/license-service.ts`）：激活/试用请求、令牌验签解析、心跳调度（24h 周期 + 指数退避）、宽限计时（心跳连续失败 **7 天宽限**后降级）、状态变更广播（渲染层订阅）。验收：断网 7 天内全功能，第 8 天降免费层；恢复联网自动回升。
- **R9 持久化**：`userData/license.json` 一律经 `writeStoreFileSync` 写入（见 `src/infrastructure/fs/store-file.ts`），读取经 `readStoreJsonSync`（坏文件留档）。令牌本体签名防篡改：**篡改 = 验签失败 = 回免费层**，不误伤其他数据。验收：手改 license.json 任一字节 → 重启后免费层 + 状态页提示令牌无效。
- **R10 设备指纹**（建议 `src/infrastructure/license/device-fingerprint.ts`）：Windows 用注册表 `MachineGuid` 等稳定源加盐哈希；macOS 留 `IOPlatformUUID` 实现位。**禁止**复用 `cursor-machine-identity.ts`（那是换号伪装、会主动变化）。指纹仅以哈希出境。验收：重启/重装应用指纹不变；两台机器指纹不同。
- **R11 `EntitlementGate`**（建议 `src/application/entitlement-gate.ts`）：能力枚举建议 `teamOrchestration | agentLaunch | accountVault | accountAutomation | sessionWarmup | cdpKeeper | workspaceReview | unlimitedChannels`。在各 `register*Ipc` 的处理函数边界调用 `gate.allows(...)`，拒绝返回统一错误 `{ code: 'LICENSE_REQUIRED', capability }`；通道创建路径实施免费层 2 通道限额（错误码 `CHANNEL_LIMIT`）。验收：无卡密时矩阵付费行逐项被拦，免费行逐项可用。
- **R12 激活 UI**：设置页新增「授权与激活」分区（参考 `src/renderer/src/settings/SettingsPage.tsx` 现有分区写法）：输码激活、试用入口、状态展示（卡种/到期/设备名/宽限倒计时）、换绑引导、到期提醒；付费功能位置显示锁标 + 引导文案。与「奥仔卡密」分区保持距离，文案不得混用。
- **R13 时钟防回拨**：license.json 持久化单调 `lastSeenAt`（取 max(now, 上次值)）；检测系统时钟大幅回拨（>48h）→ 强制一次在线校验，校验不过按宽限计时处理。

### 5.3 MCP 进程

- **R14 授权快照**：主进程在授权状态变化与心跳续签后，把当前令牌（或降级标记）写入 SQLite `license_snapshot` 表（单行，含签名原文）。MCP 进程（`src/mcp/team-tools.ts` 注册的七个 `team_*` 工具）在调用入口验签读取：无效/过期/降级 → 返回 `{ ok: false, code: 'license_required', message: '需要激活…' }`；`check_messages` / `record_reply`（`src/mcp/channel-communication-tools.ts`）**永不拦截**。验收：无授权时 `team_check_in` 返回 `license_required`，通信工具正常收发。

## 6. 数据模型草案

### 6.1 服务端 D1

```sql
CREATE TABLE cards (
  card TEXT PRIMARY KEY,          -- SG-XXXXX-… 全大写
  card_type TEXT NOT NULL,        -- month|quarter|year|forever|trial(内部)
  batch TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'unused',  -- unused|active|banned|void
  created_at INTEGER NOT NULL
);
CREATE TABLE activations (
  license_id TEXT PRIMARY KEY,    -- uuid
  card TEXT NOT NULL REFERENCES cards(card),
  device_hash TEXT NOT NULL,
  device_name TEXT,
  activated_at INTEGER NOT NULL,
  expires_at INTEGER,             -- 永久卡为 NULL
  transfer_count INTEGER NOT NULL DEFAULT 0,
  last_transfer_at INTEGER,
  last_heartbeat_at INTEGER
);
CREATE TABLE revocations (
  license_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,           -- banned|transferred
  revoked_at INTEGER NOT NULL
);
CREATE TABLE trials (
  device_hash TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL
);
```

### 6.2 客户端 `userData/license.json`

```jsonc
{
  "version": 1,
  "token": "<base64(payload).base64(signature)>",  // 服务端签发原文，验签用
  "payload": {                                      // 冗余解析结果，展示用
    "licenseId": "…", "plan": "standard", "cardType": "quarter",
    "activatedAt": 0, "expiresAt": 0, "deviceId": "…", "graceDays": 7, "kid": "k1"
  },
  "lastHeartbeatAt": 0,
  "heartbeatFailingSince": null,
  "lastSeenAt": 0                                   // 单调时钟，防回拨
}
```

### 6.3 SQLite `license_snapshot`（拾光库，主进程写 / MCP 读）

| 列 | 说明 |
|---|---|
| id | 恒为 1（单行表） |
| token | 签名令牌原文；降级时为空 |
| state | `licensed | trial | grace | free` |
| updated_at | 写入时间 |

## 7. API 契约草案（错误码统一小写蛇形）

| 端点 | 成功响应 | 错误码 |
|---|---|---|
| `POST /activate` | `{ ok, token, payload }` | `card_not_found` / `card_used` / `card_banned` / `card_void` / `invalid_arguments` |
| `POST /heartbeat` | `{ ok, token }`（续签）或 `{ ok, revoked: true, reason }` | `license_not_found` / `device_mismatch` |
| `POST /transfer` | `{ ok, token, payload }` | `transfer_limited` / `card_not_found` / `card_banned` |
| `POST /trial` | `{ ok, token, payload }` | `trial_used` |

客户端侧统一错误码：`LICENSE_REQUIRED`（能力被拦）、`CHANNEL_LIMIT`（免费层通道限额）；MCP 侧 `license_required`。

## 8. 关键流程

- **激活**：输码 → `/activate` → 验签存盘 → 广播状态 → 全功能即时解锁。仅此步与试用/换绑需联网。
- **日常启动**：读 license.json → 验签 + 有效期/宽限判断 → 设置 Gate；**零网络依赖**。后台按周期心跳。
- **心跳失败**：记 `heartbeatFailingSince`，7 天内不降级；期间 UI 显示宽限提示；恢复成功即清零。
- **到期/撤销**：降免费层（见 §3 降级规则），UI 引导续费/重新激活。
- **换绑**：新设备激活时收到 `card_used` → UI 引导走 `/transfer`（限次）；旧设备下次心跳收撤销。
- **退款**：操作员 CLI `ban <card>` → 心跳撤销生效。
- **试用**：首启动弹提示 → `/trial` → 7 天全功能 → 到期降免费层并引导购买。

## 9. 里程碑与 DoD

| 阶段 | 内容 | 完成标准（DoD） |
|---|---|---|
| P1（1–2 天） | Workers + D1 五端点、发卡 CLI、密钥生成 | 100 张测试卡入库；curl 全流程通过：激活→心跳续签→封禁→心跳撤销→二次激活被拒；`wrangler deploy` 脚本入仓 |
| P2（2–3 天） | LicenseService + Gate + 指纹 + license.json + 激活 UI | 无卡密启动=免费层（矩阵逐行验证）；激活即时解锁；篡改 license.json 回免费层；单测覆盖 Gate 每个能力位 |
| P3（1–2 天） | MCP 门禁 + 通道限额 + 心跳宽限 + 防回拨 | 无授权 `team_*` 拒绝、通信工具放行；第 3 通道被拦；模拟断网 7 天不降级、第 8 天降级；全量 vitest 通过 |
| P4（后置） | 发卡网对接说明、管理后台、内测赠卡批次 | 操作员按文档完成一次真实上架与发货 |
| 总验收 | 三个真实场景 | 试用→购卡激活；退款→封禁生效；换机→换绑成功 |

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 破解版传播 | 验签低成本随处可查 + 心跳撤销 + 版本更新重验；接受剩余风险（经济性防御，见 §1 共识） |
| Workers 不可达/被墙 | 客户端多 endpoint 备选 + 7 天宽限吸收；域名可换 |
| 私钥泄露 | `kid` 轮换：发新版内嵌新公钥，服务端换私钥，旧令牌心跳时换发 |
| 试用被重装薅 | 指纹限一次；不对抗虚拟机（接受少量流失） |
| 免费层划线争议 | 矩阵唯一实现在 Gate 能力表，一行改归属 |
| 心跳被防火墙静默吞 | 超时按失败计入宽限；UI 显示上次心跳时间 |

## 11. 术语表

| 术语 | 含义 | 不要混淆 |
|---|---|---|
| 激活码（授权卡密） | 本系统售卖的应用授权凭证，UI 用词「激活码」 | —— |
| 奥仔卡密 | `AozaiCardVault` 存的**上游服务**充值凭证，与本系统无关 | 设置页分区、文案、代码模块都必须分开 |
| 授权令牌 | 服务端 Ed25519 签发的可离线验签凭证 | 不是卡密本体；卡密激活后换取令牌 |
| 授权快照 | 主进程写进 SQLite 供 MCP 验签的令牌副本 | 单行表 `license_snapshot` |

## 12. 变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-09-18 | v1.0 | 初稿：决策 D1–D7 锁定，R1–R14 需求分解，P1–P4 里程碑 | CH-6 |
