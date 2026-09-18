/**
 * 输入区高度模型：内容自适应 + 用户手动拖高。
 *
 * - 内容高度：textarea 的 scrollHeight，随行数增长；
 * - 手动高度：用户拖动输入区上边缘设定的「最低高度」（持久化）；内容更多时仍继续长高，
 *   内容变少时回落到手动高度而不是默认高度——用户拖大是为了得到更大的写作区；
 * - 上限：按视口比例封顶，超过后 textarea 内部滚动，永不把时间线挤没。
 */
export const COMPOSER_TEXTAREA_MIN_HEIGHT = 58
export const COMPOSER_TEXTAREA_MAX_RATIO = 0.45
export const COMPOSER_TEXTAREA_MAX_FLOOR = 160
export const COMPOSER_TEXTAREA_MAX_CEILING = 560
export const COMPOSER_HEIGHT_STORAGE_KEY = 'sg-team.layout:v1:composer-height'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

/** 视口越高允许输入区越高，但有下限/上限，避免小窗口被输入区吃满或大屏无限拉长。 */
export function composerMaxHeight(viewportHeight: number): number {
  const ratio = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight * COMPOSER_TEXTAREA_MAX_RATIO
    : COMPOSER_TEXTAREA_MAX_FLOOR
  return clamp(ratio, COMPOSER_TEXTAREA_MAX_FLOOR, COMPOSER_TEXTAREA_MAX_CEILING)
}

/** 手动高度夹紧到 [最小, 视口上限]。 */
export function clampManualHeight(height: number, viewportHeight: number): number {
  return clamp(height, COMPOSER_TEXTAREA_MIN_HEIGHT, composerMaxHeight(viewportHeight))
}

export function resolveComposerHeight(input: {
  contentHeight: number
  manualHeight?: number
  viewportHeight: number
}): number {
  const floor = input.manualHeight === undefined
    ? COMPOSER_TEXTAREA_MIN_HEIGHT
    : clampManualHeight(input.manualHeight, input.viewportHeight)
  const content = Number.isFinite(input.contentHeight) ? input.contentHeight : 0
  return clamp(Math.max(floor, content), COMPOSER_TEXTAREA_MIN_HEIGHT, composerMaxHeight(input.viewportHeight))
}

/** 上边缘向上拖 = 变高：pointer 的 clientY 减小。 */
export function dragManualHeight(startHeight: number, startClientY: number, clientY: number, viewportHeight: number): number {
  return clampManualHeight(startHeight + (startClientY - clientY), viewportHeight)
}

/**
 * 预算回收：工作区网格放不下（时间线已压到下限、附件条/警示条/错误行等把发送栏推出
 * 窗口）时，溢出多少就从 textarea 让出多少——输入区里唯一无界的高度来源是 textarea，
 * 其余（工具条 / 附件条 / 发送栏）都是内容自身的合理高度，不该被裁。
 * 让到最小高度为止；仍放不下属于窗口小于应用最小尺寸的病理场景，交给外层裁切。
 */
export function shrinkComposerHeightByOverflow(height: number, overflowPx: number): number {
  if (!Number.isFinite(overflowPx) || overflowPx <= 0) return height
  return Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, Math.round(height - overflowPx))
}

export function readStoredComposerHeight(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): number | undefined {
  try {
    const raw = storage?.getItem(COMPOSER_HEIGHT_STORAGE_KEY)
    if (!raw) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= COMPOSER_TEXTAREA_MIN_HEIGHT ? Math.round(parsed) : undefined
  } catch {
    return undefined
  }
}

export function storeComposerHeight(height: number | undefined, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeStorage()): void {
  try {
    if (height === undefined) storage?.removeItem(COMPOSER_HEIGHT_STORAGE_KEY)
    else storage?.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(Math.round(height)))
  } catch {
    // 本次运行内仍生效。
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
