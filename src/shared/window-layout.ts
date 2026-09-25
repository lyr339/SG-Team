/** 单位为 CSS/Electron 逻辑像素；原生窗口与嵌套分栏共用同一空间预算。 */
export const SESSION_CONTENT_MIN_WIDTH = 500
export const SESSION_SIDEBAR_SPEC = { defaultSize: 326, minSize: 300, maxSize: 560 } as const
export const SESSION_INSPECTOR_SPEC = { defaultSize: 540, minSize: 320, maxSize: 1200 } as const
export const WINDOW_MIN_WIDTH = 1440
// 最小窗口仍可同时展示左右栏；中栏在 500px 前由容器查询收拢工具条，不靠隐藏整栏腾空间。
