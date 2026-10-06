# 拾光通知系统实施进度

当前状态：实施中，完整目标未完成，未发布、未安装或重启用户软件。

实现工作树为 `/Users/lyr/Downloads/SG-Team-notifications`，分支 `feat/notification-system`，基于 v0.5.15 主线 `5a371f7`。原主目录和原 UI 开发工作树不作为本目标的修改范围，已有基线漂移原样保留并记在各批保护报告中。完整需求以 `docs/NOTIFICATIONS-DESIGN.md` 为准，不能把底座或空通知列表作为系统完成。

## 当前已落地并核验的批次

- 通知模型区分活动、需知晓和待处理；读取、归档不改变业务生命周期。
- 桌面私有 `notifications.sqlite3` 和私有 schema 版本，不写任务／消息／账号数据库，也不修改其全局 user_version 或已有业务表。这个私有库不是新 MCP 通信媒介。
- 记录、已读版本、偏好持久化；重复和过期源版本不回退结果；相同内容的新采样不反复通知。
- 读过的旧版本不能误读新结果；读操作不改变事件排序；待处理事项不能被归档或清理。
- 工作区查询包含全局更新但不混入另一工作区；分页遇到版本变化明确 reset，不继续拼接旧 offset。
- 清理已读有确认门禁和去重墓碑，不被同一版本重放复活。
- SQLite 在持久 worker 内；有界的事件队列、请求队列和明确 busy 重试。超时不假定事务失败、不重放未知写入、不擅自终止仍活的 worker。
- 推送与 DesktopSnapshot 独立，IPC 验证调用窗口和参数。渲染层没有发布通知或执行任意动作的接口。
- 故障不抛入业务事件入口；存储恢复后仍保留本次历史缺口标记，不假装丢失记录已恢复。
- 防御性脱敏和仅导航的目标结构；保留原更新逻辑，只去掉彩色左边。

## 当前证据

第一至十四批证据目录：`/Users/lyr/Downloads/SG-Team-review-design/preview-screenshots/notification-implementation/`。第十五批起的新增证据保存在当前实现树的 `preview-screenshots/notification-implementation/`，不写入受保护的原开发目录。

- `foundation-audit-tests.log`：ledger、service、worker port、IPC 边界测试。
- `full-regression-foundation-final.log`：当前阶段全部测试通过；不是完整通知系统验收。
- `build-foundation-final.log`、`typecheck-foundation-final.log`、`dead-code-foundation.log`：构建与代码检查。
- `electron-asar-worker.log`：实际 macOS Electron 加载 ASAR 中的当前编译 worker，跨重启记录和已读恢复、重复事件去重、已有 schema 保留；持锁时主线程定时器正常响应。
- `channel-smoke-foundation.log`、`mcp-smoke-foundation.log`：原通信与协作协议冒烟。
- `tests/notification-storage-isolation.test.ts`：验证正式主进程连接到独立文件，通知与业务写锁不共用。
- `protected-baseline.json`：两份原开发目录的全部源文件、status、binary diff 基线。

所有数据库和 ASAR 验收使用隔离数据；临时目录已清理。未调用真实账号处理、模型请求、删除或退款，未重启 Cursor。没有 Windows 主机实机验收，不能表述为双平台真实使用通过。

## 接下来仍须完成的完整范围

### 第二批已实现的界面与更新来源

以下已落地，不表示其余业务接入已完成：

- 顶栏轻量铃铛、版本化计数；独立 renderer store，初始拉取不会覆盖更新的推送，订阅按使用者清理。
- 通知中心提供全部／待处理／未读、当前／全部工作区、分页、稳定详情、具体来源导航、阅读、归档、确认清理、安静模式。日常动态折叠，不参与未读；新业务变化显式刷新，已读回执不伪报新结果。
- 单张提醒，暂停悬停／焦点／窗口失焦计时；过期普通成功不返回前台补播；安静模式和已读事件收口现有提醒，关闭不自动已读。
- 导航校验真实 session / generation / Composer / run / group，过期引用不跳到复用同 CH 的新会话，也不悄悄切换工作区。
- 软件更新订阅真实主进程状态，复用已有检查、延后、跳过和门禁，不新增请求。仅对可用／下载完成／明确失败和启动结果入记录，百分比不刷通知。
- 软件更新原结果可见时仅确认相同语义事件，隐藏子页或晚到旧查询不误读新结果。旧提醒「稍后」验证版本和当前相位，不延后另一个新版本。
- 旧版本提醒在已安装或更新版本出现后收口；来源时间与本次观察时间区分；重启的旧状态不重放。源当前状态用持久 marker 分配单调版本，清理墓碑保存内容身份。
- 通知记录读取时检查类型和有限目标，异常原数据保留；私有 schema 已从 1 迁移到 2，团队／账号数据库不变。

新增验证：`notification-center.test.tsx` 使用真实 SQLite 记录验证交互；`notification-toast.test.tsx`、`notification-store.test.ts`、`notification-result-read.test.tsx`、`notification-navigation.test.ts` 覆盖暂停、单张、初始订阅竞态、过期目标、阅读版本和原页可见性；`app-update-notifications.test.ts` 覆盖真实服务到持久 owner 的连接，不只看静态组件。

实际产品组件截图在证据目录 `ui/`：浅色、深色、窄窗和长内容；CUA 实测分页 30→60、Escape 关闭并返回铃铛焦点、长路径无横向越界、跳转存储清理和无 console 错误。预览数据不进入正式 renderer bundle。这是浏览器真实组件验收，不等于 Windows 原生验收。

### 第三批已接入的会话与批量来源

- 会话通知直接订阅 `DesktopSessionService` 最终校验投影与现有团队拓扑，不复写心跳阈值，不增加探测或模型请求。`runtimeScope` 携带同帧拓扑身份和版本，旧团队与新会话的交叉回调不混合处理。
- 桌面私有源检查点和记录在同一个 CAS 事务中提交；历史事件写失败时不推进检查点。当前私有 schema 版本为 3，业务数据库及其全局版本不变。
- 生命周期区分首次接入、疑似失联、确认离线、同身份恢复、新代次和正常退役；初始水合与睡眠恢复先建立基线，停止监测不假造死亡，时间标为观察时间。
- 语义 FIFO 保留已观测到的停止／恢复，只有等价心跳合并；普通活性刷新不写通知库。睡眠前已接收的事件可进历史但不唤醒后补弹。队列有界，写入和容量异常明确报告历史缺口。
- 冷切号重启、手动开启调试端口和自动修复关联当时实际会话身份，不做全局静音；结果不把 Cursor 启动等同于所有 Agent 恢复。旧重启确认收口后，后来的意外停止不能重新归因给它。
- 同批多个会话异常／恢复仅聚合送达，不生成第二套记录或伪读所有成员；聚合使用最后的全局提交版本，混合结果使用警告语义。
- 批量发起新增只读观测标识区分复用、创建提交与在岗，订阅在原自动化触发之后执行，观察者异常不改变原结果。启动工作区冻结，晚到结果不挂到新工作区。
- 运行页的实际批量结果带精确通知身份；可见原结果只确认该事件，不再叠一张全局提示。成功文案使用「已接入」，不把在岗处理中一律说成待命。

证据包括 `session-lifecycle-notification.test.ts`、`session-lifecycle-notifications.test.ts`、`notification-source-transactions.test.ts`、`connect-session-notifications.test.ts`、`batch-launch-notification.test.ts`、`batch-launch-notifications.test.ts`、`cursor-restart-notification-observation.test.ts`。它们覆盖实际 SQLite owner、源订阅、慢存储、重启基线、原执行顺序和观察者异常；不是只测演示弹条。

最新证据目录中的 `full-regression-runtime-verified.log`、`build-runtime-verified.log`、`dead-code-runtime-verified.log`、`electron-asar-runtime-verified.log`、`channel-smoke-runtime-verified.log`、`mcp-smoke-runtime-verified.log` 对应本批源码。原已安装软件和 Cursor 未改，尚未用真实 Cursor 会话主动停止／重建来验收该新通知连接；不能把隔离验证表述为全平台实机验收。

第三批结束时自动化与其余业务来源尚未接入；后续进度见下面各批，不以本段历史状态覆盖新证据。实际应用退出时的最终受理队列落盘边界仍须继续审查，不能仅凭 worker 单测声称应用进程退出无丢失。

### 全目标逐项完成审计仍需继续

### 第四批已接入的自动化与独立操作来源

- 自动化增加只读 attempt/revision、冻结 scope 和已处理账号身份，七个步骤／支线分别记录 not_started、running、succeeded、failed、cancelled、skipped、unknown；不从成功文案倒推结果。
- 主 phase、原消息、原取消入口和已有等待期限保留。服务监听异常隔离，不改变实际调用顺序。清场和接手的晚到回执只更新原 attempt，跨轮晚到不污染新轮；超时不覆盖已收到的确认结果。
- 实际清场失败、待回执、仅处理、取消后的已发生效果和附带警告进入同一条通知。普通 tick / 等价进度不写库或重弹；已结束主线的新支线问题可更新未读，但只在重要结果改变时再提示。
- 重启时区分旧运行未结束与主线收束但支线未知，保留已确认效果，明确待核对，不自动重跑。观察时间与真实动作结束时间不混用。
- 自动化原运行卡按结构化步骤显示，不再对 done 一律全绿；未知／警告不伪装完成。原消息诊断保留，字号和长文本在原组件作用域内调整；真实可见结果才确认该条阅读。
- 独立账号／手动 Token 处理和存储清理结果已接主进程；保留原服务参数和返回事实，通知故障不替换、重试或重复执行原结果。部分清理以实际 done/skipped/freedBytes 表述，不把估计量当实际。
- 冷热账号切换以显示专用 nonce 关联原操作，新增元数据可选且旧调用兼容；运行确认、机器码应用、端口准备和警告分别陈述。原切换互斥、恢复和账号闸门不变。
- 设置页的账号／导入提示现在只在原子页呈现；处理结果还区分账号页与服务页，不将账号页反馈带到统计页。过期来源账号／服务范围不被通知导航静默激活或修改。

本批核验包括原自动化全部路径、实效顺序与 observer 失败隔离、看门狗、真实 late cleanup 回执、owner tick 去重／迟到版本、旧未知支线恢复、处理／清理原异常保留和纯显示引用。当前新界面在浏览器实际组件中测得警告卡不全绿、未知接手明确待确认、无横向越界；截图 `ui/automation-cleanup-warning-dark.jpg` 和 `ui/automation-handover-pending-dark.jpg` 使用隔离预览事实，不能替代真实账号处理验收。

第四批结束时，账号导入／登录等其余重要长操作、维护与文件／交接、问题／回复／队列及团队任务消息仍待接入；下一批完成的问题／回复／任务消息范围见下。系统原生送达、全分类偏好、保留清理与 worker 终止恢复、应用退出受理队列边界、Windows 实机及全要求逐项验收仍是完整目标。没有发布、安装或运行真实账号流程。

### 第五批已接入的消息、问卷、任务与精准来源阅读（2026-10-05）

- 问卷直接消费同帧最终会话证据和真实过程／历史块。恢复旧待回答问题保持安静；明确 submitted/cancelled 才收束成已回答／取消。裁剪、暂未同步和换页不推断回答；明确不再等待、停止、同 CH 换代或旧运行完成会使原动作过期。持久已回答不会被迟到的 pending live 块覆盖。
- 只把最终 complete/failed 助手记录作为回复结果，不通知每个 Token／过程行。跨来源以 entry、stream、turn、outbox 关联去重；文字相同的不同回合仍各自保留。晚到 canonical 引用更新原记录，不重新未读；用户已清理的结果不被纯引用修正复活。初装历史不冒充新回复，已有检查点的遗漏结果可安静补入。
- 团队任务的 review 是 Agent 验收，不生成虚假人工审批；进度与中间尝试失败不当作任务最终失败。真正 done/failed 进入结果记录。只有 Agent → operator 消息进入用户协作消息来源，状态广播是折叠动态；完整正文不复制进通知。读取或关闭不会改 Agent 的通知／已读／响应回执。
- 来源统一用有界语义 FIFO 和 CAS 传输，不执行原业务。交错心跳合并，A/B/A 真实变化保留。同数组存储失败后下一真实帧可恢复，未知事务不盲目重放。休眠恢复先消费一帧安静基线，不把安静无限延长。
- 大历史按每事务最多 100 条分批，只推进已提交事实；中间失败保留成功批的检查点。当前紧凑身份检查点上限 2 MiB，超限明确报告历史缺口，不无限放大。回复保留最多 2,000 条剪裁范围的关联；协作原源保留整个 run，不能照抄 2,000-ID 淘汰策略导致反复补写旧历史，故其有明确容量上限而不静默淘汰。2,100 条协作消息和 2,000 条回复身份均有真实 SQLite 验收。
- 原页面阅读共享可见性检查，考虑滚动父容器、隐藏／inert、焦点和前景弹层。回复观察器每个工作区一个，不按历史消息订阅 store，也不将过程卡露出误认为最终正文已读。滚动复用已获取的候选，不在每个滚动事件反复查 IPC。跳转成功只表示导航成功，不顺手整页已读。
- 协作消息跳转先重新核对 run/group/message，打开且钉住具体原消息，后来的新消息不顶替。显式通知入口采用正文在前、图在后；普通协作图仍保留原排布。实测旧的「仅钉住然后滚动」在窄窗改排后会再次藏正文，已经改为消息优先排布，而非叠滚动计时补丁。

本批证据：`full-regression-message-final.log`、`build-message-final.log`、`dead-code-message-final.log`、`electron-worker-message-final.log`、`electron-asar-message-final.log`、`channel-smoke-message-final.log`、`mcp-smoke-message-final.log`。实际 macOS Electron／ASAR worker 验证新增精确来源查询、已清理引用修正不复活、大身份检查点，仍只写隔离数据。真实组件 `ui/operator-message-target.jpg`、`ui/operator-message-narrow.jpg` 证明原消息精准呈现；840×660 的改排后正文仍可见、无文档横向溢出、无 console 错误。该预览不是 Windows 原生或实际账号验收。

本轮保护核对见 `protected-message-audit.json`：旧 UI 树 675 个文件和 Git 状态／diff 均匹配；主目录 Git 状态／diff／HEAD 不变，但预热相关四文件与旧内容哈希不同。本轮没有写这些主目录文件，未重置或覆盖该差异，旧保护基线原样保留。

**仍未完成**：问卷动作失败／队列／上下文和成员交接等重要结果，账号导入／登录与维护等其余页面来源，原生 macOS／Windows 送达与完整偏好，保留与 worker 重建、真正应用退出受理队列边界、完整打包及 Windows 实机验收。第五批不是整套完成，没有推送、发版、安装或重启 Cursor。

### 第六批：真正退出的受理队列边界与问卷证据复核（2026-10-05）

- 根因：原 `before-quit` 先直接 stop/清空源队列，再 fire-and-forget 关通知库；Electron 不等待后者。已被源接受、尚未加载检查点的通知可能随退出消失，原关库单测不能证明应用退出安全。
- 新顺序：对已有源停止接收、保留并排空已接收语义帧，再关闭 ledger。普通桌面资源仍按原逻辑停用，且只执行一次。休眠中的已接收生命周期帧也能排空，不等下一次唤醒。来源失败即使被观察器内部吞掉，也会使本次退出未确认；过去已有的历史缺口与本次成功排空分别记录。
- 真实退出期间不弹新提醒；重复退出请求不重复销毁资源、运行安装器或关库。通知排空等待默认最多两秒；超时仍继续原退出请求，不盲目重放未知写入，不改运行/账号结果。真正完成需要收到 repository.close 回执，不能仅因停止接收或发出关库指令就称成功。
- 私有 `notifications/runtime.json` 是小型运行完整性证据，不是队列或数据库。它只含版本、时间和可能历史缺口；正常确认写 closedAt，超时或强退不伪写干净状态，下次启动在中心保留“可能不完整”事实。读取有 4 KiB 硬界，错误原文件保留，临时写文件清理。该说明不冒充知道所有错过事件，不自动重跑业务。
- 不更改 mac 最后窗口关闭继续后台、Windows 最后窗口关闭退出的原分支；退出已经停用后不再新建窗口。没有重启 Cursor、真实账号操作、真实软件升级或通知 OS 权限修改。OS 强制关机／进程终止不能保证排空，只恢复已有证据；磁盘不可写时也不能许诺完整性证据已持久化。
- 同时复核问卷真实来源：旧 awaitingUser=false 可能只是没有过程帧。新增只读证据来源，未知／裁剪／过期甚至严重未来时间的采样不当成明确否定；保留已确认待回答问题，直到有明确提交/取消、可靠不再等待或停止/换代证据。原布尔显示沿用已有信号，不新增 CDP／模型请求。
- 回归中出现现有气泡计数偶发 412→413 不推进。确定性复现证明：合并 timer 可比 120ms 的墙钟门槛早 1ms 触发，旧代码先清掉待补信号，再被原节流拒绝，导致最后一帧永久丢失。现在 inspect 返回是否真正启动，拒绝时保留原待补信号并沿用原窗口补读；没有额外探针或提高正常采样频率。该修复影响通知依赖的最后状态证据，不是忽略失败测试重跑。

当前验证由 `notification-shutdown.test.ts`、`desktop-session-service.test.ts` 与 `question-notifications.test.ts` 覆盖受理后慢写、停止后拒收、休眠退出、观察器处理失败、真正关库回执、超时/迟到不二次退出、损坏/超大证据保留和问卷未知 false。`scripts/verify-notification-shutdown.mjs` 加载真实源码和编译 worker，但不加载生产 main：实际 macOS Electron 的 before-quit / will-quit 在干净、模拟更新触发、超时、强退及强退后恢复五场景验证；正常已接收记录重开 SQLite 可见，退出只恢复一次，未出现退出时提醒。模拟更新触发不等于实际 NSIS 或整包替换安装验收。

完整当前证据需对应最后源码：`full-regression-shutdown-verified.log`、`build-shutdown-verified.log`、`dead-code-shutdown-verified.log`、`electron-worker-shutdown-verified.log`、`electron-lifecycle-shutdown-verified.log`、`channel-smoke-shutdown-verified.log`、`mcp-smoke-shutdown-verified.log`。所有原生 fixture 数据和编译临时目录 finally 清理；业务/原目录保护见 `protected-shutdown-audit.json`，已知四个预热文件漂移未被覆盖。

**后续完整范围仍在**：队列（入队不等于取走/回复，缺失不等于撤回）、上下文/成员交接（真实 outbox 身份关联）、问卷动作失败以及同会话新旧问题身份序列、其余页面重要操作与跨重启未知结果、原生送达与完整偏好、历史保留/缺口说明确认、worker 真实终止后的恢复、正式打包与 Windows/完整应用实机。当前只是已接入源的正常退出边界完成，不是所有流程、所有平台和强制退出都能无丢失。仍未发布或安装。

### 第七批：真实出站队列、上下文及成员交接来源

- 稳定 outbox entryId 作为只读受理元数据向上返回，原 commandId/发送语义保留。队列事实仅在 main 侧，从原入队/水合/轻量投递状态扫描获取；不传消息正文、附件或保持位令牌到通知/renderer，不新增周期查询或模型调用。
- 普通入队、保持、实际取走、撤回、退役、明确关联回复分别陈述。普通队列动态不未读/弹条；裁剪消失不伪造撤回，旧排队帧不回退已确认取走/回复。真正 SQL runId 决定归属，当前同 CH 或新工作区不改写旧消息来源。
- 原 scope 切换/结束事务提交之后，仅对缓存仍待决的旧 IDs 做每批 256 行上限的轻量只读核对（无正文/附件）。否则 Agent 在事务前已经取走而主进程缓存未刷新的行可能被错说成退役；超过 500 条时间线窗口的旧排队行也不能永远停在待送达。核对失败不改事务/重跑，明确显示结果待核对，不再称它即将送达。
- 会话交接 observer 位于原 send 之后，原文件定位/写入/发送顺序和异常不变。交接时文件存在不等于完整落盘；预期路径/旧快照/新鲜度未知和补充记录失败各自保留。旧 WS 传输未提供出站身份时只记录受理，不据 commandId 编造后续送达。
- 有真实 entryId 的交接随 held→取走→明确关联完整回复更新同一条记录。换代会按可证明的当前绑定更新目标引用，旧源/旧运行不静默切到新工作区。持久检查点恢复已有交接关联，不自动重发，也不从一段回复文案猜“已读完”。
- 成员迁移的上下文成功路径采用同一关联 queue 记录，不再另起无归属的成功通知；迁移已完成、释放任务、主控随迁和上下文失败分别说清，不把附带失败称成全部迁移失败。独立父结果和手工交接失败不改变原返回/原异常。结果弹层以精确引用确认人类阅读，不改 Agent 回执。
- 队列来源与既有源一起封口/排空，休眠/启动保持安静。输入事实分组/签名缓存，idle 心跳不重新序列化完整消息历史或写 ledger。内存/检查点容量有界，超出或审计失败报告可能历史缺口，不影响业务队列；不是无限容量承诺。
- 显式交接身份可暂时进入原轻量扫描查询的有界 watchedIds（最多 2,000），仍是原查询/原 tick，不另加轮询。这样旧保持位交接在最近 500 行之外被新会话取走时仍能看到实际回执。终态 ID 随回执撤下；重启从私有 checkpoint 恢复旧关联，源缓存没有原行时先标未核对，原 SQL 行确认后才恢复事实，不能凭私有记忆创造真实 deliveredAt。已取走但未回的交接也可恢复，允许后来明确关联回复收束它。
- 会话/迁移交接结果使用原弹层与 SG 语义色，去掉排队=全成功的绿色暗示，字号和段落在本组件范围内调整。待投递定位明确展开原 tray，不改全局折叠偏好；卸载后的异步定位不再到 document 里找别的 pane。对应回复可确认交接结果的阅读，不将导航当读取。

本批证据：`queue-notifications.test.ts`（真实私有 SQLite owner）、`channel-queue-facts.test.ts`（真实 relay/业务仓储/交接服务）、`membership-transfer-notification.test.ts` 与原 IPC/迁移/对话/托盘回归。它们验证受理不等于取走、并发已取走旧行不错误退役、审计/observer 失败不重复业务、持久关联/换代/跨工作区归属、隐私、同输入失败后下一帧恢复、idle 不写、230 条事实分批和 550 条越过时间线窗口后的结束收口、真实排队目标展开和卸载安全。`full-regression-queue-final.log`、`build-queue-final.log`、`dead-code-queue-final.log`、`electron-worker-queue-final.log`、`electron-lifecycle-queue-final.log`、`channel-smoke-queue-final.log`、`mcp-smoke-queue-final.log` 对应最后审查后的源码，verified 日志为此前阶段证据。浏览器截图 `ui/handoff-accepted-dark.jpg`、`ui/queue-target-dark.jpg`、`ui/queue-target-narrow.jpg` 使用真实产品组件+隔离 mock，不接 Cursor/账号。常规宽度定位原 tray 正确、console clean；840×660 的文档无横向溢出、tray 展开状态保留，但原应用紧凑排布会把会话主体置于名册之后，并非在该视口内同时可见。此项不能声称窄窗全过程可见，完整响应式验收仍须检查。

保护核对 `protected-queue-audit.json` 与上一批一致：原 UI 树源/Git 均匹配，主目录四个已知预热文件漂移保留，未写这些文件。没有推送/发版/安装/当前软件或 Cursor 重启。

**仍须完成**：其他页面的重要长操作与跨重启未知结果、问卷动作失败/精确问题身份的更多真实序列、原生送达/完整偏好、历史保留/缺口确认、worker 真终止恢复以及正式打包/Windows与完整安装应用验收。队列/交接关联的更长容量/晚到持久序列也要继续压力审查，不能以这批基本路径测试取代整套完成审计。

### 第八批：单渠道提醒、系统通知适配与完整提醒设置

- `NotificationDeliveryService` 消费已保存的源事实，只负责送达。原记录/已读/业务结果立即推送；每个实时机会独立选择前台应用内或用户开启后的后台系统提醒，不同时发两种。该观察者不调用账号/会话/更新业务，不新增模型、余额、远端或业务数据库轮询，不让链路等通知。
- 送达前后复核具体记录、attention/revision、已读/归档、前后台、类别、当前设置；私有 CAS claim 先确认受理身份再呈现。claim 不是已显示/已读证明，未知写入不会自动重放；跨 owner 重建可去重。队列最多 32、最近身份 1,024、记录缓存 512、同时管理的 OS handle 最多 8，满载仅在设置中披露短暂提醒可能缺失，原历史不被删掉。
- macOS/Windows 原生 adapter 使用 Electron，Windows 使用与打包配置相同的 AppUserModelId。默认系统提醒、声音、摘要、额外连接和完整回复动态全关闭；能力查询不是权限授予。开设置/启用开关不发测试通知，显示仍服从 OS 权限及勿扰，不用 critical 绕过。原生失败只在设置披露并在还有效时给一次应用内机会；后续不逐条撞权限，需用户重新启用才尝试新的系统提醒，不补发旧结果。
- 默认系统正文只有拾光通用提示；用户开启摘要后仍防御性隐藏凭据形态、邮件、用户本机路径。原消息全文不复制进 OS。系统点击/关闭不自动已读，不改变 Agent 消息回执，更不会直接执行重启/安装/回答。点击携带有限的 ledger 引用到通知中心，具体内容可见后才确认阅读；前景弹层与慢查询竞态不会被强行盖掉或错读。
- 提醒设置成为单独可滚动子视图，不往历史列表底部塞长面板。总开关、安静、系统提示/声音/摘要、额外动态、定时安静与十类应用内/系统渠道各自可控，自动保存，失败保留原状态。旧全类别静音重新开启其中一个渠道时另一个不被悄悄开启。工作流与历史记录不受这些设置影响。
- 定时安静使用本机时段，支持跨午夜，相同起止明确为全天安静。一个边界 timer + 原 power resume 事件复核，不周期查询业务；进入时关闭已有提醒，结束不补播普通成功。某会话详情可设默认/重点关注/安静，按确切 workspace/run/session/generation/Composer/binding 匹配，不把同 CH 新会话继承旧静音。重点关注不突破总开关/类别/安静规则；只提升待呈现机会，已悬停/聚焦卡不被顶替。
- 额外上线/恢复和完整回复是单独背景 opt-in signal，不制造人工待办、虚假未读或前台刷屏；启动/休眠 baseline 不重放。源层仅增加显示用信号，持久记录不保存 `liveSignal`。重要异常与已有重要结果仍按原模型入记录，自动化正常完成也是合法候选，不限定失败。
- 二次审查修正了两个实际计数/阅读问题：送达过程的 key 单条查询不能把全局徽标 3 条降成 1 条；系统点击展开具体正文、列表尚未返回时的已读回执不能伪称“有新业务更新”。分别保留全局 summary 流与精确只读回执序列，不重排已有记录；迟到旧状态也不能覆盖新送达故障或较新的系统点击引用。

本批证据包括 `notification-delivery-policy.test.ts`、`notification-delivery-service.test.ts`（真实私有 SQLite owner/CAS）、`native-notification-port.test.ts`（macOS/Windows adapter API seam）、`notification-preferences-panel.test.tsx`、`notification-system-native-open.test.tsx` 与原 IPC/store/toast/center 回归。它们覆盖正常完成/默认静默、背景和前台竞态、按渠道静音、未知 claim、owner 重建、聚合成员改变、失败退避、定时进入/退出、原始正文可见读取、前景 modal/慢查询、精确代次和隐私。首轮新测试曾因测试 mock 调用自己而 OOM，已修 mock 实现引用并重新核验；这是隔离测试 fixture 问题，不作为通过证据隐藏。后续终态日志必须以最后源码重跑为准。

最终证据为 `full-regression-native-verified.log`、`build-native-verified.log`、`dead-code-native-verified.log`、`electron-worker-native-verified.log`、`electron-lifecycle-native-verified.log`、`channel-smoke-native-verified.log`、`mcp-smoke-native-verified.log`；先前 final 日志是最后一项 claim 错误披露修正前的阶段证据。实际 macOS Electron 退出 fixture 已加载当前送达代码并只读确认原生 capability，五场景仍无退出时系统弹条/新建窗口，生产 main 未加载。**没有调用物理 Notification.show、没有改变 OS 通知权限/勿扰或声音设置，也没有 Windows 实机，不能说真实双平台系统弹窗及声音已经验收通过。**

真实浏览器组件截图 `ui/preferences-dark.jpg`、`ui/preferences-light.jpg`、`ui/preferences-details-dark.jpg`、`ui/preferences-narrow-light.jpg` 使用隔离预览 capability 和内存开关，不是实际 OS 权限。字号主行 14px，类别两列基线差 0、独立内容区可滚动、console clean；模拟系统点击只读一条原内容，其他未读保留且不自动跳业务页，阅读后不再伪报“有更新”。380×640 的设置面板本身在视口内且无自身横向溢出；原应用主页面此极窄浏览器视口有横向越界，不能据此宣称整个软件的极窄布局完成，原生窗口最小尺寸及完整响应式验收仍需核对。

保护报告 `protected-native-audit.json` 与上批一致；原 UI 树 675 源文件/Git 基线匹配，主目录已知四个预热文件漂移保留，未覆盖它们。未推送/发版/安装或重启当前软件/Cursor。

**完整目标仍未完成**：其余页面重要源/跨重启未知操作、问卷动作失败等完整事实序列、历史保留与历史缺口确认/worker 真终止恢复、整体响应式及正式打包/完整应用/Windows验收、真实 OS 权限与实际通知/声音/系统勿扰行为。该批完成送达结构与设置，不把能力查询、fake adapter、静态开关或绿色测试代替真正系统效果证明。

### 第九批：账号/维护/问卷/文件原入口结果与未知恢复

- 新的 `PageOperationNotifications` 只收有限 kind、display id、冻结来源和显式 outcome，不接执行函数，不获得卡号、密码、Token、账单资料或用户问卷答案。原入口受理记录是安静 activity，不证明操作已开始。最终回执更新同 attempt；普通短保存/成功问卷/图片保存仍安静，重要长结果或未确认/部分状态进 notice，而不是每个页面刷新都弹窗。
- 账号已覆盖：手动 Token、账号卡及过期卡附带自动登录、本机/系统浏览器/指纹导入、已保存凭据重新登录、打开登录窗口、结账入口、浏览器环境清理、模型数据政策。调用次数/参数/保存 Token 和 fingerprintProfileId/原错误传播/并行识别和原 gate 不变，未为通知查询余额/档位、创建窗口或发送请求。同步快速导入成功也按明确边界陈述，不能说导入即当前 Cursor 已换号。
- 维护已覆盖切号补丁安装/卸载与手工启用 CDP 的明确结果。原锁/补丁管理调用各一次，警告和 changed 与 ok 分开；“无需改动”不冒充卸载外部补丁。文件变化不保证已运行生效，不额外重启。CDP 与生命周期重启观察关联，成功就地反馈仍安静，不产生另一张成功全局提示；未将端口 ready 说成模型请求或已创建批量会话。
- 复核真实 checkout 底层后确认 `verified` 仅为 allowSubmit=false 测试闸门的表单复核。新通知/本页显示分别说“资料复核未提交”和“等待付款”，均未称已付款/Pro。原起结账接口和确认顺序不变，本批未运行真实结账/付款或账号处理。
- 问卷提交/跳过各只有原 responder 调用；新增的尝试失败/未确认记录不改原 question.status、待办和 Agent 回执，没观察到工具也不自动作答/取消。成功是 quiet activity；失败保留 typed code 与原 message 返回，但密码/答案/附言不复制进另一个持久库。来源目标从既有最终 paired snapshot 只读定位 exact block/entry/代次，不增加 CDP 探测。
- 图片另存保留原 dialog/write：用户取消不是写入失败，实际写完才完成，源路径/目标路径/图片 bytes 未进入通知；不自动重开选择器或重新写文件。仍保留其他复制、刷新、短配置反馈的就地策略。
- API 兼容：旧不带 display nonce 调用仍可用、原数组/布尔/typed 结果未替换；可选 notification reference 支持原结果精确阅读。renderer nonce 只作显示相关，重复 nonce 不合并两次业务尝试。账号页、导入表单、维护、问卷错误、运行页 CDP feedback 使用原布局与可见结果引用。等待付款和补丁 warning 不再使用全成功绿色暗示。
- 未结束页面记录跨重启只恢复本地已有受理证据为未知，先复核具体对象/版本防迟到 final 被旧查询覆盖，不自动重做账号登录或补丁。后续明确原对象成功可收束旧失败/未知记录为 superseded，而不是倒改历史成功；按 account/session/generation/Composer/binding/tool 等 scope 匹配，缺乏准确全局补丁/浏览器对象时不猜另一版本/窗口就是同一事项。只查询对应私有 family，非业务轮询。关闭/已读/支付待确认不是“业务解决”。
- 隐私复核改掉了“先接收 transient secrets 再脱敏原 error”方案：observer 连输入 secrets 都不收，只收通用已知错误码摘要，未标记的原诊断也不写入通知；原表单错误仍原样返回给原入口。类型/消息 eventType 与 family 过滤经过参数白名单，renderer 仍无 publish/执行端点。

证据：`page-operation-notifications.test.ts`（真实 ledger、迟到恢复/对象隔离）、`page-operation-account-ipc.test.ts`（真实 vault/原 IPC 和假外部依赖）、`page-operation-action-ipc.test.ts`（真实原 question/image/CDP handler 与隔离 SQL），以及全部原账号/维护/设置/问卷/协议回归。覆盖已保存但登录失败 partial、outcome verified 真含义、保持 mutex、observer 失败不重跑、不复制 credential 原诊断、旧受理恢复未知、同 CH 换代不消旧未知、用户取消附件不误报失败、原 error/results/input/call count 不变。`full-regression-page-final.log`、`build-page-final.log`、`dead-code-page-final.log`、`electron-worker-page-final.log`、`electron-lifecycle-page-final.log`、`channel-smoke-page-final.log`、`mcp-smoke-page-final.log` 是本批最后核验；verified 为此前新增呈现/身份复核前的阶段证据。

浏览器仅以 mock `pageOutcome=partial/waiting` 跑真实组件，未运行 Cursor/浏览器/支付：`ui/page-patch-partial-light.jpg` 明确文件变更与签名未确认；`ui/page-checkout-waiting-light.jpg` 是原账号下方中性待确认说明，不是付款成功。原页可见结果阅读后中心仍保留记录，不重复全局提示，console clean。隐形 checkbox 的 pointer-events 与旧布局保持，键盘 Space 正常走语义回调；坐标点击未触发不是业务验收成功，因此改用可达的键盘操作后复核。常规窗口视觉仅覆盖本批两场景，完整深/浅/窄/错误/历史序列仍需最终全软件验收。

保护核对 `protected-page-audit.json` 与此前一致，原目录/旧 UI 树未被写入，四个已知预热文件漂移保留；未 push/release/安装/重启当前 Cursor。观察器不要求原业务等待落盘：受理尚未存下时强退仍可能只得到完整性缺口说明，不能宣称所有页面动作都有无限耐久日志。

**仍需继续**：其他显著源（工作区/兼容变化、用量/上下文阈值、组/共享记忆/重要诊断等）及逐场景接入审计，历史保留/缺口说明确认、真实 OS/Windows/正式安装包和全布局验收（worker 真终止恢复见第十批）。原短操作就地反馈不能被遗漏，但也不应为了“全部覆盖”堆全局消息。该批不是整套完成，不以枚举页面 kind 就勾掉完整事件矩阵。

### 第十批：真实线程终止恢复与未知结果不重放

- 原通知端口在 worker 退出后永久锁定 failure；现在只有确认的 exit（或工厂明确没有创建线程）才允许重新建立同一私有 ledger 的 owner。error、初始化观察超时、RPC 超时均不是活线程已退出的证明，不触发 terminate 或原调用重发。每个线程有独立代次、就绪和 RPC 容器，旧 ack/ready 不能完成新代次请求。
- 重建使用 100 / 500 / 1500 ms 退避，60 秒内最多三次。预算耗尽后不留常驻循环；冷却后新调用可以请求下一组受限恢复。真实关闭取消恢复定时器，原 before-quit 排空边界和两秒上限不变。工厂抛错和 DB 初始化失败同样 fail-soft，不影响账号、会话或更新控制链。
- 准备初始化的调用和已发送的 RPC 合计最多 64；观察超时的 RPC 继续占容量，直到真正回执/退出，而不是用不断超时把活线程队列撑无限大。真正退出拒绝其未知调用、不迁移到新线程。close 留有收口入口，只有用户明确退出的关闭流程可以终止线程。
- 恢复不自动读取业务库/查询 CDP/发请求，也不扫描历史重新发通知。owner 清空可能失真的旧内容 marker，从私有 ledger 只读同步全局摘要和提醒偏好；恢复事件没有 announcement。历史缺口事实继续保留。迟到旧恢复读不能覆盖新故障，较新的用户偏好不能被恢复初始读取倒改。
- 通知中心未展开时重新读取自己的当前筛选；展开阅读时保留旧正文、给显式“有更新”，不把新 revision 自动已读。不伪造 record.changed 或业务成功来强迫刷新列表。
- 送达 owner 作独立 storage epoch 门禁，丢弃未完成的旧机会和缓存 claim；即使旧 claim 的确认晚回来也不补发系统提醒。恢复后只允许新的正常事件继续送达；迟到的历史同步不能再清空新线程已确认的新结果机会。已持久 claim 不等于 OS 已显示；之前真正的权限/显示失败不因 SQLite 恢复而被清成成功，需要用户明确重新启用。
- 二次审查去掉 worker 对错误文案的 BUSY/LOCKED 猜测。写事务只有 BEGIN 明确失败，或原错误后 ROLLBACK 确认返回，且真实 SQLite typed code 是 BUSY/LOCKED，才能重试；ROLLBACK 未确认或仅含相似字样保持未知且不重试。只读查询可按 typed lock 结果安全重试。原异常对象（包括 frozen error）不被改写，私有 WeakSet 只传递负面边界证据，不持久化日志。

当前终态证据：`full-regression-worker-recovery-final.log`、`build-worker-recovery-final.log`、`dead-code-after-recovery-final.log`、`node-worker-recovery-final.log`、`electron-worker-recovery-final.log`、`electron-worker-after-recovery-final.log`、`electron-lifecycle-after-recovery-final.log`、`channel-smoke-after-recovery-final.log`、`mcp-smoke-after-recovery-final.log`。新增真实 fixture `scripts/verify-notification-recovery.ts` 导入当前端口/owner/送达逻辑及最新编译 worker，在 Node 和 macOS Electron 各真正 terminate 三次：put 已提交但丢 ack、源 CAS+记录已原子提交但丢 ack、送达 claim 已提交但未显示。原 RPC 都未重放，原未读/清理 tombstone/源检查点保留，新结果可继续送达；真实 SQLite 锁的负面回执允许一次安全重试；无关表和全局 user_version 不变。

运行时送达端是**隔离 fake native**，没有产生真实 OS 通知，不能把这项验收当 macOS 通知权限/声音/系统勿扰或 Windows 实机通过。没有启动生产 main、重启 Cursor、处理/清理真实账号、安装应用、push 或发版，fixture 临时目录均在 finally 清除。`notification-worker-port` 单测补全真实退出前的错误/超时、重建风暴预算、迟到 ack、初始化容积和 quit 竞态；真实 ledger 的 service/delivery/center 测试补全缓存未知、恢复偏好竞态、旧详情与 OS 失败隔离。保护状态见 `protected-worker-recovery-audit.json`，已知原目录四个预热文件漂移原样保留。

**全目标仍在实施中**：工作区/兼容性变化、可靠上下文/用量阈值、组/共享记忆/显著诊断等重要来源仍需逐源实现；历史自动保留与历史缺口事实/提醒确认仍未完成；正式打包安装应用、Windows、真实系统通知/声音/勿扰及全部事件序列/布局验收仍待完成。本批证明通知存储线程的受限恢复，不把它当整套完成，也不声称能恢复从未落盘的页面受理或业务内存阶段。

### 第十一批：保留、缺口事实与版本化确认

- 私有 schema 4 加入独立完整性记录与去重身份。历史缺口事实、这次说明的确认版本和通知已读/业务完成各自独立。确认旧 revision 不能收起较新的缺口，失败不乐观消失；确认期间出现新缺口时明确告知原因。这个状态只在中心呈现，不制造另一条未读通知、toast 或 OS 提醒，也不写 Agent 回执。
- `runtime.json` 升级为小型 v2，仍有 4 KiB 读取上限，只增加不含用户/业务内容的 runtime/gap 身份。已确认历史缺口跨正常重启沿用同一个持久身份，不反复展示；再次强退/未确认退出产生新身份。旧 v1 正常兼容迁移；无证据的事件不补造，不把“我知道了”说成已修复历史。
- 缺口 observer 的未知写入先按确切身份只读核对，再决定是否仍缺失；不能据超时重复增加版本。内存待保存身份最多 64，已确认身份缓存有界；已有重要去重身份持久保留，不截掉来伪装完整。来源/存储失败仍不控制业务，说明保存未确认时可见但不能假确认；未确认缺口不能让本次通知退出声称已完整落盘。
- 普通已读结果和日常动态，按最后有效更新/阅读/归档时间保留至少 30 天；未读、仍活动、待处理、曾警告/失败/人工决策的重要记录不会自动清理。保护是 worker-owned 单调事实，不被后来的绿色恢复覆盖。旧版历史缺少过去重要性证据，迁移后保守保护，仍可经原确认入口手动清理。
- 保留任务不在业务启动/原操作链等待：启动 30 秒后由私有 controller 运行，每次最多 100 条，批次间让出 250 ms，排空后每天一次，失败退避，退出封口取消计时器。只处理私有 ledger，没有新的 CDP/余额/账号/模型请求，没有按数量强制截断未读或重要消息。
- 二次审查发现旧墓碑保存完整语义 JSON，清理后仍留另一份摘要。现在改成固定 SHA-256 指纹；旧墓碑分批迁移，保留同内容去重而不保留正文副本。相同内容的新采样版本也不能复活已清理/保留到期的记录，真正新结果可正常出现。不承诺磁盘取证意义的安全擦除或自动 VACUUM。
- 容量边界还复核了初始化：大历史迁移若观察超时，仍不得杀活 worker 或重放原请求。实际就绪晚到时发送安静的存储恢复信号，重新读取私有历史/偏好，不永久锁住界面。
- 中心沿用原有视觉，新增中性说明及“我知道了”，保留规则和事实放在可折叠信息区；没有彩色左轨、装饰胶囊或自动成功弹窗。折叠区限高，不吞正文空间。CUA 在深色窄窗实测发现原定位只按铃铛右边缘、左侧会越界，已按 CSS 视口约束左右边界和可用高度，监听自身尺寸及窗口变化，且不重新抢焦点或改其他页面布局。

终态证据：`full-regression-history-final.log`、`build-history-final.log`、`dead-code-after-history-final.log`、`node-history-final.log`、`electron-history-final.log`、`node-recovery-after-history-final.log`、`electron-recovery-after-history-final.log`、`electron-worker-after-history-final.log`、`electron-quit-after-history-final.log`、`channel-smoke-after-history-final.log`、`mcp-smoke-after-history-final.log`。新真实 fixture `scripts/verify-notification-history.ts` 用最新编译 worker/private file 验证有界清理、未读/人工事项/诊断保留、墓碑无正文、已确认历史重启持久化、旧确认不误确认新缺口和无关表/global user_version 保留。直接真实 ledger/组件测试另外覆盖 ACK 延迟、初始 pull/推送竞态、正常/再次强退身份、旧版保护、损坏数据不默默重置、批次回滚和退出取消计时器；真实源的共用 fixture 已走完整性 controller，不只做静态 UI 演示。

浏览器仍是隔离 preview 的真实产品组件：`ui/history-pending-light.jpg`、`ui/history-new-gap-light.jpg`、`ui/history-acknowledged-light.jpg`、`ui/history-acknowledged-dark-narrow.jpg`。新缺口不会被旧确认吞掉，确认不会减掉业务未读数字，已确认事实仍在可展开区域。窄窗实际 CSS 视口约 615×492，修复前左边界为负，修复后约 12px，且无横向溢出。预览不能证明 OS 权限/声音/Focus 或 Windows 完整应用效果；未打开生产 main、重启 Cursor、执行真实账号处理/付款/清理。fixture 临时目录在 finally 清理，保护报告 `protected-history-audit.json` 保留原开发目录和四个已知预热文件漂移。

**全目标仍未完成**：其他重要来源（工作区/兼容版本/可靠上下文与用量阈值/组和共享记忆等）还须逐源接入及关联页面验证；长序列容量/更完整响应式、正式打包/完整应用/macOS 与 Windows 真通知权限/声音/勿扰验收仍未完成。历史保留和确认机制已经落地，但不能用它替代完整事件矩阵、所有真实平台或从未落盘阶段的证明。未 push、发版或安装软件。

### 第十二批：工作区观测与可靠上下文阈值

- 复核发现界面会保留上一笔上下文，并允许同通道转录 Composer 回退；它们是合理显示，但不能当作当前绑定的新鲜证据。`DesktopSessionService` 增加纯只读 provenance：bound / channel-fallback / cached、实际读数 Composer、原生逐 Composer 模型，以及原有本机遥测读取/缓存验证成功的观察时间。没有新增遥测读、CDP 请求或推送节拍，时间戳自己变化不重新生成 session 引用或整帧业务推送；回退/缓存数值照旧显示。
- `nativeContextReading` 是主进程与可见阅读共用的纯规则，不另造两套可信判断。阈值只读 exact workspace/run/slot/session/generation/Composer/binding，接受原生整数 used/limit、有效比例和相互一致值；本机读取证据超过三秒、未绑定/回退/缓存、错误/重连、未来不合理时间等都不触发或假称恢复。观察时间指**现有本机持久数据读/缓存校验**，不是证明模型服务账单或 Cursor 内存/网络当下精确用量，也不改变估算器。
- 80% / 95% 是通知阈值，不修改原执行闸门/上下文圆环颜色。77% / 92% 退出滞回避免边缘抖动；同一代次与原生模型/容量域，各阈值只新提醒一次，持续增长不逐 Token 写记录/增未读/发弹窗。模型/容量变化安静重建新的范围、使旧提醒不再适用；回到先前域不重新武装旧阈值。初始/唤醒水合保持安静，已有偏高占用可留中心。
- 真停止、退役、明确运行完成以及准确投影的绑定身份替换使相应提醒过期，不推测缺失的会话死亡；单纯切工作区不等于旧 run 完成。原读数中断更新同记录为读数待更新，而不是绿色降占用或重复刷失败。通知域检查点和记录使用已有私有 CAS 事务；多于 100 个旧身份的收口分批完成，不截掉重要历史。作用域容量超出仍显式报告历史缺口，不无界增长。
- 上下文通知动作名为“查看上下文”，只打开对应现有原生统计弹层；点击前/重绘后复核模型/限额、代次与绑定，不自动交接、换模型、发消息或新建会话。只在确切原生正文实际可见、读数仍可信、比例与该提醒级别一致时确认相同通知阅读，旧域或旧代次不被顺手全已读。查询增加有限 generation/contextDomain 筛选，不允许 renderer 发布事件。
- CUA 真组件检查发现原弹层的 hover/focus 会先打开，随后 click 反向 toggle 把它关掉；点击改为明确打开，X/Escape/离开原交互仍可关闭，不增一套展示控件或改视觉。真实导航、焦点和深浅色布局分别检查，保留原模型牌、圆环、统计表、会话和左右栏样式。
- 工作区 observer 复用每一次原来的 `detectCurrentWorkspace`：加只读原因，不靠中文错误 regex 判别。latest-started probe 才能更新通知投影，晚到旧结果仍按原接口返回但不能倒改历史观察；原检测/创建前 gate、调用次数、返回引用和异常保持。正常识别/变化只进日常动态，工作区路径/候选窗口列表/原诊断不复制进 ledger；没有把识别成功说成旧会话结束或自动切换运行范围。
- 原探测暂不可用/未开文件夹/多窗口等不一上来刷失败。已有识别后，至少两次原负面回执且跨度三秒才在中心更新一个未确认事项，恢复按实际新身份收口；无新探测则无编造的持续失败计时。此观测来源默认安静，不产生工作区 toast/OS 风暴。应用退出先封口/排空该来源；source-close 不被提前 stop 抹掉已接受事实。

当前终态证据：`full-regression-context-workspace-final.log`、`build-context-workspace-final.log`、`dead-code-context-workspace-final.log`、`node-context-workspace-final.log`、`electron-context-workspace-final.log`、`electron-worker-context-workspace-final.log`、`electron-recovery-context-workspace-final.log`、`electron-history-context-workspace-final.log`、`electron-quit-context-workspace-final.log`、`channel-smoke-context-workspace-final.log`、`mcp-smoke-context-workspace-final.log`。隔离 `scripts/verify-notification-context.ts` 用当前 observer + 最新真实编译 worker 验证 source CAS/准确查询/两阈值/陈旧不伪恢复/清理和重启不复活/工作区事项持久化；输入事实是 fixture，不宣称真实 Cursor 正跑到 95% 或真实 OS 送达。

`context-threshold-notifications.test.ts`/`context-notification-read.test.tsx`/`workspace-notifications.test.ts`、原 Desktop/创建/IPCs/Context/导航和共用源测试覆盖新代次/域 A→B→A、睡眠、旧 pull/晚到旧探测、同域无写入增长、旧 run 明确结束、220 身份分三批、清理后再读/重启、真实可见正文与未挂载拒绝、原 observer 抛错不破坏业务 gate/调用。Provenance 测试明确正常缓存展示仍在、只更新 sample 时间不生成额外 source 请求或 session 对象。

真实组件预览：`ui/context-threshold-center-light.jpg`、`ui/context-threshold-source-light.jpg`、`ui/context-threshold-source-dark.jpg`。中心详情明确非计费/非会话完成，来源按钮实际切到正确 CH 并打开 Context。HMR 重挂载后先复核当前 DOM 再重新导航，未把先前关闭后的过期 selector 当成功；hover/focus-click 的原问题经复测已修。Console 无 warn/error，普通窗口弹层边界无溢出。没有生产主进程/真实 Cursor/模型请求/账号操作/OS 通知或安装、push、发版；临时预览和 fixture 清理，保护报告 `protected-context-workspace-audit.json` 的原目录状态保持，四个已知预热文件漂移保留。

**全目标仍未完成**：兼容版本/补丁支持变化、模型目录/统计源持续异常、可靠用量差异、组关系/共享记忆的重要诊断还须逐源实现和页面对应；工作区安静检测只是展示观测，不替代使用检测前 gate 拦截/原地反馈。其他已有操作的开始/未知恢复、完整队列/问卷长序列和容量审查仍须按矩阵查漏；正式打包/安装环境、macOS/Windows 真 OS 权限/声音/勿扰以及全 UI 响应式/生命周期实机未完成。本批没有改用更窄的目标，不以两个新来源宣称整套通知闭环。

### 第十三批：原兼容检测、组关系与可定位记忆修订事项

- 兼容 observer 挂在原 `CursorSwitchPumpInstaller.status` 完成边界；调用原定位、metadata/bundle 分析各一次，原返回/异常与安装/卸载/锁/配置读法不改。观察者只得到 opaque installationId、version、明确 compatibility/kind 和 profile-refresh boolean，端口/key/path/原诊断不进入它。异步检查按 latest-started 排序，旧结果仍照原接口返回但不倒改通知。
- 支持的 release 不等于 bundle 实际能力通过；installed 不等于运行中的 Cursor 已加载；切号泵与 profile hook 分开，未知状态不被叫作补丁丢失。新版本变化安静记录，明确版本/能力/profile 问题在原事项中更新，短暂未确认只进中心。另一份安装被选中不能把原安装警告自动改成功；维护导航验证当前安装身份。原页同安装/版本的明确可见结果才读取相应最新通知，旧/不完整接口不假确认。
- 组关系使用现有 TeamControl 订阅的准确 group/member/effective-lead/实际 planning 投影；没有新增 group-events 查询或 timer。正常创建、成员/主控/有效规划权变化和明确 dissolved 只安静更新每组一条关系摘要，Runtime 心跳/顺序调整/无实际效果的 planning 预设不刷历史。缺失的 clipped/过期组不是新解散；原关系确认不代表成员通知已取走、租约/任务/消息收尾全部成功。这个来源覆盖**关系摘要**，不是对所有事务外副作用成功的承诺。
- 原共享记忆服务当前没有启动自己的 watcher；仅挂 subscribe 会漏 MCP 更新。本批使用原 `getSnapshot` 读取/失败的 main-only observer，沿用编排器原来每秒的读取，不启动另一个 watcher、不复读记忆库。原已使用的 TeamControl context 一同交给观察者，避免它再查询上下文和混入另一作用域；观察者抛错不重复查询、不改返回对象、不吞原错误。metadata revision/明确范围终态未变时重用 thin facts 和签名，普通无取代关系条目直接排除；私有未知提交仍有下一原读取机会核对原子检查点，不因性能缓存丢恢复。
- 记忆事项只依据原条目/前置引用的实际状态识别**修订前置条件冲突**，不是用 LLM 判断正文矛盾，也不把尚未采纳的普通提案都交给人类。先前已记录冲突的读取暂不可用/前置缺失保持待核对，正面 eligible/accepted/rejected/superseded 或明确原范围结束才收束相应通知。阅读仍保留待处理；只看到调度消息/调用失败不算采纳或回滚。当前只覆盖已确认前置冲突，其他审核升级/写入错误见剩余要求。
- 新的“查看原记忆”是有限只读目标和单项 IPC：trusted sender、当前 workspace/run/group、精确 id/version 校验后，从原服务取单项与其前置。不向 renderer 暴露 propose/review/消息回执，也不发送回答。正文/引用仍在原业务源，通知库只留脱敏标题与枚举事实；独立查看器支持原文/前置/引用折叠、显式重新读取、滚动和键盘。显示读取时间，不把它说成提案创建时间；关闭/阅读不会替你采纳/驳回。
- 查看器沿用现有中性表面与字号，均匀边框，无左彩轨/胶囊/渐变光效。只读检查也有 UI intent 边界：用户关闭通知或另开交互后，迟到查询不能抢焦点/重新打开中心；查询成功后再次验证对象范围。不因慢读取就自动重试或调用业务动作。新的控件不覆盖现有会话/模型/账号/批量功能样式。
- 复核未知私有提交时还补齐活 worker 的 summary 恢复：atomic checkpoint 证明数据已写但 ACK 丢失时，后续原成功读/事务只额外异步同步一次**私有全局摘要**，更新铃铛/当前列表，不重建 announcement。旧 scope 查询计数不冒充全局；线程已确认退出已有独立同步不重复。新存储代次/退出门禁继续有效，未知写不重放，业务不等待这次只读同步。

当前终态证据：`typecheck-team-compat-final.log`、`full-regression-team-compat-final.log`、`build-team-compat-final.log`、`dead-code-team-compat-final.log`、`node-team-compat-final.log`、`electron-team-compat-final.log`、`electron-worker-team-compat-final.log`、`electron-recovery-team-compat-final.log`、`electron-history-team-compat-final.log`、`electron-quit-team-compat-final.log`、`channel-smoke-team-compat-final.log`、`mcp-smoke-team-compat-final.log`。新隔离 fixture `verify-notification-team-observations.ts` 用真实业务 repositories/原记忆服务 + 最新真实编译通知 worker，生成两项竞争修订，证明原 accept 因前置状态变化照旧拒绝、通知不能越权、原 reject 提交后才收束；Fake installation 只读 status 证明 metadata supported 与能力 unsupported 分离、身份准确查询。No body/key/path persists。Fake 文件和桥不属于正式 Cursor，不宣称真机补丁或 OS 通知通过。

`team-observation-notifications`/`compatibility-notifications`/`team-memory-inspection`/`team-memory-inspection-ipc`、原 Memory/Group/installer/maintenance/IPC/native-open/source 等测试复核原异常/调用/返回与闸门、真实 repo 前置冲突、未知 ACK/缓存重用、同范围复核、MCP 读取入口、不同代次/安装、旧/新异步界面 intent、只读字段/无审核端点、人类已读与 pending 独立。记忆 readonly 对测试数据的原 review 属于 fixture 原业务验证，不是通知或 GUI 在真实项目执行审核。

真实产品组件仅在 mock browser：`ui/memory-inspection-light.jpg`、`ui/memory-inspection-dark-narrow.jpg`、`ui/compatibility-maintenance-dark.jpg`。查看/重读后中心仍有 1 个待处理、原提案仍 proposed；Escape 返回铃铛、inert 恢复；深色有效 CSS 视口约 615×492，modal 边界 20px、无横向溢出，正文滚动而 footer 保持可用。维护页同时说 release 3.21.12 supported 与当前能力未通过，切号开关保持原 gate 禁用。HMR 重挂载/重置 mock 未读计数后读取新 DOM 重验，不把旧 selector 超时当业务结果。Console clean；临时 viewport/theme/tab/server 都恢复/清理，`protected-team-compat-audit.json` 保持原两个开发根与四个外部预热漂移。未生产 main/真实 Cursor 请求、账号处理/退款/清理/付款、OS 通知、安装、push 或发布。

**完整目标仍未完成**：普通记忆提案的真实人工升级、跨 MCP 的写/审核失败结构化事实、组事务外副作用/权限变更失败与精确操作关联仍须接入；不能因有 topology 摘要或只读查看器就称这些完整完成。模型目录/用量/统计源持续缺失、原 native 修订号回退/数据库回滚的安全重基线、更多已接入来源的开始/跨重启未知与长序列压力、完整 UI/布局和正式打包/macOS/Windows 真通知权限/声音/勿扰仍未验收。尤其 native revision 下退目前按 stale 保守拒绝，不能把这个 gate 当“真实数据库回滚序列已验证”；后续必须用真实恢复序列复核。整套按原矩阵继续，不以本批绿测试缩小目标或发版。

### 第十四批：原生修订号回退与通知重核对

- 根因：业务库可以恢复到较早备份，而私有通知库仍保留较新历史。group/memory 的低 revision 拒绝会永久挡住真实当前数据；较新 task cancelled/done 也不能继续作为恢复后的当前阶段。没有让业务跟着通知回滚。
- 原 Control/Memory/Task 服务在已有读取、缓存验证及投影完成后提供 main-only owner/读序号，不加 renderer/MCP 字段、额外业务查询或 watcher。通知只接受当前选定原服务的增加序号；迟到旧 owner/序列和未验证旧快照不能授权重核对。观察者失败不重跑读取或吞原异常。
- 原读取序号与 native revision 分开。较新的已完成读取可以确认较低数据版本。内存有界跟踪 native 高水位/回退 episode，语义签名只纳入回退变化，不为正常进度、签到和心跳逐拍持久化。固定 from/to 保留到后续增长或未知 ACK 核对，不能把 101→40 改成 101→200。
- 各领域决定事实，小型纯 helper 只验证/比较 metadata。source checkpoint 与通知仍在私有 CAS 同事务；未知 ACK 从下一原读核对检查点，不重放提交。旧版无 read provenance 的来源仍不能只凭较小数字重置。
- 当前准确 workspace/run 中的组关系按本次原投影重核对，不称再次建组。较新历史里存在、当前较早数据没包含的组标 prior-data，不编造解散/删除/收尾；普通裁剪缺失不走此例外。
- 恢复后的 actionable 记忆冲突不被先前驳回、已读/清理掩盖，详情保留先前确认属于先前数据版本的说明。缺失旧事项只收束当前适用性，不称已采纳/驳回/删除。没有审核、重提、发送消息或 Agent 回执写入。
- Task 通知也按当前读取对齐：旧 cancelled→备份中的 queued 不是重新创建/执行；缺失较新任务标 prior-data，不自动取消。团队验收仍不是人工审批。各来源只有中心说明，不补播旧 toast/OS、不声明业务恢复成功。
- 旧对象分批核对，每批最多 99 项加同 episode 说明，pendingRebase 精确保留剩余身份；240 个组/记忆旧事项分三批且不修改传入 checkpoint。再次重启不生成另一份说明，容量/错误不截掉重要身份。

证据：`full-regression-native-rebase-final.log`、`build-native-rebase-final.log`、`dead-code-native-rebase-final.log`、`node-native-rebase-final.log`、`electron-native-rebase-final.log`、`electron-worker-native-rebase-final.log`、`electron-recovery-native-rebase-final.log`、`electron-team-native-rebase-final.log`、`electron-history-native-rebase-final.log`、`electron-quit-native-rebase-final.log`、`channel-smoke-native-rebase-final.log`、`mcp-smoke-native-rebase-final.log`。`scripts/verify-notification-native-rebase.ts` 使用真实隔离业务 repositories、原 VACUUM INTO 备份、旧服务/库关闭、业务文件恢复且保留通知库，再重建原服务和最新真实编译 worker；Node/macOS Electron 各核验旧 reject/clear→当前 conflict、cancelled→queued、新组/任务 missing→prior-data、再次重启去重、无 send/lease/review 回放。没有运行真正 updater 脚本或覆盖用户库。

`notification-native-rebase.test.ts` 覆盖旧 stamp 拒绝、原作用域、metadata 增长不增加提交、未落盘的内存高水位回退、240 对象批次/不可变 checkpoint、无效恢复指针、未知 ACK 后从实际 CAS 收敛且不重复说明。原 Control/Task/Memory/协议回归保留一次原读取只 load 一次、业务/Agent 结果不被通知改写的边界。

UI 只沿用原中心/只读查看器，隔离 `notifications=restore` mock 和 `ui/native-rebase-center-light.jpg` 明确 21→4、先前“已驳回”和当前待核对不同，仍可看原记忆；无恢复成功绿条、业务重试按钮或彩色左轨。Preview 不证明真实工作区/系统通知。`protected-native-rebase-audit.json` 保持两份原开发树和四个已知外部预热漂移。未 production main/Cursor/账号/模型/OS 动作、安装、push 或发布；fixture 与临时 UI 资源清理。

**完整目标仍未完成**：本批证明当前仍准确可定位的 workspace/run 的实际较低 native revision。整个旧作用域消失、相等 revision 不同内容（尤其活句柄/cache）、跨来源聚合与历史裁剪复杂序列仍需完成；session/question/reply/queue/operator 等其他来源在业务备份恢复后的关联还需逐项测试。普通记忆人工升级、结构化写/组副作用失败、模型/用量/统计源异常，以及完整矩阵/正式打包/Windows/macOS 真通知权限/声音/勿扰/全 UI 验收仍在范围内。无 blocker，不缩小或完成目标。

### 第十五批：原人工记忆请求与明确审核闭环

普通 proposed 条目不制造人工待办。只有原 `MemoryReviewCoordinator` 确实创建／去重返回了用户请求，才把原 messageId、createdAt 和 no-reviewer／timeout 原因送入同一记忆事项；原创建顺序、调用数和错误处理不变，观察失败不重做业务。泛化 notice 仍为安静动态，不重复产生人工未读。前置冲突优先，真实 accepted／rejected／superseded 或明确范围结束驱动收口。

人工请求证据不能仅靠相同条目 ID 跨越数据恢复。未确认读取、作用域离开／组缺失、原读取证明的较低 revision 都撤去本次有效证明；保存历史留作“原请求待核对”，不会谎称已经处理。重新读取本身不确认消息，仍需原协调器真实返回。相同请求在启动／去重／未知私有 ACK 后不补播、不重复未读；不同真实请求只更新同一事项的一次 requestEpoch 和原请求身份。原页只阅读对得上这次请求的通知，不能提前读掉另一条回执。

原查看器新增独立的“采纳…”／“驳回…”二次确认，查看、阅读、关闭都不会审核。trusted IPC 核对 exact workspace/run/group/item/version 和明确 confirmed，再且仅再调用一次原 `TeamMemoryService.review`。原事务锁内再次检查候选状态、版本与新人工 scope expectation，阻止锁前 peer 已审核／结束 run 后被迟到确认覆盖。锁内读取的结论只在 COMMIT 成功后返回；人工命令的后续展示读取失败不抹掉已知审核结论。已知结论与刷新待核对分开呈现；未知回执保留附言，要求显式重读、不自动重试。最终差异审查修正了 family 兼容问题：只有新的记忆操作追加 memoryId/version；旧账号、问卷等操作的关联散列保持原值，不让历史未知尝试失去后续核对关系。后续原快照才对齐事项现状，不把尝试结果或人类已读改成 Agent 回执。

视觉沿用原主题、字号和表面，不加彩色左轨或装饰胶囊。实测抓到确认区在短窗遮住动作的问题，改为单一正文／确认滚动区、固定操作 footer；长内容、附言与按钮不互相挤压。关闭已提交操作不撤回请求，迟到回执不重开弹层、不抢新页面焦点。无 canReview 或审核 API 时仍是只读查看器。

当前证据在实现树 `preview-screenshots/notification-implementation/`：`full-regression-operator-memory-final.log`、`typecheck-operator-memory-final.log`、`build-operator-memory-final.log`、`dead-code-operator-memory-final.log`、原 `mcp-smoke-operator-memory-final.log`／`channel-smoke-operator-memory-final.log`，以及 `node-team-operator-memory-final.log`／`electron-team-observations-operator-memory-final.log`、`node-native-operator-memory-final.log`／`electron-native-rebase-operator-memory-final.log`。其余真实编译 worker／退出恢复／保留／排空／上下文隔离脚本也在本批重新执行。真实 trusted IPC＋原 repositories、锁前 peer 竞态、源恢复／未知 ACK、二次确认／输入保留／晚到焦点／精确阅读均有当前测试。VACUUM 备份恢复验证原提案还在而较新的人工请求不存在时不冒用旧证据、不运行协调器／审核；随后另行调用原协调器返回的新请求只更新同一事项一次。脚本不是 production main，也没有覆盖用户库。

`ui/operator-memory-confirm-light.jpg`、`ui/operator-memory-confirm-dark-short.jpg`、`ui/operator-memory-reviewed-dark-short.jpg`、`ui/operator-memory-unknown-dark-short.jpg`、`ui/operator-memory-partial-dark-short.jpg` 和 `ui/operator-memory-ui-audit.json` 记录真实产品组件的隔离 mock 验收。短窗有效 CSS viewport 约 400×323，确认／取消／重新读取均可达，无横向溢出；Tab 不逃出模态、Escape 回铃铛。修改时的过渡 HMR scope 不一致单独留在日志，最终整页重载再核对当前控制台；不以 HMR 旧 DOM 或旧异常代替当前验收。Browser preview 不证明真实业务、完整应用或系统通知。`protected-operator-memory-audit.json` 保持原两个开发目录及四个既有外部预热漂移。

**完整目标仍未完成**：人工记忆请求这一点已接入闭环，其余结构化 MCP 写／组副作用诊断、模型／用量／统计源健康、整个旧 scope 消失与相等 revision 异内容、其他 feed 的恢复关联、长期容量与完整序列、正式包／完整应用及 Windows/macOS 真权限／声音／勿扰验收仍须逐项完成。本批不安装、重启 Cursor、处理真实账号、push 或发版；完整通知目标继续 active，不能把本批通过称为整套完成。

### 第十六批：原组操作后续结果诊断

建组、加人、移出、主控、目标、规划策略、迁移、解散这八类原操作接入 post-return 观察。记录关系仓储已经返回与后续步骤是否确有回执，不能仅凭关系快照成功推断全部副作用完成。原服务仍按同一顺序、参数和次数运行，没有新业务查询、等待、重试或回滚。观察接收数据而非业务 thunk；通知异常不进入原 onerror，原 onerror 若抛出仍按原位置中断。读展示失败保留原异常与已经返回的关系事实，不假称原事务未发生。

实测修正了原出组说明的一个错误：任务释放／待回应消息收尾抛错后回退空数组，会被错误描述为“没有任务”。现在区分真正返回空数组、绑定未确认未调用、调用没返回确认；失败路径不再向主控伪报无任务或已停止催办。原成功正文、消息数量、令牌、代次、目标选择和释放逻辑均保留。

私有 CAS 保存原实例、操作身份、范围、结构化步骤与有界进度。正常完成不写成功历史；普通设置也不会因此刷中心。已保存开始但没有最终回执的旧实例只恢复为待核对，不补播、不执行协调器或原操作。该阶段不能证明任何没有保存的步骤，也不声称崩溃后逐步无损恢复。迁移的副作用警告归入既有身份／队列父提醒，真正核验父提醒落盘且原身份／范围一致才安静化独立诊断；没有落盘证明不会静默吞掉提醒。排队／原协作记录返回不是 Agent 阅读，交接回复也不能证明任务释放已确认。队列检查点用有界摘要而非复制完整目标列表。

运行页沿用原卡片，只加一条“先前的组后续事项待核对”，默认折叠，详细事实自行展开；原页精确可见时不重复全局提醒。一次私有 run 范围查询＋版本化推送，无新业务轮询，不因消息到达刷新整个会话树。迁移原结果页也区分角色写入和未确认的通知／收尾；没有回执不再保证下一次轮询一定收到。无彩色左轨、装饰胶囊或通知重跑按钮。阅读不解决原任务或改 Agent 回执。

本批证据位于实现树 preview-screenshots/notification-implementation：full-regression-group-effects-final.log、typecheck-group-effects-final.log、build-group-effects-final.log、dead-code-group-effects-final.log、node-group-effects-final.log／electron-group-effects-group-effects-final.log，及 mcp-smoke-group-effects-final.log／channel-smoke-group-effects-final.log。原真实编译 worker、退出恢复、保留、排空、原 native 备份恢复及上下文隔离脚本同时回归。实际隔离 repositories＋原服务测试检查发送／读取次数、拒绝写的零 post-return 观察、读取中断、失败仍继续其他副作用、observer／logger 隔离、不同原实例恢复、未知私有 ACK、迁移父关联、队列晚到和当前 UI 读取／作用域。真实 Node/macOS Electron built-worker fixture 验证原角色改动仍生效、发送次数不变、真未确认回执、一份未读、无目标／原错误进入通知，无任何模型／账号／Cursor 调用。

ui/group-effects-compact-light.jpg、ui/group-effects-details-light.jpg、ui/group-effects-details-dark-narrow.jpg 是真实产品组件的 mock UI；深色有效 CSS viewport 400×323，入口和文字换行正常，局部 clientWidth=scrollWidth，无横向溢出。阅读后未读收口但原记录内容仍保留。临时样板／视口／主题／标签已恢复并关闭；构造失败的九个自有临时 fixture 也已精确清理，之后成功与异常路径均会清理。

**完整目标仍未完成**：这里只证明桌面原组仓储返回后的观察，不把所有 MCP 写入失败宣称接入。事务返回前的未知结果、结构化 MCP 写诊断、模型／用量／统计源健康、旧 scope 消失／同 revision 异内容、其他 feeds 恢复、长期容量／全序列、正式应用／打包与 Windows/macOS 真通知权限／声音／勿扰仍需后续完成。未 production main、实际账号处理、Cursor 重启、OS 送达、安装、推送或发布。本批是本地提交，不缩小或结束完整目标。

### 第十七批：原 MCP 写入回执与低打扰阅读

本批接入五类原生 `team_task`／`team_review`／`team_message`／`team_memory`／`team_run` 写动作的已有返回结果。仅在原 `toolFailure` 捕获到可靠机器错误码时追加 `sgWriteFailure` 小型提示；普通参数／领域／角色拒绝不升级，未分类内部错误安静记录。原 `code`、`message`、`isError`、`nextAction`、健康返回、工具定义、工具数、调用顺序和重试语义保留。主操作已有返回而协调／恢复／审计没有确认，记录为后续待核对，不冒充主操作失败，不引导重做。

归属同时检查当前工作区／run／席位／绑定代次、已安装 Composer、原参数通道及原结果 Agent 身份；旧安装时间之前的结果不算新绑定。原 MCP 回执不证明调用时的组关系，因此诊断只归精确安装会话，不把当前入组／移组关系写成过去的调用归属。只取原生终态工具和完整结构化 JSON，不从 shell、模型正文、恢复文本、截断结果或普通错误字符串推断写入。live→sealed→续作按原工具调用身份去重；另一调用后来成功不能把先前未知尝试伪改为成功。每次尝试保留不可变诊断，但同一原生回合的相同工具／动作／原因只首项需知晓，其余放入折叠的日常动态；后续真正新回合重新获得提醒机会，不对整段长会话永久静音。缺少稳定原生回合身份时采用安静保守的同源归类，不凭正文猜测新操作。启动、水合、休眠恢复不补播旧提醒。

复用原桌面／团队订阅和原私有 CAS 通道，不加业务查询、探测、timer 或网络请求。历史与实时提取缓存分离：新直播文字不重新扫描／序列化封口历史；未确认私有 ACK 仍在下一真实来源帧重读原私有检查点，不把提取缓存当落盘证明。每批至多 100 项，seen／提醒身份均有容量边界，超界明确报告历史缺口，不无声截断。

界面不换皮、不加彩色左轨或新标签。摘要只保留真正原因，撤掉逐条冗长解释。原工具展开输出实际可见时才确认人类阅读；折叠标题、输入、被裁剪区域、另一模态后的正文、旧 Composer／绑定都不算阅读。用原 JSON 形成阅读证据，再由既有 formatter 排版，避免错误正文的转义换行破坏机器识别。一个视口订阅、首次可见后一次私有未读查询＋推送，展开观察只响应相关标记，不跟随每个文本 token 查询。多项摘要仅在全部原结果可见时安静化，不能凭最后一项标题或空集合吞掉其他重要结果。

当前证据位于实现树 `preview-screenshots/notification-implementation/`：`full-regression-mcp-write-final.log`、`typecheck-mcp-write-final.log`、`build-mcp-write-final.log`、`dead-code-mcp-write-final.log`、原 `mcp-smoke-mcp-write-final.log`／`channel-smoke-mcp-write-final.log`。全回归 295 files，2816 passed，1 skipped。原服务＋真实 InMemory MCP client、真实 SQLite 写锁、原 hook VM 的 modern／legacy 结构、原角色闸门与原写入次数有集成证据；新 `node-mcp-writes-mcp-write-final.log`／`electron-mcp-writes-mcp-write-final.log` 使用实际编译 worker 验证全部链条。原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects 九类（含本批 mcp-writes）隔离脚本在 Node 和 macOS Electron 同时回归。没有启动 production main 或调用真实账号／模型／Cursor；每个自有 fixture 目录在 finally 精确清理。

`ui/mcp-write-center-light.jpg`、`ui/mcp-write-source-light.jpg`、`ui/mcp-write-details-dark-short.jpg`、`ui/mcp-write-ui-audit.json` 是真实产品组件的隔离 browser 样板。只展开过程标题仍 2 个未读，看到原输出才变为 1，中心阅读后原未知诊断仍保留；原来源导航只展开正确 CH／原工具，不执行业务。短窗 CSS 400×323，通知浮层 clientWidth=scrollWidth=374，边界和滚动 footer 留在视口；Escape 回铃铛。此处不把软件最小窗口之外的顶栏命中、完整应用布局或真实 OS 送达列为已验收。HMR／窗口缩放后的过期控件先重读当前 DOM，最终重载日志无 warn/error；`ui/mcp-write-ui-cleanup.json` 以 DOM 确认视口和 system 外观恢复，自建标签／5207 样板服务清理。保护核对 `protected-mcp-write-audit.json` 保持原两个开发树及四个既有外部预热漂移。

**完整目标仍未完成**：本批不覆盖 MCP runtime 创建／参数校验前无结构化归属的异常，也不把被截断或被旧格式净化破坏的历史输出猜成真实回执。源页阅读当前使用私有未读窗口，更早大历史的精确阅读覆盖仍需容量复核；通知中心记录不因此丢弃。模型／用量／统计来源健康、旧 scope 整体消失／同 revision 异内容、其他 feeds 恢复、长期完整序列、正式应用／包及 Windows/macOS 真权限／声音／勿扰仍继续实施。仅本地提交，不推送、发版、安装、重启当前软件或 Cursor，不缩小或结束完整通知目标。

### 第十八批：本机用量记录的真实保存／读取诊断

沿原 `CursorUsageStore.load/save` 接入只读结果观察。首次缺文件是正常空状态，不当故障；原文件读取／解析或结构异常、原加载跳过无法验证的行分别留下真实未确认说明。保留原 load 返回、兼容版本、有效行、留档行为／次数、MAX_SESSIONS 和价格／计数逻辑；不新增读盘、写盘、备份、重试或恢复操作。错误观察在原 save 返回／抛出之后，不改变原异常对象；通知 observer／缺口处理抛错也不会让健康文件被误留档。后续保存成功只证明新保存已有返回，不恢复或清除先前历史读取缺口，空统计不冒充历史为零。

同一写入故障收为一条持久 episode，不随着 800ms 用量写入或 Token 增长刷未读；真实新原因／恢复后的新失败可更新或另开对应 episode。每次有意义的正文用独立事件身份，旧正文可见／旧阅读确认不消费新原因。正常保存不增加成功历史，恢复不额外全局弹成功。原 tracker 继续使用原通知节流、计数、封口、最后 persist，内存数值可用不冒充已保存。真实退出时把该 source 的 seal 延到原同步 dispose persist 之后，收下原最后一次失败结果，再排空私有队列；退出不弹通知，不多写一次业务文件。

统计页只增加舒适的两类局部折叠说明，原图表／查询／模型和用量计算不换皮、不增加业务请求；活跃页各一次私有查询＋推送，隐藏页不订阅计数更新。没有问题时不占版面；有读取异常的空页也能看说明。中性空文案改为“暂无可展示的用量”，不妄断从未使用；“实付”改为“估算”，避免把参考成本当官方账单。保留当前主题／字号，使用中性边界与充分留白，没有左彩边、渐变胶囊、修复／重试按钮或高频进度。

真实 CUA 验收发现 Chromium 可能对闭合 `<details>` 中未绘制的正文仍返回非零几何，不能用单测的零高度替代浏览器。共用可见性判断现在核对闭合 details、直接 summary、自身与祖先隐藏状态；原读取助手捕获真实 toggle 而非新 poll。原组后续说明的阅读标记也从整块卡片移到正文，折叠标题不提前读完。旧不正确单测的“闭合即阅读”断言改为展开真实正文才读，并以非零闭合几何保留回归。

证据在当前实现树 `preview-screenshots/notification-implementation/`：`full-regression-usage-storage-final.log`（298 files，2828 passed，1 skipped）、`typecheck-usage-storage-final.log`、`build-usage-storage-final.log`、`dead-code-usage-storage-final.log`，原 `mcp-smoke-usage-storage-final.log`／`channel-smoke-usage-storage-final.log`。`node-usage-storage-usage-storage-final.log`／`electron-usage-storage-usage-storage-final.log` 用真实编译 worker＋原 store／tracker 验证真文件写失败、内存值不变、真实留档、跨重启、历史缺口不伪恢复、最后 persist 一次和退出无弹出；原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes 隔离脚本亦在 Node 与 macOS Electron 回归。

`ui/usage-storage-collapsed-light.jpg`／`usage-storage-expanded-light.jpg`／`usage-storage-dark-narrow.jpg`／`usage-storage-recovered-dark.jpg` 和 `usage-storage-ui-audit.json` 是 mock preload 的真实产品组件：默认两个说明折叠仍 2 个未读，展开一项正文后仅变 1；新保存恢复时写入提醒安静收束，历史说明仍保留。深色 CSS 615×497，局部 clientWidth=scrollWidth=580；不以软件最小窗口之外的整体顶栏／设置布局冒充正式验收。`usage-storage-ui-cleanup.json` 确认 system 外观与正常视口恢复；自建标签／5207 服务及所有自有 fixture 均精确清理。`protected-usage-storage-audit.json` 保持两份原开发树及四个既有外部预热漂移。

**完整目标仍未完成**：本批证明本机用量文件的已有读写结果，不把估算、正常长会话尚无精确回合结算当作源故障，不宣称模型目录／原生用量入口／统计所有健康接入已做完。未确认历史不由通知自动修复。模型目录／原生统计数据来源、旧 scope 消失／同 revision 异内容、其他 feeds 的恢复关联、长期容量／全序列、正式应用／包和真实 Windows/macOS 权限／声音／勿扰仍须继续。未 production main、真实账号或模型、Cursor 重启、OS 送达、安装、推送或发布，完整目标保持 active。

### 第十九批：模型目录来源的真实读取诊断与跨页面局部说明

本批只观察原 `CursorComposerTelemetryReader` 的原目录读取结果，不加查询、轮询、计时器、模型请求或重试。目录缺库／未生成／只有保存的选择（包括 Auto），仍是安静等待；新目录迁移缺失、空数组或部分写入时仍保留原兼容返回。兼容目录可用不等于原来源已恢复；明确的读取异常、无效记录及原 64 MiB 大小保护分别保留窄诊断。无原始 JSON、模型名、路径或凭据进入历史，也不据此宣称会话停止、额度耗尽或账单异常。原 models、profile、root 和查询／解析回退语义保持不变，通知观察与缺口处理抛错不能改变原返回。

只在原读取连续报告同类异常、至少两帧且跨度至少 5 秒时形成 incident。重复心跳不刷条、不增加未读；真正的新原因更新同一 episode，真实目录恢复才安静收口，恢复后的新故障另开 episode。数据库未变的工作区快照缓存不当第二次读取证据；同钟重复、时钟回退、超过 60 秒采样缺口、休眠／唤醒都不外推持续故障。复用原 power 订阅清 tentative 候选与静音基线，没有唤醒探测或新的业务等待。

两轮审查补了原目录缓存的 health 依赖：`ownCatalogEnabled` 单独变化、原 applicationUser 和 catalog 原文未变时，不能把旧 ready 用作新来源的恢复证据。只重算 metadata，保持原模型／profile／root 引用且不重新 JSON.parse。已保存但隐藏、禁用或超出原解析窗口的选中模型，也不冒充可用目录的证明；明确坏条目与正常空目录分开。

将统计说明提取为只接受 `usage-storage | model-catalog` 的小型 `LocalSourceNotice`，保留 `UsageStorageNotice` API。Cursor 维护页只有真实异常时出现一处中性折叠说明，正常不占版面；仍使用现有主题、字号和留白，不加左彩轨、装饰脉冲、渐变胶囊或重试按钮。维护／统计的隐藏子页不订阅，活跃页私有查询＋推送与原业务查询独立。更换来源时不显示或阅读旧来源正文；迟到旧 pull、空／归档／清理结果、私有历史重载后的较低 revision 都按私有 ledger 处理，不伪报业务来源恢复。重载使旧正文阅读观察器失效。

第三轮复核发现真实 ledger 的阅读／归档只增加 summary revision，不增加正文 revision。局部说明现在同时比较这两个版本，真实归档可立即移除说明，旧页面回包不能复活它。只读实际展开且有焦点、可见的对应正文；折叠标题不清未读，阅读、归档和真实来源恢复仍是独立动作。这项修补也覆盖统计说明，没有另起一套状态机。

证据位于当前实现树 `preview-screenshots/notification-implementation/`：`full-regression-model-catalog-final.log`（300 files，2847 passed，1 skipped）、`typecheck-model-catalog-final.log`、`build-model-catalog-final.log`、`dead-code-model-catalog-final.log`，原 `mcp-smoke-model-catalog-final.log`／`channel-smoke-model-catalog-final.log`。原查询数量、返回引用、真实 SQLite 形态、模型迁移、observer 隔离、持久 episode／新原因、旧 ACK 未知结果、power 接线及局部说明的重载／归档／阅读均有回归。

`scripts/verify-notification-model-catalog.ts` 用真实编译通知 worker＋原 reader＋自有 Cursor-shaped SQLite 验证缺库／selected-only 安静、连续失败、gate-only 不伪恢复、跨重启关联、阅读不等于恢复、真实独立目录恢复、休眠及退出不补弹。Node 和 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 均通过；原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage 十类隔离脚本也在两个 runtime 回归。所有 fixture 在 finally 精确清理，没有 production main、真实账号／模型请求或 Cursor 重启。

`ui/model-catalog-center-light.jpg`、`model-catalog-maintenance-light.jpg`、`model-catalog-expanded-light.jpg`、`model-catalog-dark-at-minimum.jpg`、`model-catalog-recovered-dark.jpg`、`model-catalog-archived-dark.jpg`、`model-catalog-short-center-dark.jpg` 与 `model-catalog-final-light-at-minimum.jpg` 是 mock preload＋真实 domain reducer＋产品组件的 CUA 验收，不是手拼“已完成”图。`model-catalog-ui-audit.json` 证明折叠仍 1 个未读、展开正文才读、真实恢复安静收束、同正文版本的归档不残留局部说明，四边同色且局部 clientWidth=scrollWidth。CSS 1440×769 复核原软件最小宽度；CSS 554×477／400×346 只用于局部说明和短窗中心边界，不冒充软件最小窗口以外的整体布局已验收。短窗中心 374px、两侧至少 12px，footer 在视口；Escape 回铃铛。`model-catalog-ui-cleanup.json` 确认跟随系统、正常视口恢复及当前页面无 warn/error；自建标签与 5207 服务已关闭。

`protected-model-catalog-audit.json` 按原基线逐文件与 `git diff --binary` 核对两份受保护开发树，HEAD、status、diff 与所有文件状态一致。原 SG-Team 的四个 session-warmup 删除状态原样保留；null 基线明确表示已删除，不把它误报成新改动。未 reset／stash／clean、未写入原开发树。

**完整目标仍未完成**：本批只完成本机模型目录这一来源，不将正常长会话无 exact 结算当作异常，也不宣称所有原生用量／统计入口的健康观察已完成。MCP runtime／校验前无归属异常、旧 scope 整体消失／同 revision 异内容、其他 feeds 恢复关联、更早大历史精确阅读及长期容量／完整序列、正式应用／打包与真实 Windows/macOS 权限／声音／勿扰／系统送达仍须继续。继续遵循跨页面的四层反馈：覆盖事实但不把每页、每次刷新都变成弹条；当前位置就地呈现，离开后再按重要性升级，普通活动默认静默。本批只本地提交，不推送、发布、安装或结束完整目标。

### 第二十批：原生运行时用量补位入口的只读诊断

沿原 `inspectComposerRuntime` 的原 fetch／窗口选择／evaluate／内存读取路径接入小型 sideband 和可选 observer。没有新 CDP 调用、模型请求、读盘、业务快照查询、轮询、重试或等待；未改 Cursor 文件或写后 hook。原返回的 liveness、process、usage、数值归一、采样／结算／价格和 tracker 顺序保持不变，sideband 不进入原 runtime evidence 或其 fingerprint。原读取异常仍按原规则返回或抛出原异常；通知的 begin、complete、诊断解析、缺口处理异常都与原结果隔离。诊断关闭／无法归属时不额外解析 sideband。

没有调试目标、服务未就绪、未加载／旧 sideband、空行、只有零值、没有 generation 或正常长会话没有精确回合结算都安静等待，不制造故障。只捕获原读取本身的异常和明确无法验证的返回结构。恢复必须覆盖原请求的全部已确认绑定 Composer，实际原归一结果带可归属的正计数，且原计数满足安全整数／非负／缓存子集约束；空对象或“ready”标签不是恢复证据。这个判断只控制通知，不回写、拒收或重算原业务计数。可用估算采样也能确认补位入口读到计数，但不能冒充 exact 结算或官方账单。

用既有初始 team 快照与既有 run-context 订阅回调缓存归属，不再 getSnapshot。监测指纹包含工作区身份／路径、run、原最多 16 个请求 Composer，以及实际绑定身份／代次；纯角色名称和同一范围的普通 revision 更新不取消在途读取。只接收原请求的完整准确集合；未知、重复、部分、外部路径请求不会强挂到当前范围。范围变化、休眠、诊断缺口、畸形 team 帧、较新回执已完成、退出后都隔离旧回执。复制／恢复后相同工作区 ID 但不同路径，也不能拿新路径健康读数关闭原异常。

仍由连续原失败帧（至少两次且至少 5 秒）形成一条 episode，无新 timer。同钟 echo、时钟回退／无效时钟、超过 60 秒的缺口不外推持续失败；常规反复失败不刷未读。新原因更新同条正文，同一真实范围可归属读数才安静收口。scope 消失／run 停监测只说明原监测未确认，原问题不算恢复或会话死亡；首次空快照也不留假“当前仍在监测”。回到同一未确认范围不会在尚无读取证据时杜撰新事故。私有 ACK 未知结果在下一真实读取恢复关联，不重跑业务或补播旧提醒。

统计页新增一处 `LocalSourceNotice`，有问题才占位，默认折叠，正常图表、质量说明、筛选和统计计算不改。文案用“用量补位读数尚未确认”表达有限事实，而不是把当前等待读数一直叫作“持续报错”；技术来源留在中心与展开正文。说明复用中性四边边界，没有彩色左边、装饰点或动态进度。当前页就地呈现、离页按原策略进中心；隐藏统计页不订阅，不以折叠标题清未读。共用说明正文改用已有 `--text-soft` 提高通透背景上的可读性，字号及整体视觉系统不另造一套。

证据在 `preview-screenshots/notification-implementation/`：`full-regression-runtime-usage-final.log`（301 files，2857 passed，1 skipped）、`typecheck-runtime-usage-final.log`、`build-runtime-usage-final.log`、`dead-code-runtime-usage-final.log`，原 `mcp-smoke-runtime-usage-final.log`／`channel-smoke-runtime-usage-final.log`。原有 creator／usage pipeline 与新归属、Clock、迟到、空／正常估算、异常隔离、准确正文阅读测试一起回归；原业务返回和调用次数与无 observer 的原路径逐项比较，不用“绿测试”代替源行为检查。

`scripts/verify-notification-runtime-usage.ts` 在 Node 与 macOS Electron（`ELECTRON_RUN_AS_NODE=1`）使用真实编译通知 worker，原 runtime 表达式在 VM 中执行、原 reader／tracker／usage store 实际串联。真实原 getter 异常保留原 active liveness 和已有数值，后续原精确结算仍正常覆盖估算、保存；每个原读取仍只有原 fetch＋原窗口探针＋原 evaluate，私有通知排空没有增加一次原调用。跨 worker 重启、同 episode、读通知不算源恢复、新原因在真实退出排空、无 quit announcement 和无原始错误／模型／计数身份／路径均验证。原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog 十一类也在两个 runtime 回归。自有 fixture 全部 finally 精确清理，未接触真实账号、模型、Cursor 或 production main。

`ui/runtime-usage-stats-final-light.jpg`／`runtime-usage-stats-final-expanded-light.jpg`、`runtime-usage-stats-dark-collapsed.jpg`、`runtime-usage-recovered-dark.jpg`、`runtime-usage-scope-change-center-dark.jpg`／`runtime-usage-center-final-dark.jpg` 和 `runtime-usage-ui-audit.json` 使用真实产品组件＋mock preload＋真实领域 reducer。折叠保留未读、展开正文才阅读；真正读取确认与变更范围均安静收束局部说明，但中心明确保留不同事实。来源动作从会话页准确到统计，不操作模型或账号。CSS 1440×769 复核原最小宽度，CSS 615×500 只作局部折行压力测试，不把最小窗口之外的整体导航布局冒充通过。局部 clientWidth=scrollWidth、字号 14px、两侧同色边界已核对；`runtime-usage-ui-cleanup.json` 确认跟随系统、正常视口与无 warn/error，自建标签与 5207 服务关闭。`protected-runtime-usage-audit.json` 证明两份保护树 HEAD／status／binary diff／文件全部一致，原四个 warmup 删除状态保留。

**完整目标仍未完成**：本批是原生运行时补位读取这一入口，不将它代替 SQLite context 来源，也未声称写后 usage binding 的全部结构诊断、原统计所有数据源或真实额度／账单核对已完成。第二十一批的接线复核确认：当前主进程没有传入 `contextUsageSink`，不能把原注释所称的 SQLite 用量采样当成已参与统计的事实。下批继续审原 SQLite 上下文读取和 binding 的原有缺口，区分正常缺字段、旧版兼容和真实读取失败，仍不增加业务探测。MCP runtime／校验前无归属异常、其他 feed 的旧 scope 消失／同 revision 异内容／恢复关联、大历史准确阅读、长期容量及完整序列、正式包和真实 Windows/macOS 权限／声音／勿扰／系统送达仍按完整矩阵推进。仅本地提交，不推送、发布、安装或结束完整目标。

### 第二十一批：SQLite 上下文详情读取的真实来源诊断

复核原链路而不是沿注释推断：`DesktopSessionService.forwardContextUsageSamples` 只在注入 `contextUsageSink` 时执行，当前 main 构造只传入运行时用量 sink，没有传入这个 SQLite 采样 sink。因此本批不擅自接通新的入账通道、不改变数值和持久化次数；前文“主要 SQLite 统计采样已接通”的暗示已更正。此次观察的是当前已用于会话上下文详情与兼容配置的原 `readComposerPersistentDetails`，不能由其健康证明实时 Token／Cost 或精确账单已经正确。

原 SQL、查询集合、顺序、一次 prepare／逐 Composer get、model profile／context maps、增强失败后头部／全局回退均保持不变。只在原缓存 miss 的工作区读取接收观察；同一缓存快照即使经过很久也不是第二次原读取。无文件、未生成头部、空／零／缺字段、原查询未含当前绑定都等待。`cursorDiskKV` 的可选表／列在 prepare 阶段出现 SQLite schema 错误时不能分辨具体兼容状态，明确安静等待，不解析错误文案或新查 schema。实际 row 读取／JSON 验证异常与 BUSY／LOCKED 等真实读取失败才形成窄诊断；不记录原错误、JSON、路径、模型或数值身份。

确认健康只使用原 routine 真正返回的全部已绑定正上下文读数。头部旧指标、另外的 Composer、另外的路径／绑定、运行时用量入口健康、缺表或空记录都不关闭此来源的 episode。原循环可以在后续未绑定坏行中止：若全部绑定原 maps 已真实返回，保留这项证明；若先遇到坏行没有到达绑定，不为通知另查一遍来补证明。原 projection 未能返回时也不提前宣布成功；后续非详情处理异常仅保持待读取，不伪报详情读盘失败。恢复使用原 SQL／JSON 中已读到的有效安全整数与范围，原 display 取整／夹断后的值不算源证明，复用原已解析对象，不多 JSON.parse。target getter／observer／缺口处理／诊断错误码 getter 的异常均隔离，不改变原结果或原 fallback。

沿第二十批归属与生命周期传输复用一个有限的 `ScopedLocalReadNotifications`，仅公开 runtime／context 两个封装，分别使用不同 source key、prefix、事件和检查点。没有复制一套计时／持久化／scope 状态机，也不是允许任意插件字符串的通用框架。实际 team 原帧、路径／绑定指纹、5 秒连续失败证据、60 秒缺口、休眠、迟到、私有 ACK 未知与真实退出规则共用；普通角色变化不使原读取失效。上下文 scope 不套运行时的 16 个请求截断，仍以该原 routine 的实际绑定集合确认。

中心来源为“Cursor · 本机上下文详情”，导航本机维护而不是谎称统计页发生了计费故障。维护页有异常才出现一处默认折叠说明；提示保留当前可能仍看到旧／兼容指标的事实，阅读不等于恢复，不切号、不修补、不清数据、不加重试。四边中性细线、原主题字号和足够留白延续，正常状态不增加常驻条或日常未读。

当前证据：`full-regression-context-source-final.log`（302 files，2865 passed，1 skipped）、`typecheck-context-source-final.log`、`build-context-source-final.log`、`dead-code-context-source-final.log`、原 `mcp-smoke-context-source-final.log`／`channel-smoke-context-source-final.log`；原 telemetry、native runtime、model、public return／SQL 次数／引用、真实坏 JSON、两种头部形态、缺表／列、原部分 maps、缓存、独立来源及精确展开阅读一起回归。`context-source-final-audit-review.log` 另覆盖原显示取整／夹断与后续非详情 projection 异常的边界。首轮两个 fixture 断言错误已按原规则纠正：原头部没有 percent 不造 context 对象；七字符 ID 不在原安全 ID 范围，不能假设它进 SQL 循环。没有为了过测试改变原业务解析或 ID 规则。

`scripts/verify-notification-context-source.ts` 使用真实编译 worker＋原 reader＋Cursor-shaped SQLite，在 Node 与 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 验证真实 malformed JSON／独占读锁、原 available fallback 不变、缓存不是失败持续证据、缺表／零不伪恢复、有效详情返回、读通知不等于恢复、跨 worker 重启／新原因／退出无弹出，fixture 在 finally 精确清理。原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage 十二类也在两个 runtime 回归；没有 production main、真实 Cursor、账号、模型或 OS 通知。

`ui/context-source-collapsed-light.jpg`／`context-source-expanded-light.jpg`、`context-source-dark-narrow.jpg`、`context-source-recovered-dark.jpg`、`context-source-scope-change-center-dark.jpg`、`context-source-final-light.jpg` 与 `context-source-ui-audit.json` 是真实组件＋mock preload＋领域 reducer；折叠仍未读，实际正文展开才确认；恢复与 scope 变更在中心保留不同事实。CSS 1440×769 按原软件最小宽度核对，CSS 615×500 只作局部压力，clientWidth=scrollWidth、14px 文字与两侧同色边界已确认。`context-source-ui-cleanup.json` 确认跟随系统、正常视口、无 warn/error；自建标签与 5207 服务关闭。`protected-context-source-audit.json` 保持两保护树 HEAD／status／binary diff／逐文件，原四个 warmup 删除状态未动。

**完整目标仍未完成**：本批不补接 SQLite 统计 sink、不宣称所有源接通。写后 usage binding 的结构／回调诊断、主统计接线的范围核对仍须继续，不因本批元数据就改动计费；无可靠归属的 MCP runtime／校验前异常、其他 feed 的 scope 消失／同 revision 异内容／恢复关联、准确大历史阅读、长期容量与完整事件矩阵、正式包及真实 Windows/macOS 权限／声音／勿扰／送达仍需按原目标做完。仅本地提交，不推送、发布、安装或结束完整目标。

下面保留完整要求，不因分批已有成果缩小。已实现部分仍需匹配该项范围验收；未实现部分继续开工。

1. 通知中心、轻量顶栏入口、单张提醒和独立 renderer store。支持待处理／未读／全部、查询范围、分页、详情、关闭、阅读、归档、确认清理和适当偏好；减少动画、长内容、键盘与窄窗需验收。
2. 初始读取与实时推送的版本合并；来源页面与实体可见性；展示队列、失焦／悬停暂停、过期成功不补播、原页与全局不双弹。
3. 会话最终投影的首次上线／疑似失联／确认离线／恢复／新代次／正常停止。完善启动水合、作用域变化、休眠和观察器故障门禁；异常 episode 持久关联，不能只比较 online。
4. 批量创建混合结果、复用现有会话、提交与真正就绪分开；和自动化并行关系按实际源事实关联。
5. 自动化稳定 attempt 和结构化步骤／警告／并行支线结果。只新增可观察信息，不重写顺序；取消、仅处理、收尾超时和迟到回执不能伪报全成功或全回滚。
6. 八个设置子页及运行、会话、右栏、交接／模型等弹层的来源归属与重要结果接入。保留复制、参数、扫描、统计和普通页面反馈的低打扰策略；不新增余额查询或预检。
7. 问卷／审批、回复与队列、任务验收、组消息、成员及上下文交接。用户未读和 Agent 回执独立；历史源游标及崩溃恢复证据仍要补，不编造内存阶段。
8. 有限白名单动作导航、当前实体与代次验证、过期动作说明，不跳错同 CH 或悄悄切换工作区。高风险操作保留原入口和确认。
9. macOS／Windows 系统通知、用户控制的类别／声音／正文预览／勿扰，后台正常完成和重要故障均覆盖；系统与应用内不双弹。真正退出时不声称后台继续监听。
10. 第十一批已接入有界自动保留和独立历史说明确认，第十批已验证真实退出恢复；重要/未读保留、长期容量及正式环境仍需匹配完整范围复核。
11. 逐项执行设计文档的事件序列验收和真实组件视觉验证、原流程回归；正式打包环境及 Windows 边界验收。只有所有范围有当前证据后才能宣布整套完成。

当前 preview 已提供 sample / long / many / toast、结构化自动化结果以及 human 协作消息场景，使用产品组件和领域映射，不接真实账号。正式主进程已接入软件更新、会话生命周期、具体重启意图、批量发起、自动化步骤结果、独立处理／清理、冷热切换以及第五批的消息／问卷／任务来源；其他重要跨页面来源、长期容量及系统送达实机仍未完成。每个剩余要求仍需逐源接入与验收，不能将完整目标勾为完成。
