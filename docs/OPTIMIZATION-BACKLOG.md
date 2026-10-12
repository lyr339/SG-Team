# 维护与后续工作

当前架构以 [ARCHITECTURE.md](ARCHITECTURE.md) 和实际代码为准。这里仅保留尚需评估的方向，不复用旧任务书里的完成状态、测量数字或开工指令。

## 持续维护

- **大模块边界**：`App.tsx`、`desktop-session-service.ts`、`cursor-stream-observer.ts` 与大型样式文件仍需渐进拆分。优先随功能变更收敛职责，不为减少行数改写已验证的业务链。
- **长会话性能**：补充大规模过程、附件与通知的长时间基准。已完成的折叠历史懒挂载不等于首次展开没有开销；进一步虚拟化必须保留定位、复制、问卷与编辑状态。
- **打包体积**：先测量实际依赖贡献，再评估按需加载；设计预览不得进入生产包。
- **原生体验**：持续复核 macOS/Windows 的系统通知、安装升级与高 DPI 布局。共享 renderer 回归不替代系统层实机验收。

## 未并入当前主线的方案

- **统计页后续设计**：月度范围、明细导出和图表尺度等方案曾在 `feat/stats-refine` 分支开展；本轮不合并或删除该分支的工作。实施前重新核对现有主线和产品需求，[原任务书](https://github.com/lyr339/SG-Team/blob/v0.5.28/.handoff/STATS-PAGE-REFINE-TODO.md) 仅供追溯。
- **独立软件授权系统**：早期方案尚未落地，不能当作当前功能或已获确认的实施指令。若继续，需重新确认范围与数据边界；[原方案](https://github.com/lyr339/SG-Team/blob/v0.5.28/docs/LICENSE-SYSTEM.md) 留在 Git 历史。

## 清理边界

- `build/` 是图标与打包资源，不是可随手删除的编译输出；生成源在 `docs/design/sg-monogram/`。
- `packages/cursor-wire-runtime/` 是本地运行依赖；`scripts/fixtures/` 与 `tests/` 中的隔离样本仍承担回归验证。
- 旧数据迁移、旧补丁检测/停用/移除属于兼容能力，不能仅因名字带 `legacy` 就删除。
- 已完成阶段任务书和一次性诊断脚本从当前分支移除，通过 Git 历史追溯，不再复制进新的归档目录。
