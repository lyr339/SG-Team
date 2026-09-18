import { join } from 'node:path'

/** 数据目录名（打包 / 开发各一份，互不串数据）。 */
export const USER_DATA_DIRECTORY_NAME = 'sg-team'

/**
 * 解析 Electron userData 目录：`<appData>/sg-team`（打包）或 `<appData>/sg-team-dev`（开发）。
 * 上一代品牌目录（`qingtian-team`）的原地改名迁移在 2026-09-06 随品牌统一落地、先于首个对外
 * 版本 v0.2.0（09-13），对外用户从未持有旧目录名，迁移代码已于 2026-09-18 清理。
 */
export function resolveUserDataDirectory(appDataRoot: string, packaged: boolean): string {
  return join(appDataRoot, `${USER_DATA_DIRECTORY_NAME}${packaged ? '' : '-dev'}`)
}
