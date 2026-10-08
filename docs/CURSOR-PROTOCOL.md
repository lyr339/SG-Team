# 协议诊断（只读）

设置 → 协议，或 `#account:protocol`。

独立于 MCP、批量会话、自动化和估算用量账本。此版不启动自动抓取、不注入或修改 Cursor、不自动发送模型请求；采集器仍是独立研究工具。

## 入口与数据

- 导入采集记录：`shiguang.cursor-protocol.v1` JSON，最多 1 MB、200 条记录、300 模型族。严格白名单结构，拒绝额外凭据字段、重复标识、错误的账本关联或不完整成功流。取消不提示成功；重复导入不重复记录；来源冲突不覆盖旧记录。
- 会话记录：标注导入来源，显示 request model/参数、结束错误、帧顺序和 token 口径，不保留提示词、答案、认证头或机器标识。
- 模型参数：目录声明不是使用授权；只有导入成功样本的族显示“有成功采集”。参数只读，不参与运行配置。
- 核对 Cursor 额度：点击后读取正式 Cursor 配置的既有桌面登录态。不是拾光待切换账号，也不是隔离采集账号。四个只读 DashboardService RPC，无 Set/Run/付费开关/OAuth 兑换。凭据不返回 renderer 或落盘。
- 数据只保存到 `userData/cursor-protocol.json`，原子写、0600 权限。损坏记录拒绝静默覆盖。不读写业务数据库或账号 vault。

查询调用 `GetCurrentPeriodUsage`、`GetUsageLimitStatusAndActiveGrants`、`GetPlanInfo`、`GetFilteredUsageEvents`。后者只查最近 24 小时、第一页最多 20 条。响应上限 2 MB、超时 12 秒、禁止重定向。主进程只接受本应用窗口调用；同时查询复用一份进行中的 Promise。

只读结果先后核对登录 subject，一旦变化就丢弃；用不可逆指纹区分账号，不展示原 user ID。对话标识也只保存指纹。

## 严谨约束

1. 账号计划、模型目录、成功返回、错误 `limit_type` 和实际订阅池不是同一概念。未匹配账本则显示未知，不补零或推断。
2. 匹配须同账号、同对话、30 秒时间邻域和精确 input/cache/output 一致；多候选不确认。实际账本匹配优先于导入声明。
3. 输入口径必须声明：`total-including-cache` 才与未缓存账本 Input 相加匹配；未知口径不猜。单步 Ask 的规律不能直接推广到多步 Agent 总收费。
4. `chargedCents` 表示接口额度记账值，不代表银行卡扣款。Free 数据可以有非零该字段。
5. 旧 auto/api/total 百分比与 auto_bucket_models 不自动改名为新版额度池，百分比不相加。
6. Pro 双池背景基于 [Cursor 当前官方说明](https://cursor.com/docs/models-and-pricing)，不是本轮 Pro 实测。未知 product ID 保留原标识，不按名字猜池。

## 分层

- `src/domain/cursor-protocol.ts`：格式、边界验证、纯匹配和池名表达。
- `src/infrastructure/cursor/cursor-protocol-*`：私有记录存储、只读 protobuf 子集/解码、额度读取。
- `src/main/register-cursor-protocol-ipc.ts`：主窗口授权、文件选择与读取入口。
- `src/renderer/src/settings/SettingsProtocol.tsx` 与 `protocol.css`：独立页面；只在显式操作请求额度。
- 预览 fixture 来自 2026-10-07 真实 Free 研究样本，预览核对是模拟；测试数据不会进入生产记录或自动查询账户。

此页不改变 `CursorUsageTracker` 现有计算。实测流 Input 含缓存、账本 Input 未缓存的差异已展示，后续若接到主统计，需要独立设计去重、运行绑定、多步聚合与迁移，不能直接替换旧数字。

## 隔离协议实验（新增，明确选择入口）

设置 → 协议 → **协议实验**。此工作台与上述只读采集视图分开：点击发送会消耗当前账号正常额度；打开页面、新建会话、重启恢复均不发模型请求。

- **协议直连**：自己的 HTTP/2 / Connect protobuf 客户端，不加载官方 SDK，不需要安装或运行桌面 Cursor。账号权限、额度分配与记账仍由 Cursor 服务端决定。
- **Cursor 工作台**：返回已有运行页。没有全局后端替换，也不在失败时自动降级、迁移或重发已有 Composer / 批量 / MCP 会话。
- 本版仅开放 `default` / Auto、Ask、1–256 字提示词，每个隔离会话最多三次手动发送（失败也计次数），最多二十个会话。全局一次一个实验；账本核对结束前不接受重复发送。
- 新建绑定拾光当前选中的已保存账号；后续按绑定 ID 取凭据，不跟随当前选择偷偷切号。正常 session / PKCE 兑换只保留内存缓存；源 token、subject 或有效期不符则停止。不修改 vault、正式 IDE 登录态、机器身份、会员或收费设置。
- 无工具、文件、工作区、MCP、子 Agent 或自动安装。只回答自身 requestContext 和无命令的环境 ready；其他 exec / query 安全中止，不执行服务端命令。
- 持续发送 heartbeat 和 KV 回执；blob 使用 SHA-256 地址校验。只有正常 EndStream、turnEnded 和 checkpoint 齐全才提交成功；HTTP 200、部分答案或 EOF 都不足以判成功。
- checkpoint 在完整成功后才与 run 原子提交。失败/取消不覆盖上一成功状态；应用中断不自动重发。UI 写入前崩溃只按精确 runId 恢复已经成功提交的结果，不猜测服务端完成状态。
- 自有数据位于 `userData/protocol-experiments/`，与业务数据库分离。0600 文件、0700 目录、大小上限、私有结果与提示词；不会把凭据写入实验记录或 IPC 快照。流式推送约 80 ms 合并，普通过程持久化约 500 ms，结束立即保存。
- 成功后仅一次只读账本核对。要求同一绑定账号、同一 conversation、运行时间范围、精确 token 守恒且候选唯一。尚未入账、重复候选、网络失败均保留未知；不补零、不重发。
- `TurnEndedUpdate` 原始 Input 与账本未缓存 Input 分开显示。当前 Auto 实测含缓存总数；不能推广所有模型、多步 Agent 或不同客户端。

### 实测与未覆盖

2026-10-08：两次纯 Node 独立生成（其中一次新进程从 KV / checkpoint 续接），加一次软件正式组件 / preload / IPC 的隔离 macOS 桌面生成，均得到 OK、正常终止、checkpoint 与 Free 账本唯一匹配。桌面验收新增模型请求严格限一次，未启动正式 Cursor；保护文件哈希不变。产品 macOS 打包及 asar 内 protobuf 运行时加载通过。

这不是“全部协议完整”。Pro / 双池 / On-demand、其他命名模型、工具、文件、复杂 Agent、多并发、联网恢复和 Windows 真机传输仍未覆盖。不会据此宣称所有模型可用或自行控制额度桶。协议版本兼容标识固定为本轮验证的 `sdk-1.0.36`，并非把 IDE 的 `3.21.12` 冒充 SDK 版本；后续服务端契约变化须重新验收。

回归：`npm run test:wire`、`npm test`、`npm run typecheck`、`npm run pack:mac`。隔离实验不会发布独立协议作为稳定公共 API。
