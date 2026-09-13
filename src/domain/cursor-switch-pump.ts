/** 切号泵补丁（ZMO_SWITCH_V1）的共享类型：IPC 契约与安装器实现的单一出处。 */

export interface CursorSwitchPumpStatus {
  /**
   * installed    补丁在位且配置可解析（含 port/key）；
   * not-installed 未安装但当前 Cursor 版本锚点支持安装；
   * unsupported   当前 Cursor 版本认不出鉴权构造器锚点（装不了）；
   * unavailable   bundle 找不到/读不到。
   */
  kind: 'installed' | 'not-installed' | 'unsupported' | 'unavailable'
  bundlePath?: string
  config?: { port: number; key: string; revision: number }
  /** true 表示由拾光当前安装器写入；false 表示可复用的外部兼容泵。 */
  managed?: boolean
  message: string
}

export interface CursorSwitchPumpOutcome {
  ok: boolean
  changed: boolean
  message: string
  /** 重签名/校验和同步等 best-effort 步骤的警告（不阻断安装结果）。 */
  warning?: string
}
