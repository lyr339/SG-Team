# 拾光通知系统交付审查

2026-10-07。对应 `feat/notification-system`，沿原完整需求收口，不新增编号批次。实现代码基线 `f6a0ca0`；最终修复 Windows 跨平台打包误用宿主 Electron 的问题。

## 需求与实际证据

| 原需求 | 实现与验证入口 | 结论 |
| --- | --- | --- |
| 会话上线、疑似/确认离线、恢复、正常结束；初始基线及睡眠恢复不误报 | `session-lifecycle-notifications`、`connect-session-notifications`、`cursor-restart-notification-observation` 测试；原 main 的会话/power 订阅 | 已覆盖领域与接线序列；没有另写心跳或网络探测 |
| 批量发起与自动化并行，混合结果、取消、仅处理、清场/换号晚到与未知恢复 | `batch-launch-notifications`、`automation-notifications`、`automation-notification` 测试及 adapter | 使用原 attempt 与结构化效果，不等通知、不补跑业务 |
| 问卷/审批、回复、排队及上下文交接 | question/reply/queue 领域与 adapter；question/reply/queue 身份和恢复的 compiled-worker verifier | 原实体/正文版本核对；人类阅读、业务回执和处理终态独立 |
| 团队任务、明确发给人的消息、组关系及记忆请求 | task/operator-message/group-effects/memory 测试、source-read hook 与对应 worker verifier | 保留原 scope、原页精确定位；旧 CH、旧正文、原记录缺失不误跳或补答 |
| 账号/导入/处理服务/维护/清理/文件等跨页面结果 | `page-operation-notifications`、原 IPC 的 fail-soft operation observation、workspace/compatibility/usage adapters | 就地反馈优先；隐藏页与离页结果不串页，异常不写原始凭据 |
| 更新的查看、延后、跳过、下载与安装门禁等价 | app-update adapter/domain 测试、DesktopShell 旧提醒 fallback 与唯一 NotificationSystem 宿主 | 沿原更新服务，未复制更新器或自动安装 |
| 一张低打扰提醒、中心历史、来源/类别/会话偏好与定时安静 | store/center/preferences/toast/visible/navigation 测试 | 关闭、已读、延后、归档和业务解决独立；焦点/悬停暂停、失效不补播 |
| 中性精致表面、无左彩轨、长文与窄窗、深浅/透明背景、键盘与减少动画 | CSS 契约与真实 CUA；`ui/scope-text-safety-*`、`ui/native-lifecycle-*` 与本次 `acceptance/ui-actual-200-*` | 本次实际 Electron `setZoomFactor(2)` 检查，非 DPR 冒充缩放；范围文字完整、footer 可达、设置可滚动 |
| 私有存储、保留/清理、失效身份、并发/未知回执/退出恢复与长期去重 | schema 9、reply v4/question v3、source/transaction/read/worker/shutdown 测试；33 类双 runtime fixtures | 索引化 opaque claim 不因 1024 热窗口遗忘；v1 未知正文不伪造；业务库和权限不受通知失败影响 |
| Windows/macOS 原生 API 与唯一渠道选择 | `native-notification-port`、delivery policy/service、native-open 测试；实际 SDK 生命周期 verifier | Windows timed-out 与真实删除分开；私有 epoch 撤销旧点击；show 回执不等于权限或人类已读 |
| 可分发的两平台包与正确运行时/应用标识 | `packaging-platform`、`verify-notification-packages.mjs` 与实际 builder 产物 | Mac arm64、Windows x64 app + NSIS/blockmap 已产出，包内 worker/preload/renderer/MCP 与当前编译字节一致 |
| 不干扰其他任务/目录，不制造常驻进程或临时垃圾 | 保护树源文件/HEAD/status/binary diff；隔离退出与 owned-resource finally 清理 | 不启动生产 main，不重启 Cursor，不使用账号或模型；不新增网络业务、守护程序或通知驱动的重试 |

## 本次实际产物

- `release/ShiGuang-0.5.15-mac-arm64.zip`：本地 ad-hoc 签名校验通过，不声称 Developer ID/公证。
- `release/ShiGuang-Setup-0.5.15.exe` 与 `.blockmap`：真实 Windows NSIS 安装器；所含 `win-unpacked/ShiGuang.exe` 为 PE32+ x64，而非误复制的 Mac runtime。
- `acceptance/packages.json`：ASAR 和分发产物 SHA-256、包内编译文件核对、已打包 Mac embedded Node/worker/claims/MCP 实际运行记录。

这些是通知开发分支的本地交付检查包，不是新公开 release；没有推送、上传、覆盖已安装软件或触发内部更新。

## 原生实测的事实边界

用户允许了一条本机静音通知。独立 bundle/profile、实际包内 worker 和正式 native port 的记录为：requests=1、show 回执=1、failed=0，原通知仍 unread=1。没有修改权限、响铃/勿扰，读取账号或启动 Cursor；布局进程严禁再发通知。

可访问的 Notification Center AX 视图未呈现匹配的测试卡，因此**未证明物理横幅显示或实际点击恢复**；不能从 show 回执推断权限获准或 OS 一定展示。不再次发送、不清理其他系统通知、不修改用户系统设置来强求绿色结果。

Windows 的工程适配、真实运行时/安装包和 SDK 事件契约已核验；**没有 Windows 原生桌面执行证据**。按用户明确要求，不再索要 Windows 环境或让同事运行额外验收包。此事实限制不改写为“Windows 真机通过”。

## 审查结论

实现和工程交付检查已收口；原生桌面物理表现的未验证部分如上保留，不通过扩大功能或无限追加边界批次来回避。最终回归、类型、dead-code、包校验及目录保护证据保存在 `preview-screenshots/notification-implementation/acceptance/`。是否满足整套目标的完成判据必须依据这里明确的验证级别，不能把工程验收通过冒充全部实机情形已完成。
