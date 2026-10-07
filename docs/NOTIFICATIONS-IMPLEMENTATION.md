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

### 第二十二批：写后用量 binding 的原接收／回调诊断

只观察原 `__sgTeamUsage` 消费器已有的解析、分桶和回调结果。没有改页面 hook 表达式／版本、增加 Runtime binding／CDP 命令、读盘、模型请求、轮询或回调重试。原 `onUsageEvent`／`onUsageSample` 调用次数、参数、丢弃规则、旧补丁兼容、tracker 入账／计价／持久化保持原样。通知不会把回调同步返回当作已入账或已落盘，也不会重放原计数。观察器 begin／完成／私有确认／诊断错误都不能破坏原 write-signal／process／usage 通道。

归属使用原已有 executionContextCreated／Cleared／Destroyed 事件、原 hook 验证状态、当前 socket 和原 team 订阅帧，不加页面探针。只用当前主世界上下文中、实际当前成员和仓储一致的完整绑定身份；旧 socket 已由原围栏隔离，旧／未确认／已销毁执行上下文不喂通知，原业务消费仍按原规则。文档重载／销毁、绑定／Agent 身份／工作区变更、休眠／恢复、真实退出分别围住迟到通知回执，不能用新范围的健康载荷宣布旧范围已恢复。单纯唤醒只清候选与旧回执，不伪造文档变化；若原文档确实仍在，同一受影响绑定的真实新载荷可安静收口原 episode。进入未连接期后仅重试文案变化不再产生新的文档代次或反复私有检查点写入，原状态回调仍保持原规则。

现代载荷的可归属正计数、原接收回调返回才是本入口恢复证据；零值、缺 generation 的旧事件、正常没有精确回合结算和未知扩展形态安静等待，不造故障，也不清已有问题。已确认当前绑定的真实结构异常或原回调异常，要在至少两次原消费、跨度至少 5 秒后才进入通知；同钟 echo、时钟回退／超长采样缺口不外推连续失败。坏 JSON／无归属异常最多留下同文档一次私有证据缺口，不猜 CH、不复制原文或弹假“计费失败”。

多个成员异常合并为同范围一条 episode 和一处局部说明，正文列出已验证 CH 及窄原因，不制造每成员一条顶栏弹条。同一故障不随高频数据增长刷未读；新成员／新原因有对应新正文。每个受影响身份独立收口，一个健康成员不能消除其他成员问题。部分恢复安静更新同条；只有全部当前受影响来源返回才能收束，而“接收确认”依然不保证统计已校准或存储已成功。128 个已知身份的投影保留全量受影响集合，展示在原 4000 字限制内节制截取并明确剩余数量；此测试不是完整长期容量验收。

二次审查修了私有恢复确认竞态：不能收到一帧 good 就把内存恢复观察移除，因为私有通知可能尚未落盘、或已经落盘但丢 ACK。共用 transport 只新增可选的 `onProjected` 回调，仅在真实 applied 或恢复到可验证的无变化 durable 状态时调用；失败／冲突不调用，回调自身异常也不失效已确认检查点。接收源用对应失败身份和确认标记释放观察，晚到的旧 ready ACK 不能抹掉后续已确认新故障。只有下一真实原载荷才能重核私有未知结果，没有 timer／业务重试。确认恢复后的正常帧不再触发私有查询／提交，高频正常数据只做内存判定，避免为通知造落盘流水账。

统计页仅在真实异常时显示一条默认折叠的中性说明，局部使用实际 workspace／run 归属，来源导航仍只打开统计，不修补、换号、付款或切 Cursor 工作区。不同来源的标签放回有限静态配置，未加入长串条件文案或新的样式系统。共用准确正文阅读保持折叠不读、展开且可见才读，阅读、归档、原接收恢复与统计实际恢复分开。

证据位于 `preview-screenshots/notification-implementation/`：`full-regression-usage-binding-final.log`（303 files，2880 passed，1 skipped）、`typecheck-usage-binding-final.log`、`build-usage-binding-final.log`、`dead-code-usage-binding-final.log`；原 `mcp-smoke-usage-binding-final.log`／`channel-smoke-usage-binding-final.log`。原 observer 和 usage pipeline 回归，加上 source／transport／UI 的正常帧无额外写读、原调用参数／次数与命令序列相等、两成员独立收口、真实 callback throw 不重试、私有 ACK 未知／晚 ready、新绑定／旧上下文隔离等测试。最后归属 fixture 修正了 structuredClone 保留成员／仓储共享引用的事实，真正构造二者不一致，未改业务测试替身来躲过归属围栏。

`scripts/verify-notification-usage-binding.ts` 在 Node 与 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 串联真实编译私有 worker、原 CursorStreamObserver 接收器、原 tracker／store，仅 socket 是不联网的 fixture。真实无效载荷不多调回调、不改变原统计；真实回调 throw 每原帧只调用一次；两个故障聚成一条，只有分别恢复才收束；跨 worker／文档重启保留旧问题的未监测事实，退出排空不弹通知。原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source 十三类亦在两个 runtime 回归。各自有目录 finally 精确清理，不运行生产 main、真实 Cursor／账号／模型或系统送达。

`ui/usage-binding-final-light.jpg`／`usage-binding-final-expanded-light.jpg`、`usage-binding-dark-narrow.jpg`、`usage-binding-partial-dark.jpg`、`usage-binding-recovered-dark.jpg`、`usage-binding-scope-change-center-dark.jpg`／`usage-binding-center-dark.jpg` 及 `usage-binding-ui-audit.json` 是真实组件＋mock preload＋实际 reducer。两成员仅一处折叠说明／一个未读，展开才阅读；部分恢复仍有剩余成员、全部恢复与文档变更分别收口而保留不同历史事实。中心动作从会话页正确定位统计，不产生业务操作。CSS 1440×769 复核原最小宽度、615×500 只作局部压力；局部 clientWidth=scrollWidth、14px 正文、两侧同色边界保持，窄窗以外的整体应用导航不冒充本批通过。`usage-binding-ui-cleanup.json` 确认跟随系统／正常视口恢复和无页面 warn/error，自建标签及 5207 服务关闭。`protected-usage-binding-audit.json` 保留两个保护树的 HEAD／status／binary diff／文件和原四个 warmup 删除状态。

**完整目标仍未完成**：本批是收到 binding 之后的原消费器，不证明页面 nativeUsagePayload 在抛异常但尚未发出任何载荷时都已可观察，也不以无事件推出统计故障。SQLite 计费 sink 当前未接入的事实不改，不能把这些健康元数据冒充统计精度修复。接下来按完整矩阵继续审 source 恢复（旧 scope 整体消失／同 revision 异内容和其他 feeds）、大历史准确阅读及长期完整序列、无可靠归属的 MCP runtime／校验前诊断、正式包和真实 Windows/macOS 权限／声音／勿扰／系统送达。单批通过不缩小或结束目标；本批只本地提交，不推送、发布或安装。

### 第二十三批：共用私有检查点的存储代次恢复围栏

复核发现跨来源共有的实际缺口：worker 退出并恢复到较早私有库后，renderer 的 historyReload 会刷新中心，但 `NotificationProjectionSource` 仍可能保留旧 CAS state／committed signature。下一原来源帧内容相同会被去重跳过，原私有投影无法重新对齐；已在途的旧读取或确认也不应成为新库的证明。这不是原业务来源恢复或计费问题，不能由通知重读业务来修。

沿原 repository 生命周期增加 main-only `sourceStorageEpoch()` 内存读取，不加 IPC、网络、SQL、timer 或业务观察订阅。存储 loss 才失效来源缓存；首次 ready 是初始化，不虚报第一笔读取未知。loss 后已经接受的新读取可能等待 replacement ready，这个 ready 不重复换代、误杀属于新 worker 的有效请求；未经过 unavailable 的真实新 generation 也能失效旧请求。原 marker／偏好／中心恢复规则保持，sourceState 和 commitSource 的旧代次回执只留未确认结果，不写 marker、不播旧 record／announcement、不向生产者调用成功投影确认。

共用 transport 在下一个原来源事实进入时比较这个轻量代次，清私有 cached state／committed signature、静音重建基线。它只读实际私有 checkpoint，原业务快照／请求／控制流程不加一次读取或重试；正常同内容帧恢复后仍去重。已在途与已排队原事实保持原顺序，不拿旧 current 的签名吞掉已经进入的新代次同内容帧。每次 private await 后检查代次：旧 value 或 applied 标记不会种回缓存或释放第二十二批的恢复观察。未声明此元数据的旧／测试 port 保留既有契约，没有新增可选配置框架。

证据在 `preview-screenshots/notification-implementation/`：`full-regression-source-epoch-final.log`（303 files，2887 passed，1 skipped）、`typecheck-source-epoch-final.log`、`build-source-epoch-final.log`、`dead-code-source-epoch-final.log`，原 `mcp-smoke-source-epoch-final.log`／`channel-smoke-source-epoch-final.log`。跨两 source 的同内容重投影、没有新来源帧就不重放、旧慢 read 不吞新帧、旧 applied ACK 无 marker／record／announcement、首次初始化／replacement readiness 边界和恢复后的稳定去重均有回归。没有只以 formatter 或 manifest 绿灯代替实际存储恢复。

`scripts/verify-notification-source-epoch.ts` 通过真实当前编译 worker：在同一保留来源对象中写私有阶段 0、保存真实早期 SQLite 备份，再原帧投影到阶段 1。确认旧 SQLite worker 实际退出后，仅替换 fixture 的私有库及自有 WAL／SHM，原 bounded worker 恢复。当前 checkpoint 真回到阶段 0；同内容的下一真实帧重新读取 private CAS 投影为阶段 1，不补播系统提醒；后续 300 个相同原帧不多私有请求。Node 与 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 均通过，fake native port 没有调用真实 OS；这里没有 business 查询／写事务、Cursor、账号、模型或 production main。各自有临时目录 finally 精确清理。

原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding 十四类亦在两个 runtime 复跑，配合旧失 ACK／退出恢复证明不会引入原业务重放。`protected-source-epoch-audit.json` 保持两保护树 HEAD／status／binary diff／逐文件与四个既有 warmup 删除状态。本批没有改 UI 或打开生产应用，不把上批 browser 样板当本批正式 OS／全 UI 验收。

**完整目标仍未完成**：本批只是 private storage 代次恢复，不能代替 native 业务库的同 revision 异内容／整个旧 scope 消失。审查已定位原组／记忆适配器的 revision-only 事实缓存和原 TeamControlService 的业务缓存边界；后续必须只用真实原读取证明，不能为通知悄悄多查业务库或用缓存数据假装完整实读。其他 feeds 恢复关联、较早大历史准确阅读／长期完整事件序列、无可靠归属 MCP runtime／校验前问题、页面 usage extractor 尚无载荷时的诊断、正式包及真实 Windows/macOS 权限／声音／勿扰／系统送达仍须继续。仅本地提交，不推送、发布、安装或结束完整目标。

### 第二十四批：原组／记忆／任务的同修订号内容矛盾核对

原适配器的 revision-only memo 会忽略同修订号的实际新返回内容，不能以“counter 没变”证明 facts 没变。本批沿原已返回快照做有限薄字段内容指纹，只把哈希放入 main-only read evidence／私有 checkpoint；不复制原正文／文件／凭据、不多 native SQL 或发起业务查询／操作。组关系区分原成员／角色／lead／planPolicy 字段和 runtime-only 的 effective lead：后者可更新安静关系摘要，却不作为 native 数据恢复证据。记忆只捕获每次原返回的薄 item 元数据，派生 facts 保持复用；原测试的“相同 revision 就不访问 item”错误前提改为每原帧一次薄字段核对，没有放宽私有重写或额外原读取次数。

在选定原 service owner 和递增真实 read stamp 下，相同 native revision 但原通知相关内容指纹不同会换核对代次。checkpoint 同时记已验证指纹，跨原 service 重启也可核对相同 counter 的不同实际返回；旧 checkpoint 没有指纹时不臆造 checksum。无 owner／stale stamp 不授权此 rebase；仍比较实际 legacy facts 的 memo，不让它们在相同 revision 下永远被旧缓存遮住。读数或时间变化不进指纹。记忆先前 operator proof 在已确认数据换代时撤销，不借旧 ID／版本推测原请求仍适用。

相同修订的源变化沿原分批 CAS 对齐，不回放创建、审核、取消、租约或 Agent 回执，不宣布业务“恢复完成”；缺少原条目的旧提醒只说明属于先前数据投影，不猜完成／删除。summary 文案明确“相同修订号下的数据已变化”，不把 5→5 叫作较早版本。重核 fact 事件身份包含实际核对代次；同状态但不同失败原因不能被 status-only compare 丢弃，看到／读过旧正文的确认不能消费新正文。正常后续原读取复用 facts 和私有去重，不增成功流水账或补播旧提醒。

证据为 `full-regression-native-content-final.log`（304 files，2891 passed，1 skipped）、`typecheck-native-content-final.log`、`build-native-content-final.log`、`dead-code-native-content-final.log`，原 `mcp-smoke-native-content-final.log`／`channel-smoke-native-content-final.log`。实际 SQLite 不改 counter 的 row 变化、live memory／task 原返回、ordered topology 原返回／runtime-only lead、same-state 新原因／exact event 阅读、缺条目、正常帧复用和 legacy 兼容一起回归。fixture 遵守原 bridge 接口及原 clientProposalId／source label 校验，不为测试修改业务解析规则。

`scripts/verify-notification-native-content.ts` 在 Node／macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 用真实编译 private worker＋原三种 service／repository 验证。隔离业务库仅由 fixture 构造同 counter 的数据分支，原通知逻辑不写业务。mem／task 当前原读取能核对；组的原 service 热 revision cache 仍返回旧数据时，明确断言通知没有假装看见新关系。原 service 关闭并按原构造重新读取后，实际等 revision 新关系才更新私有投影。无旧提示补播，原正文不进入 checkpoint，旧条目缺失不伪报终态；自有目录 finally 精确清理。原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding／source-epoch 十五类亦在两个 runtime 回归。本批不调用实际 Cursor／账号／模型／OS 通知或 production main。

`ui/native-content-center-light.jpg`／`native-content-expanded-light.jpg`／`native-content-dark-narrow.jpg`／`native-content-final-light.jpg` 和 `native-content-ui-audit.json` 使用真实 domain reducer＋mock preload＋产品组件。same 5→5 文案不承诺恢复成功，普通关系事实放折叠日常动态，中心只计一个需阅读摘要；进入中心／看到标题不读，实际展开正文才读。CSS 1440×769 复核原最小宽度，615×500 只作通知中心局部压力；面板 clientWidth=scrollWidth=438，footer／边界在视口，Escape 回入口，不把整个窄应用设计当通过。`native-content-ui-cleanup.json` 确认跟随系统／正常视口及无页面 warn/error，自建标签和 5207 服务关闭。两份保护树仍与基线一致，见 `protected-native-content-audit.json`。

**完整目标仍未完成**：本批不能凭通知指纹穿透原 TeamControlService 的 revision cache。其原热句柄在业务 counter 与内容都被外部替换但仍相同 revision 时的原缓存、整个旧 workspace/run 消失与其他 feeds 恢复，必须继续用真实原读取核对；不得偷偷为通知加业务轮询或 fake 一个完整源读取。原 task 适配器读取 scope 的既有 getTeam 冗余、页面无 binding 载荷时的诊断、MCP runtime／校验前无法归属、准确大历史阅读／完整序列和长期容量、正式包及真实 Windows/macOS 权限／声音／勿扰／送达继续按完整范围推进。仅本地提交，不推送、发版、安装或结束目标。

### 第二十五批：任务通知复用原读取上下文，去掉第二次团队查询

第二十四批复核定位的冗余已收掉：原 `TaskPoolService.getSnapshot` 依次 load task pool、读取 active scope；通知适配器此前随后再调用 getTeam，触发另一个团队投影／遥测，既多读取又会使一次任务事实和后来的 scope 混配。本批保留原 pool→scope 顺序，把原 scope 的 workspace／run／scopeRevision／runStatus 作为 main-only 薄 context 捎带给原 read observation，不把它写入公开 TaskPoolSnapshot 或新增 renderer IPC。TeamControl 的原 loadState 只执行一次，新增的 runStatus 来自同一原 state，不多数据库查询。没有新增业务请求／写事务／订阅／轮询。

只在原选定 owner、递增 stamp、相同 scopeRevision／workspace／run 时使用 context；当前明确 completed 的原状态才能走完成规则，成功空 scope 不冒充 run 结束。不匹配或畸形 context 留私有缺口，不回退到另一时刻的新团队读取。旧 provider 没有 original context 的既有 fallback 契约保留，但正式 TaskPoolService＋TeamControl 接线不再依赖它。observer context 构造及订阅者异常不影响原公开读取，thin context 冻结而不修改原 snapshot，不读取原模型／任务正文或凭据。

证据：`full-regression-task-context-final.log`（305 files，2895 passed，1 skipped）、`typecheck-task-context-final.log`、`build-task-context-final.log`、`dead-code-task-context-final.log`，原 `mcp-smoke-task-context-final.log`／`channel-smoke-task-context-final.log`。`tests/task-notification-context.test.ts` 核对真实 repository/service 每原任务读取恰好一个 task load＋一个 active scope，零第二次 TeamControl getSnapshot／runtime 查询；原顺序、冻结 metadata、抛错隔离、empty／stale／mismatch 与旧 provider 一起覆盖。`scripts/verify-notification-task-context.ts` 在 Node 和 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 串联原 task/control 仓储服务＋真实当前编译 private worker，原取消／已结束 scope 正常观察，30 个原读取没有额外团队投影，自有目录 finally 精确清理。

原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding／source-epoch／native-content 十六类也在两个 runtime 复跑。`protected-task-context-audit.json` 保留两个保护树 HEAD／status／binary diff／逐文件和原四个 warmup 删除状态。未启动 production main、当前软件或 Cursor，未调用实际账号／模型／系统通知；本批不改 UI，不把旧 screenshot 当本批正式环境证明。

**完整目标仍未完成**：同 revision 内容差异的原团队热缓存、整个旧 scope 消失与其他 feeds 恢复、大历史准确阅读与长期序列、页面未发 usage 载荷的诊断／MCP 校验前未知、正式包与 Windows/macOS 真权限／声音／勿扰／送达继续按完整矩阵核对。仅本地提交，不推送、发布、安装或结束目标。

### 第二十六批：原团队热缓存使用同连接的真实变化标识

第二十四批留下的原业务热缓存已补上：原 `TeamControlService.loadState` 只比较 team revision，真实等 revision 的外部数据变化会长期不可见。现在沿原那一次 revision／full-load meta SQL 捎带 `data_version` 与 `total_changes()`，不另发 PRAGMA 查询；repository 的 `lastReadVersion` 只是被冻结的内存 lookup，不把这个标识写入业务 schema、native revision、公开 TeamControlSnapshot 或 renderer IPC。SQLite 的 `data_version` 只在同连接内比较，可观察其他连接提交；本连接变化由 `total_changes` 补位。参照 [SQLite data_version](https://www.sqlite.org/pragma.html#pragma_data_version)、[SQLite total_changes](https://www.sqlite.org/c3ref/total_changes.html)，不把跨连接数值比较或这个标识当成备份／恢复原因证明。

稳定数据仍每原 loadState 只有原一次轻量 SQL、复用同一缓存；实际变化标识改变后才执行原全量读取。必须说明成本边界：这是共享原业务库的连接标识，并非只对 topology 的 dirty flag；其他表提交也可造成一次保守 cache miss／原全读，但不因此产生“组已变化／已恢复”通知，通知仍比较实际原 facts。没有扫描目录、加轮询／计时器、触发器／migration、native 写入／API 重试或并行预检。原正常版本变化同样正确失效，旧 repository 可省略只读标识保持旧契约。

full-load 标识在原 meta 查询时、装配 rows 之前捕获；后续并发变化不会被标成这次旧缓存的已观察状态。缓存记录与最后已经 emit 的记录分开：原 active-scope 查询先刷新了缓存时，原 watcher 仍会把等 revision 新快照送给正常消费者，不能因为 cache 被另一个原读取更新就跳过 UI／源更新。原 reload 抛错不覆盖缓存 proof；下一成功原读取仍需重新读取。未知／不可靠 metadata 不作为 cache-hit 证据，也不让 metadata 失败改变原已加载数据返回。没有在当前用户软件上替换活数据库文件，热文件系统强制替换不是本批证明的安全操作。

证据：`full-regression-team-cache-final.log`（306 files，2900 passed，1 skipped）、`typecheck-team-cache-final.log`、`build-team-cache-final.log`、`dead-code-team-cache-final.log`，原 `mcp-smoke-team-cache-final.log`／`channel-smoke-team-cache-final.log`。`tests/team-control-cache-version.test.ts` 以真实原 SQLite 热句柄验证稳定每次原一次 revision、纯内存 witness、外部等 revision change 的一次原 reload、本连接变化、无关表提交不弹 topology 警报、原 watcher 在 scope 已读后仍 emit、错误读数不伪确认和 schema=9 不变。第二十四批 native-content verifier 更新为实际热读取可见，不再永久断言旧缓存缺陷；当前 mem/task/group 源核对继续一致。

`scripts/verify-notification-team-cache.ts` 在 Node 与 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 用真实编译 private worker＋原 service/repository，100 个稳定原读取恰好 100 个原 revision 查询、零全量重载，witness getter 不执行查询；外部真实等 counter 提交后原热缓存确实重读，后续稳定仍复用。原 watcher 到时真实 emit 新关系而非用 verifier timeout 冒充已发送；无关表数据／原 schema 保留，fixture finally 精确清理。原 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding／source-epoch／native-content／task-context 十七类亦在两个 runtime 复跑。`protected-team-cache-audit.json` 保留两保护树 HEAD／status／binary diff／文件与四个既有删除状态。

**完整目标仍未完成**：本批使原完整数据读取可到达，不等于整个旧 workspace/run 消失的通知关联已全部收口，也不能把 current scope 缺席视为已取消／删除／完成。后续继续处理跨进程保留的旧 scope 通知和其他 feeds；准确大历史阅读／长期完整事件序列、页面未发出 usage 载荷及 MCP 校验前不可归属问题、正式包和真实 Windows/macOS 权限／声音／勿扰／送达仍须完成。本批没有改 UI、打开生产 main／当前软件／Cursor、调用实际账号／模型／OS 送达，不能把先前概念样板当作热缓存实机验收；只本地提交，不推送／发布／安装或结束目标。

### 第二十七批：从原完整目录核对跨重启的旧范围，不猜业务终态

本批补上 group topology／memory issues／task notifications 三类原来源的完整 workspace/run 缺席关联。`TeamControlService` 从同一次已完成的原完整 state 捎带冻结的工作区／运行身份目录，main-only，不进入公开 snapshot 或 renderer IPC，不额外查询业务库或 runtime。适配器只接受所选原 owner 的递增读取 stamp，并核对目录与同次 snapshot 的完整身份集合；缺 metadata、错 owner、迟到帧、裁剪或孤立 run 都不能授权失效。工作区切换、无 activeRun、停止监测、run 仍在目录但已 completed，都不是“整个原范围消失”。

已确认缺席的旧提醒静音改为 `scope-unconfirmed`／expired，去掉旧导航入口并撤销旧 memory operator proof；原任务状态、提案状态和组事实保留，不猜任务完成／取消、提案已采纳／驳回、会话停止或数据删除。保持原阅读／归档事实，不续未读、不复活已清理的记录，也不制造从未发出的 stock group 通知。目录中的范围重新出现本身不能恢复 memory/task 结果；必须各自匹配的下一次当前原读取确认。重新核对有新的私有事件身份，但不重放旧 success、不声明备份恢复成功，不重做任务、审核、Agent 回执或原请求。

私有 worker 增加固定三种 prefix 的薄目录查询，keyset 每页最多 100，仅返回 key/revision/原 scope，不跨 RPC 搬运全部 source payload，不暴露 renderer 查询入口。每个缺席 episode 的行进度也用短 keyset cursor，不复制数千条 remaining identity 挤占 2 MiB checkpoint 上限；写入仍每批最多 100 个 draft，和进度同一 CAS。未知 ACK 保留可能已提交的实际进度，只在下一真实目录帧重读私有 checkpoint 后继续，没有定时重放或业务 retry。旧 row scope／精确已有 group 记录可在 hash 身份一致时补证；完全清理或只有 hydration 的旧 group checkpoint 无可验证 scope 时不猜当前工作区，等待它自己的原读取。一个不可验证的旧行不会饿死其他已知范围，损坏数据保留并报告历史缺口。成本如实说明：目录变化／私有存储代次后的历史核对会产生独立 private RPC、marker 查读和薄字段 CPU 工作；不是零开销，但原稳定业务读取没有附加业务 SQL、等待、timer 或网络请求。

私有外部 CAS 发出前即失效 producer 的该 key cache；已返回但迟到的旧 read／成功 ACK 不能重新种回旧 cache 或放行旧 projected callback。确定的本机 checkpoint 失效可从真实私有结果重新核对同一已接受事实，不冒充未知写成功；修复基线只消费自己所在代次，不吞随后真实变化，也不跨 wake/storage 代次消费新的静音基线。目录改变、休眠、存储代次、dispose 会围住异步旧核对，唤醒等下一真实原读取，close 排空已接受工作。仍沿原退出 barrier，不延长原退出超时。

容量测试额外揪出并修复了原 task rebase 的真进度漏洞：`pendingRebase` 存在时相同的已处理任务会每批重新输出，超过 100 个 present facts 将永远挤占下一批。现在只在新 observed dataset 开始时标记其 present rows，已处理行清掉 priorData，后续批次能推进；231 条在更新的 native revision 下完整收口，legacy 缺 native counter 也不产生 NaN。范围回来了但实体本次完整原读取仍缺席时，旧 scope-unknown 说明换成 prior-data，依然不推任何业务终态。另一个全套回归暴露的是旧 usage-binding fixture 把两个顺序调用的默认 Date.now 强行要求同一毫秒；现在只冻结该测试的时钟，保持 callback 参数与 CDP 命令的完整等值断言，不改原生产 parser/时间语义或忽略字段。

证据：`full-regression-native-scope-final.log`（307 files，2913 passed，1 skipped）、`typecheck-native-scope-final.log`、`build-native-scope-final.log`、`dead-code-native-scope-final.log`，原 `mcp-smoke-native-scope-final.log`／`channel-smoke-native-scope-final.log`。`tests/notification-native-scope.test.ts` 覆盖完整／切换／completed／stale／clipped、205 个历史 keyset scopes、231 行未知第二批 ACK 后续接、清理不复活、休眠／close、私有代次、legacy 与坏行隔离、旧 proof 撤销、真实源重现及多批原读取；`tests/notification-projection-source.test.ts` 加入迟到 read/ACK、cache 和后续基线围栏。`scripts/verify-notification-native-scope.ts` 在 Node 与 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 用当前编译 private worker＋真实原 SQLite/service：关闭自有原句柄后恢复自有早期 fixture，旧范围确实从完整原库消失且 private 历史跨重启保留；原范围重现后 memory/task 各自读取才重新确认。100 个稳定原读取仍恰好 100 次原 revision，零追加 reload/原团队再读，真实原任务／提案状态不被通知改写，原正文不进入通知。

十九类 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding／source-epoch／native-content／task-context／team-cache／native-scope 在两个 runtime 复跑，见 `native-scope-verification-final-matrix.log`。`protected-native-scope-audit.json` 以与基线相同的 status 模式核对两个保护树 HEAD／status／binary diff／逐文件及四个既有删除状态；fixtures finally 只清理自己的临时目录。没有启动 production main／当前软件／Cursor、调用实际账号／模型／系统通知，本批无 UI/CSS 改动，不拿旧预览或隔离 worker 当正式包实机送达证明。

**完整目标仍未完成**：本批范围是上述三类原完整 workspace/run feeds，不将其他 session／问卷／消息／队列等历史恢复、未知来源、整个长期容量、正式打包与 Windows/macOS 真权限／声音／勿扰／系统送达一起冒充完成。后续仍按完整矩阵继续。只本地提交，不 push／发布／安装，不结束目标。

### 第二十八批：原协作消息读取、紧凑身份和可续接的历史核对

本批处理上一批明确留下的 operator-message feed，而非把其他消息／会话来源一并宣布完成。原 `TeamCollaborationService.getSnapshot` 现在从原那一次 TeamControl 读取和原那一次 `loadRun` 捎带 main-only context／owner／递增 stamp；原先的读取顺序、返回 snapshot、创建／回复／已读／响应回执、watcher 间隔和业务 SQL 不变。production 通知订阅改为原读取证据，不再订阅后另读 `notificationRuntime.currentTeam` 或重新查询 TeamControl；旧无 observation 的 provider 保留既有契约。订阅者异常不能改变原结果，原读取失败也不以空消息替代，不做额外业务 query／等待／探针／重试。

只有已验证的当前完整 run/operator 读取才可核对缺席。错 owner、迟到 stamp、不同 run、group-clipped 快照、重复／不完整 message identity 集合不授权旧消息失效；切换工作区或原组不可见不等于原消息已撤回。比较原已返回的 ID／kind／sender slot／thread／group／创建时刻／thread subject 薄字段，sender role label 是展示 metadata，不是 native dataset restore 证据；原正文和 Agent receipts 不被通知 adapter 读取或拷入 checkpoint，不能把薄字段指纹描述成完整正文校验。同 counter 实际薄字段变化／较早原版本会静音重新核对；消息本次完整读取缺席则记为 prior-data／expired，保留原组范围及 activity 重要性，移除旧导航，不猜用户已回复、Agent 已读或原消息已删除。新的 native kind/subject 有新的事件身份，但安静重核不凭空续一次用户需求；notice 的原阅读版本、归档和清理事实保留。

scope catalogue 已加入 `operator-messages:`。完整原 workspace/run 消失可跨重启静音失效旧协作通知；原目录重现仅证明范围存在，不恢复消息结果，必须下一次原 collaboration read 确认。旧 v1 seen-only checkpoint 可从精确 private record 的原 scope 验证，不从当前页面猜身份；private archived record 也参与核对，已清理或自动保留移除的记录不造出来。原格式 ID 在不同来源 scope 下保存／返回时，已验证的当前记录使用单条实际 private record 的更高版本，而不被另一个来源较高 counter 永久吞掉；A/B/A 再入 scope 会安静重新核对，过期老范围不会覆盖已经属于其他原范围的记录。

私有 worker 新增一个固定 operator-message key、最多 100 个的 exact metadata 读取，含 archived 但不含通知／业务正文，不开放 renderer 任意查询接口。域 reducer 仍是纯通知投影；异步的 private metadata 核对由 source durability transport 围住，原同步 reducer 不被强制插入 Promise 等待。private storage 代次、确定的 checkpoint 失效、关闭、休眠／唤醒不能被迟到 async reduction 或 ACK 跨过；静音重算也适用于已经落下的 unfinished batch，不在 wake 后补弹。close 排空已接受事实并解绑自己的 power/read 订阅，沿用原退出 barrier／timeout，不延长退出，也没有新业务 watcher 或原数据轮询。

持久 v2 索引保留 v1 全部身份，不存 50,000 条冗余 row metadata／正文或 remaining ID 副本。针对原 `team-message:UUID` 使用明确、无损的公共前缀编码，任意 legacy ID 原样保留；两个 runtime 的真实 private worker RPC 已存下、读回 50,000 个**原格式的合成身份**，小于既有 2 MiB 上限，不是读取／投递了 50,000 条真实业务消息。分批进度只存短 keyset cursor，cursor 必须指向已保存的原身份；未知 ACK 重读实际 private checkpoint 后才续接，不自动重跑业务。50,000 身份容量需要至多 500 个 100-draft 批次，所以只为本 feed 显式设置 512 批有界 transport guard；其他来源仍是原 64 批，不取消无进度／超界保护。6,501 身份的纯 transport 验证能从同一个已接受 frame 连续推进 66 批，无第二次原读取；231 条真实 original SQLite 消息＋worker 路径和未知第二批 ACK 测试验证落盘／续接，均不是所有 50,000 业务事项的正式环境性能验收。任意 legacy 长 ID、超过容量、损坏或源／private 不可用仍报告历史缺口，不偷偷淘汰重要身份。

正常新增／变更使用**已确认 private projection** 的有界内存薄签名增量，只在 durable previous signature 对得上时生效；未知 ACK、换库／owner／scope、重启或优化 cache 淘汰则回到完整 private 核对。231 个原消息里增加一条只提交那一条，原 receipt-only revision 和 100 次稳定原读取不改通知记录／checkpoint。成本如实说明：每个真实 original message read 仍需原薄字段 CPU 提取、摘要和签名；reentry／历史恢复需 private metadata RPC 和有界 CAS 分批，不是零开销或无限容量承诺。private 核对不与业务库共用写锁，不增加原团队／消息 SQL 或业务等待。

证据：`full-regression-operator-read-final.log`（308 files，2928 passed，1 skipped）、`typecheck-operator-read-final.log`、`build-operator-read-final.log`、`dead-code-operator-read-final.log`。`tests/operator-message-read-notifications.test.ts` 覆盖原正文／receipt getter 不触碰、current scope/context 不二读、stale／clipped／incomplete、同 counter 薄字段差异、label 非 native rebase、准确原组／归档／activity／清理、已确认增量、未知 ACK、睡眠解绑、50,000 身份无损大小、6,501 身份续批、A/B/A 版本及真实原 SQLite 读取顺序和回执保持。共享 source transport 加入真实 async reduction 的 wake/storage 代次围栏测试。

`scripts/verify-notification-operator-reads.ts` 在 Node 与 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 使用当前编译 private worker＋原 collaboration/control SQLite/service：231 条原消息完整恢复、稳定 100 次原读取恰好各 100 个原 team/message read、原 counters 相同时实际 kind/subject 变化可见、缺原消息不猜 responded/deleted、原 scope 冷恢复跨重启且只由 specific read 重新确认、用户读版本／Agent receipts 分离、原正文不复制、历史提醒不重放，以及单独的 private ID 容量证明。二十类 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding／source-epoch／native-content／task-context／team-cache／native-scope／operator-reads 在两个 runtime 复跑，见 `operator-read-verification-final-matrix.log`；原通信冒烟 `mcp-smoke-operator-read-final.log`／`channel-smoke-operator-read-final.log`，保护核对 `protected-operator-read-audit.json`。初始 verifier 误把读取前的 readRevision=0 当成已读回执；已改为核对真实 `owner.read` 返回的确认，不靠忽略字段通过。

本批无 UI/CSS 变更、没有启动 production main／当前软件／Cursor、运行真实账号或模型／OS 送达；自己的 fixture finally 精确清理，两个保护树及四个既有删除状态不变。仅本地提交，不 push／发布／安装。**完整目标仍未完成**：会话／问卷／回复／队列等剩余 feed 的历史与未知恢复、准确大历史阅读及整套长期容量／性能、未发 usage 载荷或 MCP 校验前不可归属诊断、正式包和 Windows/macOS 真权限／声音／勿扰／送达仍要继续逐项核验，不拿这一批绿色结果替代完整事件矩阵。

### 第二十九批：稳定的来源阅读分页、有界确认和真实回执匹配

本批修复原 source reader 只查询第一页的实缺口：MCP viewport 只读最多 100 个候选，reply 只读每 entry 的 5 个候选，其他精确来源也没有续页；匹配的当前结果在后页时永远漏读。直接套中心 offset 不成立：每次人类已读会推进全局 revision，并从 unread 集合移除一行，原 offset 会反复 reset／跳过剩余记录。现在仅 private `getNotificationPage` 增加独立的 `readCursor` keyset 模式，以不受阅读回执移动的 record.revision＋id 倒序，第一次读取冻结 revision ceiling；读回执／归档不会倒改 cursor，ceiling 后的新结果仍由先订阅的 push 流处理。两个分页模式互斥、校验严格，普通中心 offset/reset、筛选范围、全部已读／清理及原业务请求不被重写。私有计数回退返回 reset，不能把旧代次阅读缓存接进新的历史。

来源 helper 仍只在前台、实物元素可见、原身份与结果 predicate 匹配时确认单条；不是进入整个 route／会话就标全读。跨 page 检索没有任意 first-N 截断；只有 DOM 中已经展示的精确结果能读，候选、确认、attempt cache 有界，单 viewport 最多 4 个 read RPC、128 个排队项，并在下一最多 100-record 页之前留足空间，避免挤爆现有 worker 的 64-request 容量。空间等待仅在 private 异步 transport，未要求原操作／读取／布局等通知落盘，不加业务 timer／poll／balance／CDP 或预检。新可见 marker／focus／resize／scroll／真实 push 可触发再核对，未变的可见结果不在每个滚动事件重查 IPC；失败的阅读仍未读，不用自动重试回路假造已确认。旧 page、旧回执、historyReload、scope cleanup、隐藏／modal 覆盖都有 epoch／可见性围栏；同正文 revision 的读版本／归档只合并单调回执，不让迟到 pull 复活旧未读。reply 复用这一 viewport transport，去掉了重复的一套分页／pending／订阅实现，没有改原 conversation entries 或 Agent 回执。

审查还发现“相同 block＋相同 unconfirmed status”不够证明同一原 MCP 错误。当前新诊断带有 bounded、白名单的原结构化 receipt proof（tool/action/channel/原 actor/status/reason/entity），原 ProcessTurnView 只从已有原 JSON 生成同样的 DOM 身份，不从格式化后文案猜故障。不同 reason、actor、entity 即使 status 相同也不能消费旧提醒；已返回成功不作为过去未确认失败的阅读证明。没有拷贝完整工具原文、发模型或改原 MCP 结果。分组 toast 的原页抑制同样核对这个身份，抑制本身不是人类／Agent 已读回执。旧 persisted MCP 诊断没有 proof 时**不猜测自动补证／阅读**；用户仍可在中心显式阅读旧摘要，后续可靠的旧 proof 迁移／原结果恢复关联仍需继续。这不是已经把所有 legacy feed 收口。

证据：`full-regression-source-read-final.log`（310 files，2940 passed，1 skipped）、`typecheck-source-read-final.log`、`build-source-read-final.log`、`dead-code-source-read-final.log`。`tests/notification-read-keyset.test.ts` 核对 431 条在 unread 收缩／全局 read revision 增加时 12 页无 reset/漏行、冻结 ceiling、新 attention 不被旧读消费、counter rewind／非法 cursor，以及中心原 offset 契约保持。`tests/source-read-history.test.ts` 在真实私有 SQLite＋独立 DOM fixture 中核对后于第 100 条的唯一可见结果只读一条、431 个确实匹配结果完整确认且峰值 4 RPC、modal 覆盖、迟到旧读跨低 counter 历史恢复、卸载、无进度 cursor 停止。真实 reply／native MCP／原结果 hook 的 React tests 加上更细原 proof、旧诊断不可猜读；旧 toast fixture 先前只写 block/status，没有原 proof，现加准确同 proof，保留“全部结果实际可见才抑制且不写 read”的原断言，不放宽为仅 header 即通过。

`scripts/verify-notification-source-reading.ts` 在 Node／macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 用当前编译 private worker：431 个私有 fixture 诊断经真实 RPC 分 12 页准确读回、读字段跨事务单调、proof 持久、不重放 announcement、不用 backend script 冒充看到了 renderer。二十一类 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding／source-epoch／native-content／task-context／team-cache／native-scope／operator-reads／source-reading 在两 runtime 均复跑，见 `source-read-verification-final-matrix.log`，原 `mcp-smoke-source-read-final.log`／`channel-smoke-source-read-final.log`。

真实 CUA 只打开本地纯 browser `notifications=source-history` fixture，用产品 ProcessTurnCard 和 reader：两个原输出排在 230 个较新未展示诊断之后。只展开过程 header 时仍 232 未读；实际展开原 memory 输出后为 231，中心仍明确列出其余 231 未读，另一个 task 输出未展开，没有全页误清。`ui/source-history-native-read.jpg`／`ui/source-history-231-unread.jpg` 和 `ui/source-history-audit.json` 保存实际 `<pre>` 身份／计数证据，console warning/error 为 []。工具请求的临时 viewport 为 1440×860，UI 审计实际 CSS viewport 是 1107×661，不能把请求值当成实测值。初始 IAB 约 548 CSS 宽时 main 高度为 0，原结果未显示，reader 没有假标已读；本批不声称这种窄布局或全响应式已验收，留待真实窗口范围审查。自己的 tab 已关闭、viewport override reset、预览主题请求恢复跟随系统、sidebar 恢复，preview server 已停止。无新 UI/CSS 风格或左彩边改动，不拿 fixture 视觉当实际 OS 送达。

`protected-source-read-audit.json` 核对两保护树 HEAD/status/binary diff／逐文件与四个既有删除状态保持。没有开 production main／当前软件／Cursor、跑真实账号／模型／OS 通知；worker fixtures finally 仅清理自己的目录。**完整目标仍未完成**：中心多页 summary/read receipt 竞态和更长保留／性能、legacy 原 proof 与其余会话／问卷／队列／回复历史恢复、未发 usage 载荷及 MCP 校验前未知归属、完整响应式与正式包／Windows/macOS 真权限／声音／勿扰／送达继续逐项实施验收，不把这个 reader 修复替换完整目标。仅本地提交，不 push、发布、安装或结束目标。

### 第三十批：中心迟到后页、过滤边界和当前私有历史代次

按真实现有代码先复现三处错误，见 `center-race-reproduction.log`：已加载前页的一条通知确认已读后，迟到的第二页仍以旧总计覆盖摘要，41 条未读被倒回 42；切换范围后查询失败，旧列表与旧计数仍留在新的标签下可点“全部已读／清理”；renderer store 只比较全局 counter，真实 private worker 恢复较早历史时新的低 summary 被旧高 summary 永久吞掉。当前用小型、bounded `NotificationCenterProjection` 集中原有 receipt/revision 合并，不新增业务状态机。合并覆盖全部已加载页，按确切私有 revision step 应用一次阅读 delta，重复 push／read response 不二减；可证明的其他工作区变更不猜进当前范围，未知／超出 256 条窗口的 revision 缺口给显式刷新，不假造准确 summary。行位置与正在读的 exact detail 仍不被后台新结果替换。

不同筛选／范围的 page 带 UI scope 边界，失败不能留旧 rows/count 供新范围操作；scope 切换／卸载／history reload 可围住迟到请求。后页合并用原 page offset/reset，不重写中心排序或把 source-reader keyset 套成列表的新契约。真实存储换代时 opened 旧详情可保留为历史文字，但旧页 bulk／归档／清理禁用，明确等刷新；相同 record ID／正文 revision 在另一存储代次也能显示“查看最新结果”，不用两份同 revision 正文冒充同一次阅读。精确 native-open／局部已存诊断的自动阅读 predicate 同时要求实际 displayed revision／代次，不把相同 eventId 的新低版本默默读掉。

main service 从自己的 private sourceEpoch 给 page／record／change／push 加 ephemeral `storageEpoch`，不写业务 schema、私有持久 native counter 或 Agent 数据。新的 store generation 才允许较低全局 summary，并清旧 announcement／record／history receipt cache；旧 generation 事件／回包、同 generation 迟到低 summary/historyReload 不能倒改当前计数或已确认说明。旧提醒偏好不能在换库期间被当作当前已确认偏好，等原恢复 metadata。源阅读与 LocalSourceNotice／GroupEffectsNotice 局部已存说明携带显示版本和这一代次，读取当前 private page后才放行人类确认，仍不代 Agent 写读／响应回执。

只在 renderer merge 丢旧 ACK 不够：旧的高 revision 请求甚至能读掉恢复库中同 ID 低 revision 的新未读。当前 IPC 的 read/readAll/archive/clearRead／history acknowledge 全部验证传入 observed storageEpoch，service 在任何 repository mutation 前比较，错代次为操作反馈而非新业务／DB 故障。legacy omission 固定属于初始 0，不能自动授予替换库权限；直接 trusted 内部 fixtures 保留可省略参数契约。已受理而后失去 ACK 的 page／mutation／普通 intake marker/put 同样围住 await，不把旧結果重新贴为新 epoch 或 broadcast／seed marker／弹窗。原 worker 的 BUSY/LOCKED 明确回滚 retry 仍只有两次，但 backoff 后必须是同一 worker session，不能把已回滚的旧人类请求发到更早的新历史。此处不认为 unknown timeout 已回滚，不增加业务 retry 或 worker 重放。

独立 history controller 的异步 proof／ack／prune 也用相同代次围栏；invalidate 时保留已知最近 gap 的真实身份待私有原 key 重新确认，不保留旧高 revision／ack counter 或“历史已完整”幻觉。普通存储／说明／偏好查询及确认迟到回执不能复活旧 state。全部改动仍是私有通知 transport／UI，原账号、自动化、Cursor、MCP 和其他业务调用次数、顺序、事务、闸门、等待均未改变；没有补发余额／原 telemetry／model probe。

证据：`full-regression-center-race-final.log`（311 files，2954 passed，1 skipped）、`typecheck-center-race-final.log`、`build-center-race-final.log`、`dead-code-center-race-final.log`。真实 ledger＋React 中心 tests 覆盖迟到第二页与前页 read、范围失败、同 ID/revision 的新代次 detail 稳定和 explicit latest、bulk observed epoch；projection tests 覆盖重复 delta、未知／有界窗口、其他工作区；store tests 覆盖低 summary 只由新代次接入、旧 push／同代次晚 historyReload 与 gap ACK；main service tests 覆盖旧 generation 五种动作零 repository 请求、迟到 page/read/pump 的隔离；worker fake session test 验证确切回滚 BUSY 的 backoff 也不跨 worker。其余原正常中心、source reader、局部说明、native-open、设置等全回归保持，不靠跳过失败或删断言通过。

`scripts/verify-notification-center-epoch.ts` 在 Node 与 macOS Electron (`ELECTRON_RUN_AS_NODE=1`) 走当前编译 private worker＋main service＋真实 NotificationStore：保存隔离 earlier private backup，worker **真实 exit** 后恢复，same ID 低 revision 新记录仍未读，新的低 summary 被 store 接受；旧 read／bulk／archive／clear／historyAck 都在 main 入口拒绝，真实 command audit 确认没有发到 replacement；当前 epoch 的 exact read 才能清，零历史 announcement。此脚本不伪造 DOM 可见性，也不启动 production main 或改真实用户数据。

二十二类 worker／shutdown／recovery／history／context／native-rebase／team-observations／group-effects／mcp-writes／usage-storage／model-catalog／runtime-usage／context-source／usage-binding／source-epoch／native-content／task-context／team-cache／native-scope／operator-reads／source-reading／center-epoch 在两 runtime 复跑，`center-race-verification-final-matrix.log`，原冒烟 `mcp-smoke-center-race-final.log`／`channel-smoke-center-race-final.log`。`protected-center-race-audit.json` 核对两个保护树及四个既有删除状态不变；fixtures finally 只清理自己的目录。仅本地提交，不 push／发布／安装。

真实 CUA 纯 browser `notifications=center-race` scene 先显示 54 未读、受理第二页但保留旧回包，再点击前页一条，read 后释放 fixture 的迟到 page。actual viewport 984×554，已加载 54 行、53 个 is-unread，中心和 bell 均为 53，没有“有更新”误报，原 pending/detail 保留；未用“全部已读”或清理替代精确阅读。`ui/center-race-after-read.jpg`／`ui/center-race-audit.json` 保存实物证据、logs=[]、panel width440/scrollWidth438，Escape 后真实回 bell focus。未改 UI/CSS 视觉语言、未加左彩边，不把此大小的局部验证当所有响应式已通过。自建 tab 已关闭，无 viewport override／主题修改，preview server 已停止；没有开用户软件／Cursor或实际 OS 送达。

**完整目标仍未完成**：本批收口的是中心多页与 private storage 代次，不是完整长期容量／所有 feed 恢复或正式包。接续审查发现 collaboration 原页仍用旧固定 eventId 做自动阅读，而新的 native message diagnostics 已有内容指纹／rebase suffix；这条原页 proof 接线还需专门补，不能因为 center 的单元测试绿色就忽略。legacy MCP 旧 proof、会话／问卷／回复／队列历史恢复、未发 usage 载荷和 MCP 校验前未知归属、全布局和正式打包／Windows/macOS 真权限／声音／勿扰／送达继续按完整矩阵实施验收，不结束目标。

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

## 视觉漏检修复 · 2026-10-07

用户指出“所有工作区”文字被遮挡，优先停止扩展来源接线，复现和修复通知中心实际渲染。之前的功能测试和 panel 整体宽度检查没有证明原生 select 的文字区域足够，不能据此宣称视觉验收通过。

根因是 toolbar 的 `max-width: 120px` 与 `controls.css` 的全局原生 select 样式叠加：左右 padding 合计 56px，实际只剩 64px，而当前 14px 字体的五个汉字需要约 70px。局部控件取消固定像素限宽、保留原生语义和共享箭头、禁止 flex 压缩；工具栏空间不足时整组换行，不缩小字体、不增加自定义弹层或业务请求。tabs 使用明确行高和对称内边距；底部动作可换行；定时安静字段改为有界 grid，避免固定宽度字段在窄窗溢出；会话提醒偏好的原生 select 同时统一行高和最小高度。

真实 CUA 纯 preview 验收了默认实际视口 984×554、320px/480px 实际窄窗、984×360 低高度、浅深主题、两个工作区选项、长标题/路径详情、定时安静和会话“重点关注”字段。选择框现在按原生内容撑到约 126px，完整显示“所有工作区”和“当前工作区”；窄窗的 panel/body/toolbar 没有横向溢出。保留键盘筛选、精确阅读、确认清理和原作用域查询，新增真实 ledger 的范围切换回归确认不触发已读；CSS 契约测试只证明声明边界，实际渲染由截图与 DOM 测量单独证明。

证据在 `preview-screenshots/notification-implementation/ui/scope-clipping-audit.json` 及同前缀浅深主题、窄窗、长内容截图；`scope-clipping-focused.log`、`scope-clipping-regression.log`、`scope-clipping-typecheck.log`、`scope-clipping-build.log`、`scope-clipping-dead-code.log` 记录当前回归与构建通过。`protected-scope-clipping-audit.json` 确认两个保护树和四个既有删除没有变化。临时 viewport 和 preview 外观已恢复，自建 tab/server 清理，不启动 production main、Cursor 或 OS 通知。

本次本地提交仅包含视觉修复和对应 tests/doc；第三十一批未提交的来源接线仍保留，修正了其 fixture 将 UI `scoped` 标记误传给持久通知 scope 的测试错误，没有放宽生产校验。该接线虽参与当前工作树回归通过，仍未单独完成原页视觉/worker 验收，不混入本次提交。未 push、发布、安装或重启；没有 Windows 真机证据，完整通知目标仍未完成。

## 第三十一批 · 原协作消息的精确原页阅读

接续上一轮已提交的视觉修复，核对并完成之前未提交的 operator-message 阅读接线。主进程与 renderer 共用既有 native 薄字段数组：`id / kind / createdAt / sender slotId / groupId / threadId / subject`。Node SHA-256 与 WebCrypto 计算同一材料；它不是完整正文 hash，不读取或复制正文、凭据、Agent read/responded receipt。组视图保留原 workspace 身份，线程主题按 thread 只保存一份，不按每条消息重复拷贝。

原页只在当前选中正文实际可见、窗口有焦点、确切 workspace/run/group/message/kind/digest 一致时，由原 private reader 确认相应通知版本；沿用其 storageEpoch、分页、并发上限、迟到回包和卸载围栏。认可合法 `:facts:<digest>:data:N` 重核身份，不把固定旧 eventId、prior-data、scope-unconfirmed 或别的组/批次冒充当前原事实。没有有效 WebCrypto proof 就保留未读，不回退到标题/CH 匹配或原业务探测。Toast 抑制复用同一个精确元素 matcher；抑制本身不写人类已读，更不改 Agent 回执。

二次审查又发现两处边界：正文 DOM 已切作用域而旧 passive reader 尚未清理时，仅比 message/digest 不足；现在 readable predicate 同时核对所有原 scope/kind 属性。固定 messageId 当前缺席时，仍存的 pair link 不得把自己的 latest message 顶上来；现在保留明确“原消息待核对”，不会替换为另一条人类或 Agent-to-Agent 消息。App 已按 scope/message key 重挂载显式来源导航，未另加选择状态机、轮询或业务重试。

`tests/operator-message-source-read.test.tsx` 覆盖真实 private ledger、Node/WebCrypto 一致材料、合法 rebase suffix、元数据变化、focus/可见性/覆盖模态、迟到查询与 DOM 边界、卸载后的迟到 crypto、晚提交 push 及 legacy 的显式阅读降级；原 Agent receipt 保持不变。组原页 tests 补了人类消息缺席和仍存在 pair 的 Agent-to-Agent 固定消息缺席；map tests 确认只取当前 run 的线程主题；Toast tests 确认精确抑制和错误作用域不抑制，且不擅自读通知。

最终 typecheck / 全套 tests / build / dead-code 检查通过：`operator-source-read-*-final.log`，312 files、2974 passed、1 skipped。更新的 operator-reads verifier 在真实构建 worker、真实原 Team/Collaboration 服务下，检查 shared tuple 与持久 digest、相同 counter 的新主题/类型重核、旧 scope/缺席恢复、50,000 原格式身份和原请求次数不增；共二十二类隔离 fixtures（含 operator-reads）在 Node 与 macOS Electron as-node 复跑全通过，连同原 MCP/channel 冒烟见 `operator-source-read-verification-matrix.log`。这些不是 production main 或原生 OS 送达实机。

真实 CUA 冷加载纯 preview `operator-read` 使用实际产品组件和同一个原薄 metadata proof，私有 fixture 有合法 rebase suffix。进入运行页、打开协作图看到晚到的普通状态，仍为 1 未读；明确选择对应正文并可见后变为 0，中心保留 1 条已读记录。旧 `human` fixture 保留固定 eventId：正文可见仍 1 未读，用户在中心明确阅读后才为 0；来源动作仍定位原消息，不跳到晚到状态。默认实际 984×554 与 320×720 暗色的协作 dialog/body 无横向溢出；图本身保留原局部横向滚动。窄窗检查不是全 App 导航通过证明：在低于 native 最小窗宽的纯浏览器里遇到顶栏点击重叠，仍列入后续全布局审查，不用此单点截图泛称“所有响应式完成”。

中途删掉无用 effect dependency 时，开发 HMR 保留的旧 hook 树报过 dependency-array 长度变化警告，原证据保留在 `ui/operator-source-read-development-audit.json`；代码稳定后的冷加载重新执行上述流程，`ui/operator-source-read-audit.json` 的 logs 为空，不靠清除旧日志冒充通过。最终图为 `ui/operator-source-read-after-final.jpg` 和 `ui/operator-source-read-narrow-dark-final.jpg`。临时 override 已用文档 API 清除，preview 外观回到 system，自建标签/服务清理；没有启动当前软件、Cursor、真实账号/模型、退款/删除或 OS 通知。

只本地提交，不 push、发版或安装；保护树核对见 `protected-operator-source-read-audit.json`。**完整目标仍未完成**：本批收口原协作消息，不替代 legacy MCP 原 proof 的恢复关联、会话/问卷/回复/队列历史恢复、未发 usage 载荷和 MCP 校验前未知归属、长期容量/完整布局、正式包和 Windows/macOS 权限/声音/勿扰/送达验收。后续继续逐项实现，原完整要求不缩减。

## 第三十二批 · 协作记录选择后的正文定位

第三十一批提交后再查看实际截图，发现图例工具栏的 sticky 覆盖问题：浏览器把被点击的记录按钮滚入视野，但并未把它对应的正文完整带到工具栏下方；正文可能仍有一部分可见，从而符合原通知阅读门禁，却给用户留下首行被压住的粗糙体验。旧截图保留为发现依据，不把测试计数当作这项视觉已通过。

只对用户明确激活记录按钮新增局部定位：等待选中正文 DOM 提交后，读取实际工具栏高度（窄窗会换行），把详情标题和正文带到其下方并留 12px 间距，同时将键盘焦点移到详情。复点已选记录也能返回正文；正文内部的文本选择、图片查看和普通检查继续只固定消息，不触发滚动。没有固定猜测图例高度、常驻 observer、定时器或 render 中测量；没有新增业务/通知 API 调用代码，没有改内容、原请求顺序、图布局或 Agent 回执。

React 回归覆盖实际 74px 工具栏的定位计算、重复激活和正文检查不滚动。typecheck 首次发现 ref 缺初值的 React 类型错误，补为显式 `string | undefined` 后完整重跑，不带编译错误提交。`operator-record-reveal-{focused,typecheck,regression,build,dead-code}.log` 最终通过，312 files、2975 passed、1 skipped。主进程/worker 没有改动，沿用第三十一批的当前 worker 矩阵证据，不把 renderer 单点修复冒充新 OS 送达验收。

真实 CUA 984×554 重现原场景后，工具栏 bottom151.9、详情 top163.7，正文 top207.1/bottom290.0，均在 body bottom491.1 以内；320×720 暗色换行工具栏 bottom161.7、详情 top173.6，正文 top217.0/bottom373.4，同样完整可见。焦点在详情，原未读仍只在对应正文显示后消减，logs=[]。见 `ui/operator-record-reveal-audit.json`、`ui/operator-record-reveal-after.jpg`、`ui/operator-record-reveal-narrow-dark.jpg`；两种截图逐一查看，不把旧部分遮挡图当最终效果。viewport override 和 preview 外观已清理，自建标签/服务停止。

本批仅本地提交并保留完整目标。legacy proof 恢复、其余历史 feed、全布局及长期容量、正式包与 Windows/macOS 原生权限/声音/勿扰/送达仍需继续，不声明整套已经结束。

## 第三十三批 · 旧 MCP 摘要的安全对照关联

权威代码复核确认：旧 `McpWriteState.seen` 命中后直接跳过，旧摘要缺少 `target.mcpWrite` 时无法获得可靠来源入口；而旧摘要本身没有保存完整实体身份，不能拿当前工具 JSON 回填成“过去的原身份已恢复”。因此本批完成的是明确标注的**当前结果对照关联**，不是伪造历史 proof 或自动确认旧消息。

只沿原 sealed/live Cursor 工具快照观察，在原调用 namespace、完整 workspace/run/slot/session/composer/installation generation、原 block/entry/time 和支持的旧生成格式严格一致时接入。Agent ID 另按 `agent-registrations.ts` 强制的 `workspaceId:ch-channel:generation` 格式核对，不从角色名/CH 推测。旧状态/格式/范围不匹配、已有精确 proof、归档/清理的记录均不替换。对照记录保留原 ID、原重要程度、attention/read revision 和已读时间，明确“当前结果仅供对照”；当前工具身份只服务对照导航，`legacy-comparison` 永远不被原页 reader 当成历史已读证明。不推旧 toast、不新增未读、不自动回复/重试/撤销业务。

新增 worker 内部 `mcpWriteRecords` 只接收最多 100 个唯一、精确 `mcp-write:<digest>` key，返回已存的有限摘要 metadata；不接任意 SQL、不复制原参数/完整工具输出、不新增 renderer IPC 或公共 MCP 工具。主 service 和 projection 的 storageEpoch 双重围栏拒绝迟到旧代次 metadata；read-only BUSY 使用原有有界重试/worker session 围栏。正常新事实仍走同步 reducer 快路，不为每个 Token 做迁移查询。

source checkpoint v2 每个既有身份仅增加一个 `~` 前缀表示“已检查”，不是历史 proof 或人类回执；没有再存一份 20,000 条身份。缺席、清理或歧义的记录同样推进检查点，231 条真实 private ledger 走 100/100/31，不因头批无法关联而死循环。单个 MCP source 的原 20,000 身份容量对应至多 200 批，处理围栏调整为 256；超过原容量仍披露缺口，不截重要数据。实际 compiled worker 在 Node/Electron RPC 保存并读回 20,000 已检查身份＋10,000 提醒 family，仍在原 2MiB 限制内。

`tests/mcp-legacy-comparison.test.ts` 验证已读/未读保留、精确范围/时间/注册 actor、已有 proof 不覆写、未知格式不猜、跨 private generation 不落地、清理竞态不复活、metadata namespace/上限和有界容量。`mcp-write-notification-read.test.tsx` 验证即使当前原输出完全匹配对照身份，旧摘要也不会自动被读取。最终 typecheck/tests/build/dead-code 通过：`mcp-legacy-*-final.log`，313 files、2989 passed、1 skipped。

新 verifier 复用原 MCP/server/SQLite/modern+legacy hook fixture，只把自己 PRIVATE 通知行和游标降成旧格式，再按当前原快照核对；原业务计数保持、旧未读不被偷清、无模型或原业务重放、无原文复制。二十三类 fixtures 在 Node 与 macOS Electron as-node 复跑及原 MCP/channel 冒烟全通过：`mcp-legacy-verification-matrix.log`；新增容量 RPC 实物见 `mcp-legacy-capacity-{node,electron}.log`。不是 production main、真实账号/Cursor 或实际 OS 通知验收。

纯 CUA 产品组件预览：当前 native JSON 展开后仍 2 未读，中心明确阅读一条后变为 1，“对照工具结果”导航定位确切 `preview-mcp-write-0`，另一条旧摘要仍未读。精简说明不塞内部字段术语；默认实际 984×554 和暗色 320×720 面板无横向溢出、logs=[]。证据 `ui/mcp-legacy-audit.json`、`ui/mcp-legacy-center.jpg`、`ui/mcp-legacy-narrow-dark.jpg`。临时主题/viewport、自己 tab/server 清理，保护树与四个既有删除保持，见 `protected-mcp-legacy-audit.json`。

只本地提交。**完整目标仍未完成**：不支持的历史格式/缺失身份只保留明确阅读，不声称无损恢复过去实体；会话/问卷/回复/队列的历史恢复、未发 usage 载荷和 MCP 校验前未知归属、长期容量/完整布局、正式包及 Windows/macOS 真权限/声音/勿扰/送达仍继续。完整要求和既有业务闸门不缩减，不 push、发布、安装或重启。

## 第三十四批 · 历史来源边界与疑似失联问卷

接续权威 worktree 审查发现真实来源漏洞：问卷从所有历史 entry 的 processBlocks 收集，回复没有校验 source/channel，队列只按 outbox ID 关联回复。恢复/导入记录、用户条目、错通道内容可能变成“待回答/已回答/有新回复/交接已回复”通知。原 `channel-message-relay.ts` 的业务回复投影明确使用 assistant + cursor + 原 channel，而 desktop 是用户出站条目；本批沿这个既有契约，不从正文、相似标题或当前 CH 猜权威。

新增一个纯 `nativeAssistantEntry` 判定，问卷/回复/队列复用；MCP 原已有相同三条件，改为同一 helper，语义不扩展。队列关联按实际 channel＋出站 ID，且时间线 bucket 名称纳入提取 cache 的引用比较，防止只有同一数组换 bucket 时仍沿用旧关联。回复/问卷历史提取不会让 untrusted 终态覆盖真实事项；有效原生 pending/submitted/complete 仍照常。未改原业务库、投递、撤回、重试、权限、Source RPC 或请求次数/顺序。

再次审查发现：问卷将 online=false（包含 suspected）当作不再 actionable，从而移出待处理。现在 pending 的“仍需要用户回答”与传输在线灯不混同：已知问题在疑似失联、历史被裁切、通知 observer 重建时保留；当前原生 pending＋等待证据也可安静恢复。不新增提交权限，回答仍走原业务检查。只有明确回答/取消、确认停止/运行结束/会话身份更换、或可靠 runtime 明确“不再等待”才收口。没有据失联假造 submitted/cancelled，也不让旧问题自动补答。

`notification-native-entry-provenance.test.ts` 覆盖 desktop/recovery/user/foreign-channel 四种伪来源、不能创建假的问卷/回复、不能以导入答案解决真的问卷、不能把另一个通道的显式 replyTo 当成本通道回执；原生正确结果作为正向对照。另验证同数组换 bucket 的 cache 边界。问卷 tests 补了疑似失联、裁切和 observer 重建、确认 stopped 的完整序列。正常可见性/中心已读、队列正向回执、MCP 语义均未缩减。

单位测试与 built-worker 复用纯数据 fixture，移出原 tests helper 的 Vitest 依赖；不复制一套应用逻辑。新 `verify-notification-native-entry.ts` 只启动已编译 private worker，复核原生／不可信来源、跨 bucket/channel、真实 pending/submitted/replied 投影、observer restart＋suspected 保留待处理，通知 JSON 没有原问题/选项/全文。不打开 production main／Cursor、没有模型/账号/OS 送达或业务网络调用。

当前证据：`native-entry-{typecheck,regression,build,dead-code}-final.log`（314 files、3005 passed、1 skipped）、`native-entry-focused-final.log`；二十四类 Node/macOS Electron as-node fixtures 及原 MCP/channel 冒烟全过，见 `native-entry-verification-matrix-final.log` 和 `native-entry-verification-final-native-entry-{node,electron}.log`。保护树/既有四个删除保持，`protected-native-entry-audit.json`。本批没有改 UI/CSS，不用旧截图或无 GUI 的 worker 声称全视觉已通过。

### 接续中的长回复关联复现（未解决、未提交）

当前 HEAD `fb6dade` 后新增 `reply-notifications.test.ts` 的长历史回归：原回复确认已读，推进 2,100 条其他真实格式回复，再回填原回复的晚到 canonical/outbox 引用。相同 key 的普通回填已有 ledger 内容签名保护，最初的同 key 试验通过；真正缺口是 aliases 从 source 的 2,000 条窗口丢失后，canonical key 改变不能找到旧通知。`reply-window-reproduction.log` 明确失败：应有 2,101 条，实际 2,102 条。不能把所有历史回填都称为重播，也不能把该用例跳过后声称完成。

下一步需让 reply 的 canonical/aliases 关联在 private 存储持久化，并与 source 游标/通知变更短事务提交；2,000 条只做内存/快照工作集，不作为历史权威。保留 stock 回复不变新未读、晚到别名不重复、已读/清理/归档不复活、不同 scope 不合并、失去 ACK/CAS/storageEpoch 围栏和原 2MiB transport 上限。不能仅拉大 JSON 上限或按时间水位丢弃晚到真回复。此回归目前仍失败、工作树未提交，不发布或结束目标。

接续补了 `reply-identity-index.ts` 的私有 transport 数据契约和 `reply-identity-index.test.ts`：只接收 reply-source namespace、每批最多 100 个唯一 canonical hash、每行最多 8 个唯一 alias hash、有限 entry 引用和 failed/recorded 标志，拒绝正文、额外字段和任意其他 source。`reply-index-contract.log` 两项通过，但这只是协议基础，**尚未接 SQLite 索引、worker 和 reducer**，长历史回归仍未修复。不要将数据契约文件或绿测试当作目标已经实现，也不要仅增大 cache。

进一步新增 `SqliteReplyIdentityIndex` 的规范化 private 索引实现及 storage tests：canonical 行与 alias 候选分表，按 source namespace 隔离，旧 aliases 不因 2,000 工作缓存淘汰而丢失；一次最多 100 行写入/800 hashes 查询，超过候选上限不猜合并。它不自建业务事务，caller 的 source 短事务回滚时索引同时回滚；多个 owner 保留为候选，不静默覆盖。`reply-index-storage.log` 五项通过，foundation typecheck 通过。**尚未挂到正式 private schema migration、worker/commitSource 或 reply adapter/reducer**，只在自己的隔离内存 DB 测试，不能声称目标路径修复。当前 WIP 未提交、未发布，失败的长历史回归继续保留。

**完整目标仍未完成**：本批解决来源伪权威和疑似失联丢待处理，不是全部历史恢复。复核同时定位后续范围：回复 source 的 2,000 身份/aliases cache 仍需长期去重与关联保障；问卷旧终态和真实原记录恢复的重核、队列跨 scope/备份恢复、未发 usage/MCP 未知归属、全布局与正式包/原生 Windows/macOS 送达继续。普通 old/missing 不假设完成，也不为通知追加业务预检。只本地提交，不 push、发布、安装或重启，原完整要求保留。

## 第三十五批 · 长回复的持久身份关联与原子投影

本批接入第三十四批留下的失败回归和索引基础，不再把基础组件通过当作目标路径修复。权威复现是：一条回复被明确读过，随后推进 2,100 条独立回复，原 stream/turn 在晚到 canonical/outbox 引用中仍然存在，原实现却生成第二条未读（2,101 变 2,102）。现在该原用例通过，未删除或放宽断言。

- 私有 schema 5 增加 canonical metadata 和 alias ownership 两张规范化表；只留 hash、entry 引用、终态和是否已有记录，不复制回复正文。alias ownership 不随 2,000 条工作缓存淘汰；payload 自身只留八个工作引用，查询另返回**实际命中的历史 aliases**，避免历史关联存在却因 payload 裁切再次漏配。没有把全索引塞进 source JSON，也没有扩大原 2MiB 上限。
- source checkpoint、通知变化和索引 sidecar 在既有 worker-owned 短事务里一起 CAS 提交。任一项写入失败全部回滚，stale revision 不写 aliases；未知 ACK 只在下个原 source frame 重新加载，不重放原业务。私有 metadata 查询和 projection 确认各自保留 storageEpoch 围栏，迟到旧代次 metadata 不写到替换后的历史。
- reply checkpoint v3 有明确的有界扫描位置；原生同 frame 的 entry/stream/turn/anchor 桥接先合并再切批，避免桥接位于后页时先制造两条回复。一次最多 100 个身份写入、800 个唯一 hash 核对；stock、已知结果、没有 draft 的批次一样推进，初始 stock 的时间边界跨批保持。9,001 条初始存量全部建立身份，不只是最后 2,000 条，也不制造旧未读。
- 已有记录保留原 ID、read/attention revision、归档和清理事实；晚到 canonical 只补原结果引用，不作为新回复。已证明 canonical 不被裁切后的 native fallback 降级。failed→complete 更新原记录；同 CH 不同真实 generation 仍是不同来源。两个已发布 owner 有歧义时明确拒绝猜合并，只有确切桥接的未发布 stock 身份可归并，且搬迁全部旧 aliases。published 身份不能回退为未发布，也不能作为被删除的归并项。
- 旧 v1/v2 source 只对**实际保留下来的** rows 做最多 100 行的私有 backfill，连同游标一起提交，不在启动事务里重写所有历史。新 schema 缺表/结构异常不会默默建空表来伪称恢复；较新 schema 拒绝降级。原全局 user_version 和无关表保持。旧版此前已经裁切掉的 aliases、未知混合存量/新增及备份回退仍不能宣称无损恢复，继续作为后续历史重核范围。
- 再次审查去掉无意义的扫描写放大：已持久化且未变的前缀只按有界页读取，在 private 异步 reducer 中推进临时扫描，遇到真实变化才做原子提交。2,100 条已知前缀后增加一条回复，只新增一次 source 写入，不为每个临时 offset 重写约 1MiB 的缓存。没有新增业务请求、轮询或重试，也没改原请求顺序、闸门、互斥、Agent 回执或 UI。

最终证据位于当前实现树 `preview-screenshots/notification-implementation/`：

- `reply-index-full-regression-final.log`：318 files、3037 passed、1 skipped；`reply-index-review-regression-final.log` 另外覆盖本批最后一轮防御审查。
- `reply-index-typecheck-final.log`、`reply-index-build-final.log`、`reply-index-dead-code-final.log`：类型、构建和 dead-code 检查。
- `reply-index-verification-matrix-final.log`：24 类 fixtures 在 Node 和 macOS Electron as-node 使用当前编译 worker 复跑通过，另有隔离 Electron 退出 fixture 与原 MCP/channel smoke。新 `verify-notification-reply-identities.ts` 实物验证 cache 淘汰、worker/私有 SQLite 重启、已读/归档/清理不复活、stock 全量分批及真实 SQL trigger 失败时三部分一起回滚；仅自己的 PRIVATE 文件与数据，不是正式 main 或真实模型。
- `protected-reply-index-audit.json`：两个保护树逐文件、HEAD、porcelain status 和 binary diff 保持；原四个删除继续为删除。fixtures 的临时目录在 finally 精确清理，未创建 preview tab/server。

本批只本地提交，未 push、发布、安装或重启用户软件/Cursor，没有真实账号操作、模型请求或 OS 通知。**完整目标仍未完成**：旧版丢失身份与恢复时的混合历史归属、问卷旧终态/真实恢复、队列跨 scope/备份恢复、未发 usage/MCP 校验前不可归属诊断、全布局/长期容量/正式包及 Windows/macOS 真权限/声音/勿扰/送达仍须逐项核验，不能用这次回复修复替代完整验收。

## 第三十六批 · 问卷终态不随工作缓存遗忘

权威失败回归：先观察原 pending，再收到明确 submitted/cancelled，用户明确读过并清理；随后同一真实时间线增加 600 个独立终态问卷，原行从 512 条 passive 工作缓存淘汰。observer 重建后，一条旧 pending 块与一条真正的新 pending 同时出现，原实现产生两个待处理，并复活已清理的旧问卷。`question-terminal-reproduction.log` 保存该失败，不把“没有发生淘汰”的初次试验当复现。

- 私有 schema 6 增加 `desktop_notification_question_terminals`，仅 source namespace、问卷身份 hash、submitted/cancelled 三列。不保存题目、答案、选项或原参数；不是作答通道或新 MCP 工具。凭据按 workspace/run source 与完整会话身份派生的问卷 identity 隔离，工作 cache 仍是 512 条，未扩大原 2MiB checkpoint 限制。
- 只把原生明确终态写入凭据；suspected、裁切、未再等待、停止/结束运行仍不推测为已回答/已跳过。已保存的明确终态能在 late pending 到达时稳定收口，同源重复身份不覆盖为相反终态，不按正文或时间水位猜。真实新 pending 仍能恢复，主动决策不会为了 passive 历史被淘汰。
- 凭据、通知变化和 source 游标一起走既有 private worker 的短 CAS 事务；任一 SQL 失败全部回滚。metadata 和投影回执各自检查 storageEpoch；未知 ACK 只在下一原 source frame 重载，CAS 冲突按真实 checkpoint 重核，不重试原作答或业务。
- question checkpoint v2 先把 v1 **实际保留下来的** terminal rows 分批迁入，每批最多 100，再缩减工作 cache。当前观察也按明确扫描位置逐批推进；未落盘的 passive terminal 不提前进入可裁切的 cache。初始 stock、没有 draft 的阶段同样有真实进度。已保存的 terminal 前缀只读，不为每个临时 offset 重写 SQLite；1,600 个已知终态后追加一个新终态只增加一次 source 写入。
- 元数据补齐只为仍活动的问题更新原定位，并保留原 ID/read/attention revision；已结束的问卷不因后来的封口 entry 或停止状态被改成 activity 来偷偷消掉未读。本批二次审查明确找到并加了这一负向回归。已清理的终态也不会因 metadata 补齐复活。问卷语义与真实作答门禁、选项、原响应处理保持分离，通知不能代答或禁止原入口。
- legacy backfill 校验 metadata 字段、范围、身份形状和实际 offset，不把答案/题目混入检查点；损坏当前 schema 不建空表假装恢复。未来格式拒绝降级；全局 user_version、无关表和其他 private 回复索引保持。旧版早已丢失的身份、曾经不可靠的旧来源以及真实 Cursor 原库回退/复原的重新归属，仍须后续核验，不能把复制旧 checkpoint 等同于恢复过去的原证据。

最终证据：`question-terminal-typecheck-final.log`、`question-terminal-build-final.log`、`question-terminal-dead-code-final.log`；`question-terminal-review-final.log` 包含本批末轮语义审查，`question-terminal-full-regression-final.log` 为 320 files、3056 passed、1 skipped。fixture 中一度缺少必需的 live `turn`，类型检查发现后已补齐并完整重跑，不携带编译错误提交。

`question-terminal-verification-matrix-final.log`：25 类 fixtures 在 Node 与 macOS Electron as-node 使用本次编译 worker 复跑，另有隔离 Electron quit 与原 MCP/channel smoke。新增真实 worker verifier 验证 1,602 个 terminal 超出 cache 后跨重启稳定、已读/清理不复活、真正新待处理恢复、SQL trigger 失败时三部分一起回滚、passive refinement 不消费未读、原无关 SQLite 数据/user_version 保留、三列无正文。单位回归另覆盖旧 v1 分批迁移、临时失败续批、CAS/未知 ACK、迟到旧代次 metadata、严格 namespace/上限/非法字段及缺表/结构损坏。不冒充 Windows 真系统送达或实际 Cursor 请求验收。

保护报告为 `protected-question-terminal-audit.json`；两个原开发树的文件、HEAD、porcelain status、binary diff 和四个既有删除保持。fixtures 精确清理自己的临时目录；没有 production main、用户软件/Cursor 重启、真实模型/账号/退款/删除/付款或 OS 通知，没有 preview tab/server。本批只本地提交，未 push、发布或安装。

**完整目标仍未完成**：真实原库恢复时的问卷重新核对、旧版已失去的身份与混合历史、队列跨 scope/备份回退、未发 usage/MCP 校验前不可归属诊断、全布局/长期容量/正式包及 Windows/macOS 真权限/声音/勿扰/送达仍继续。终态 cache 修复不替代上述完整范围。

## 第三十七批 · 队列来源、历史接收者与原行回退

五个权威失败回归见 `queue-boundary-reproduction.log`：当前 run 的同 CH/同 outbox 引用被用于确认旧 run 交接；未投递撤回/退役行被一个 complete 块改成 replied；只是重绑 CH 就把过去的 taking 回执改给新 Composer；原数据库重新读出 pending 后，通知仍称已取走。本批修复这五条路径，不增加热态复核或执行链等待。

- 沿原 `beginScope`/`listPendingOutbound` 的精确 run_id（含 NULL）关系核对 Native reply。非当前 run 的回声不解决旧父记录，未取走且已经撤回/退役的行也不被模型块覆盖。普通同 run 的明确回复、held→新会话取走→回复仍正常。
- 原 `ChannelMessageRelay` 的既有 hydrate、轻量 delivery read、scope audit 和已成功的用户事务只为**自己的主进程通知 metadata cache**附加随机 reader 身份及语义变化序号。不改 SQL 业务状态、参数、原调用顺序、轮询频率、互斥或门禁。未变读数保留旧 inspection 和同一 facts 引用；watch 从私有历史补出的 placeholder 不能自称原行已核验。
- 精确 watched id 的缺席，只从原 lightweight query 的现有 UNION 结果判定，没有另外查询正文/附件或额外数据库探测。原回执与当前原行缺席/pending 矛盾时进入同一个待核对 episode，保留历史，不说再次即将送达，不猜撤回、退役、失败或“还原成功”。普通无新 inspection 的旧 queued 帧仍不回退确认结果。
- queue checkpoint v2 为每行加可选原 inspection 序号，reader 身份每 source 一份；旧 v1 无凭据不补造。低序号迟到帧不能覆盖新结果。实际 getter 已换 reader 时，未提交旧观察不复制到新来源，明确保存历史缺口。待核对状态跨 observer 重建保持，直到原读数给出新确认；旧 Cursor reply 回声本身不能修复 channel 原行的回退。
- handoff 只增加原 taking 时间 metadata。单纯新绑定不迁移历史接收者；真正 held 交付或新明确回复仍可更新正确目标。legacy 缺 taking 时间时保守，不把第一次补字段当新的取走。待核对暂不提供错误会话跳转，发现时间使用 observed，不拿几小时前的 createdAt 让新警告过期。清理/已读、未知 ACK、CAS rebase 仍沿原事务保护。

最终 `queue-boundary-review-final.log` 验证五处修复及 late sequence、reader 换代、原行缺席、observer 恢复、实际重新取走、idle 共享引用、ACK/CAS/清理；`queue-boundary-full-regression-final.log` 为 321 files、3067 passed、1 skipped。typecheck/build/dead-code 见同前缀 `*-final.log`。无 renderer/CSS 变更。

`queue-boundary-verification-matrix-final.log` 的 26 类 Node/macOS Electron as-node fixtures 使用当前 compiled worker 通过，另有隔离 quit 和原 MCP/channel smoke。新增 `verify-notification-queue-boundaries.ts` 用真正的原 channel repository/relay 加私有 worker 检验已取走→隔离较旧行状态→待核对→重新取走，单条父记录、历史 receiver 不改给新 Composer、跨 observer 保留、无正文/token/路径复制及 payload 上限；未跑用户生产 main、真实账号/模型/付款/退款/删除或 OS 送达。单位场景额外 spy 证明当前恢复路径仍只有原 lightweight read，未调用 heavy/audit 额外查询；超过 hydration 的缺席使用已有 watched ID 机制。

保护报告 `protected-queue-boundary-audit.json` 比较两原树逐文件/HEAD/porcelain/binary diff，四个既有删除保持；自己的 fixtures finally 精确清理。只本地提交，不 push、发版、安装或重启用户软件/Cursor。

**完整目标仍未完成**：本批不声称能无损恢复被旧版裁切的身份、没被任何原查询观察到的窗口外变化、任意原库重建/换库或全部容量组合；真实 Cursor 原库恢复重核、未发 usage/MCP 校验前归属、全布局/长期容量/正式包与 Windows/macOS 实际权限/声音/勿扰/送达仍按原完整要求继续。

## 第三十八批 · 用量载荷发出前的白名单诊断

实际 embedded hook 的 VM 复现见 `usage-emission-reproduction.log`：原 `nativeUsagePayload` 的 getter 抛错、原 usage binding 缺失/不可调用或原 emitter 抛错时，没有 usage payload，原 receiver observer 因此无法知道。三条失败回归保留；正常没有正计数/generation 的等待作为正向对照，不被误报源失败。

本批只扩展原过程帧：hook v37 在自己的原 usage try 内记录 `extract | emit` 两种白名单原因，只有原 `processSnapshot` 仍可生成时才捎带 `{version:1,reason}`。没有额外 binding、CDP evaluate/探测、model 请求、timer、载荷重发、读取或计数回调；原写后顺序与原过程节流/裁切继续。没有复制异常文本、路径、模型、generation、计数、参数或答案。没有过程帧/没有合法字段本身仍不是失败证据，不据静默推测额度或账单。

桌面只在当前已验证 hook、仍存活的主世界 executionContext 和既有真实 Composer 绑定一致时接入。额外字段/未知 version/reason、旧 context、无绑定 Composer 不被强挂当前账号或席位。原 `onProcessEvent` 参数和原 usage parser/callback 保持；metadata observer 失败不阻断原 process consumer。新增原因进入原 UsageBindingNotifications 的五秒、两次同类异常候选和一条绑定范围 episode，没有另造一套故障引擎/存储表。提示区分“未能提取”“未确认发出”和既有“接收验证/回调未返回”。新 wording 描述整条链的未确认步骤，不把未发送假称为接收器抛错。

正常 process 帧、空/零/legacy 用量帧、另一成员或新文档不能关闭旧问题；只有同绑定/同文档可验证的原 usage payload 且原回调返回，才沿原确认机制安静收束。计数可能仍是估算，这条只确认本机入口，不补账、不保证落盘或官方账单。Scope/wake/storageEpoch/CAS/失去 ACK 和退出静音继续使用既有边界。

最终证据：`usage-emission-typecheck-final.log`、`usage-emission-build-final.log`、`usage-emission-dead-code-final.log` 和 `usage-emission-full-regression-final.log`（322 files、3075 passed、1 skipped）；focused receiver/hook 回归另与原 cursor-stream tests 一起通过。`usage-emission-verification-matrix-final.log` 为 27 类 Node/macOS Electron as-node fixtures 使用当前 compiled private worker、隔离 quit 和原 MCP/channel smoke。新 verifier 执行真正的 embedded JS hook 于 isolated VM，并把原 process/usage 帧送入原 CursorStreamObserver，再经真实 worker 检验诊断/恢复、原 callback/计数不改变、CDP 命令不增、无 raw 内容复制。不是实际 Cursor 页面、生产 main、Windows OS 权限或系统送达验收。

`protected-usage-emission-audit.json` 保存两原树逐文件/HEAD/porcelain/binary diff 与四个既有删除核对；自身 fixture 目录精确清理，没有 preview tabs/server。仅本地提交，未 push、发布、安装、重启用户软件/Cursor 或运行真实模型/账号/OS 通知。

**完整目标仍未完成**：MCP runtime/校验前无可信主体的诊断仍待接入，本批没有把普通拒绝改成写失败或猜 Agent；整条过程帧也无法产生/传输时的未知来源、旧格式丢失身份和真实 Cursor 原库恢复重核、全布局/长期容量/正式包及 Windows/macOS 真权限/声音/勿扰/送达仍按原完整范围继续，不把此 producer 补口当整套完成。

## 视觉复核 · 原生筛选文字容错与关联窄窗

再次以用户的“所有工作区”截图优先复核实际控件，不继续扩展通知来源。开工前已有 `2ff7e83` 移除 120px 上限；本机当前预览没有再次复现旧截图的严重裁字，但原生自动宽度约 126px，减去共享箭头/内边距的 56px 后只有约 70px，恰好等于五字的实测宽度。之前的自动宽度修复没有额外字体/DPI容错，不能只凭外框没有溢出就判文字安全。

本批只修改通知 CSS 与回归契约：范围选择框下限为五字加一字留白和原共享内边距，继续保留原生选择语义、共享箭头和现有字号。空间不足时工具栏整体换行，不压缩字段、不新建自定义下拉或读取引擎。实际两种范围标签均为 70px，修复后的文字区约 84px。关联的会话偏好同样留足“重点关注”字宽与边框；实物检查发现加宽后旧 grid 会把“此会话的提醒”最后一字挤到下一行，随即改为可整组换行的 flex。在实际 320px 视口标题恢复为一行，246px 极窄视口选择框独立换行，说明完整保留。没有修改查询、已读、归档、偏好保存或任何业务顺序。

CUA 纯 preview 验收默认 984×554、实际 320×480/600、480×360、246px 极窄、深浅主题、长正文、时间设置和关联偏好。截图与实际 DOM/Canvas 字形测量在 `ui/scope-text-safety-*.png`、`ui/scope-text-safety-audit.json`；记录的是实际 CSS 视口和 DPR，不把请求尺寸误报为实物尺寸。三档 Chromium 设备像素模拟下标签和文字余量保持，不能代替 Windows 真机验收。原生键盘的第一下 ArrowDown 是展开菜单，需要继续 Down/Return 才提交选项；完成选择后 Escape 正常关闭中心并回到铃铛焦点，没有把菜单的一次 Escape 误判成中心失败。

最终 `scope-text-safety-focused-final.log`、`scope-text-safety-regression-final.log`（323 files、3082 passed、1 skipped）、`scope-text-safety-build-final.log` 及 `scope-text-safety-dead-code.log` 为当前证据。CSS 契约测试区分共享内边距、字宽留白和关联换行，不冒充浏览器字形验收。临时 viewport、媒体和设备像素覆盖已清理，自建标签与纯 preview 服务已关闭；没有启动生产 main、用户软件/Cursor、真实账号/模型/OS 通知。`protected-scope-text-safety-audit.json` 确认两保护树逐文件/HEAD/porcelain/binary diff 与四个既有删除保持。

仅本地提交本视觉修复、对应 test 和本段进度，不 push、发布或安装。MCP 不可归属诊断的未提交文件原样保留；虽参与当前工作树回归通过，尚欠原生 compiled-worker 等验收，不混入本次提交。**完整通知目标仍 active，未完成**；本点不替代上文完整范围与后续实机验收。

## 第三十九批 · MCP 原生错误标志与未确认主体

继续完成上一批留下的 MCP 未归属诊断，不从 SDK 文案猜错误阶段。真实 installed SDK＋InMemoryTransport 证明非法数值 `channel_id` 在 runtimeFor 之前被拒绝，runtimeFor EIO 也被 SDK 包成普通 text＋`isError:true`，两者都没有 SG machine receipt。原服务、响应、权限、业务参数和重试规则不改。fixture 现保留实际调用的原参数，非法请求不会被测试擅自改成合法字符串通道；现代/legacy 原生形态都通过真正的 embedded hook、原 parser 与 DesktopSessionService 投影。

hook v38 只读取已知 envelope 的 typed `isError`：最多八层 wrapper、JSON 字符串最多 2M，不进正文/参数找布尔，不按“Error”或 EIO 文案分类。指纹复用同一 wrapper 读取器的**不解析字符串**分支，原地 direct/case/value/deeper wrapper 标志翻转能失效缓存，避免长回合 completed bubble 的旧缓存吞掉错误。verified hook＋仍存活的主世界 context 才允许新标志；旧/未知 context 的原过程 callback 继续，只剥去这条新增诊断凭据。Desktop 额外盖原观察 Composer，不借当前 CH 的新绑定补造它；旧 Composer 的晚结果、安装前已开始但安装后才完成的调用都不能挂到新安装。正常首次绑定较晚而调用始于本次安装之后，仍接受。

有完整 boolean `ok`＋bounded `agentSessionId` 的原 SG outcomes（含普通拒绝）继续原路径。真正没有可验证主体/回执而带错误标志的原工具生成 `mcp.call-unattributed`，只说明原结果需核对：不能证明发生在校验前、没有执行、已回滚或任务失败。不复制参数、正文、异常、路径、推测实体或调用方。record scope 的工作区/run 是**观察位置**，不是业务主体；target 仅为验证过的原生会话/块/条目，没有伪造 `target.mcpWrite`。空 content 的确切错误 envelope 也能作为标志证据；矛盾的 native server/tool metadata、不匹配的观察 Composer、无原生出处或旧安装不能被强接入。后来成功不自动解决过去的未知业务结果。

没有第二个 projection、持久 source 表或多一次 sourceState 查询。known writes 与 unknown calls 共用原 `mcp-write-source` 的 checkpoint/CAS、seen 和 attentionFamilies；unknown 只能用原 100 draft 预算的剩余额度，旧 bare/inspected 标记不擅自转换。总 seen≤20k、families≤10k、原 2MiB 上限不扩大。有界 working cache 仍是原引用/签名记忆化，idle observer 不写增长、通知不等待业务链。

两轮新增失败证据分别在 `mcp-unattributed-boundary-reproduction.log`、`mcp-unattributed-cache-family-reproduction.log`、`mcp-unattributed-wrapper-cache-reproduction.log`、`mcp-unattributed-origin-reproduction.log`：混合分批原先把 50 个旧错误造为新未读；被忽略的 cold stock 原先会消费同一长 turn 后续首次真实错误的提醒；已完成气泡原地翻转标志会被缓存吞掉；旧 Composer/旧安装的晚结果会被借给新观察身份。这些不是通过放宽断言处理。共用 v2 checkpoint 增加一个可选的首启 `unattributedBaselineAt`，旧检查点在首次激活时建立、跨批/CAS/未知 ACK/重启保持；重启不能吞掉首启之后的真正漏收调用。stock 只记去重，不占提醒 family；同 native turn/tool 重复错误只有首条 notice，其余 activity，新真实 turn 不被旧 family 吞掉。清理/归档/重启不复活旧记录。

最终 `mcp-unattributed-focused-final.log`（包含 desktop、原 MCP、renderer read、center/toast 回归）、`mcp-unattributed-full-regression-final.log`（323 files、3094 passed、1 skipped）、`mcp-unattributed-typecheck-final.log`、`mcp-unattributed-build-final.log`、`mcp-unattributed-dead-code-final.log`。新增 verifier 的实际 compiled private worker 验收加入 28 类 Node/macOS Electron as-node 矩阵，见 `mcp-unattributed-verification-matrix-final.log`；另外隔离 Electron quit、原 MCP/channel smoke 通过。原 API 调用/reader/CDP command 数不增加，只有一个原 source，实际 worker 重启后已清理/归档不复活，漏收新调用仍可恢复，240 新＋50 stock 的事务预算保持，原 user_version 与无关数据保留。不是实际 Cursor 原库恢复或 Windows/OS 送达验收。

纯 preview 的新场景使用产品 reducer/组件，不连接 SDK、账户、Cursor 或系统通知。真实 CUA 在默认 984×554 与实际 320×600 暗色验收完整提示、没有新增左彩轨/胶囊、完整范围标签与换行；`查看原工具` 实际揭示精确原条目和块，不止修改按钮文案。只展开原未知工具正文仍保留未读；显式在中心阅读才消费此通知，不能冒充已验证业务结果。截图/DOM/交互证据在 `ui/mcp-unattributed-*.png`、`ui/mcp-unattributed-audit.json`，日志为空。自己的 tab、viewport/media 覆盖和纯 preview server 清理；`protected-mcp-unattributed-audit.json` 核对两保护树逐文件/HEAD/porcelain/binary diff 与四个既有删除。只本地提交，没有 push、发版、安装、用户软件/Cursor 重启或真实模型/账号/OS 通知。

**完整目标仍 active，未完成**：本批只接入有合法原生 flag/观察来源的结果；没有原生工具/过程帧、只剩静默或已丢身份时，不得推测业务失败或修造调用主体。真实 Cursor 原库恢复重核、旧格式失去的身份与混合历史、完整布局/长期容量/正式包及 Windows/macOS 真权限、声音、勿扰和系统送达仍继续，上文完整要求不缩减。
