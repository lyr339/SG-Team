import { createContext, useCallback, useContext, useEffect, useId, useRef, type ReactNode } from 'react'

export type InspectorTabId = 'review' | 'plan' | 'activity' | 'artifacts'

export interface InspectorTabSpec {
  id: InspectorTabId
  label: string
  icon: ReactNode
  /** 计数徽章：该面板顶层列出的条目数；0 / undefined 不显示。 */
  badge?: number
  title?: string
}

interface InspectorShellProps {
  tabs: readonly InspectorTabSpec[]
  activeTab: InspectorTabId
  onTabChange: (tab: InspectorTabId) => void
  onClose: () => void
  children: ReactNode
}

export const INSPECTOR_TAB_STORAGE_KEY = 'sg-team.inspector:active-tab'
export const INSPECTOR_TAB_IDS: readonly InspectorTabId[] = ['review', 'plan', 'activity', 'artifacts']

/** 读取持久化标签；兼容旧值 `todos`（Plan 面板的前身）。 */
export function readStoredInspectorTab(): InspectorTabId {
  try {
    const stored = localStorage.getItem(INSPECTOR_TAB_STORAGE_KEY)
    if (stored === 'todos') return 'plan'
    return INSPECTOR_TAB_IDS.includes(stored as InspectorTabId) ? stored as InspectorTabId : 'review'
  } catch {
    return 'review'
  }
}

export function storeInspectorTab(tab: InspectorTabId): void {
  try { localStorage.setItem(INSPECTOR_TAB_STORAGE_KEY, tab) } catch { /* 当前窗口仍保持选择。 */ }
}

/** 快捷键提示平台化：mac 显示 ⌥，其余平台显示 Alt+；事件侧统一认 altKey。 */
export function inspectorTabShortcutLabel(index: number): string {
  const mac = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'darwin'
  return `${mac ? '⌥' : 'Alt+'}${index + 1}`
}

interface ShellContextValue {
  baseId: string
  activeTab: InspectorTabId
}

const ShellContext = createContext<ShellContextValue | undefined>(undefined)

/**
 * 单个标签的内容面板。四个面板全部常驻挂载：切走的面板 `hidden`，切回来时滚动位置、
 * 展开状态、已加载的差异都还在；display 从 none 翻回 block 会重新触发进场动画，
 * 于是「切换有轻微位移淡入」与「状态不丢」同时成立。
 */
export function InspectorPanel({ tab, children }: { tab: InspectorTabId; children: ReactNode }): React.JSX.Element {
  const shell = useContext(ShellContext)
  if (!shell) throw new Error('InspectorPanel 必须放在 InspectorShell 内')
  const active = shell.activeTab === tab
  return (
    <div
      className={active ? 'inspector-panel' : 'inspector-panel is-hidden'}
      role="tabpanel"
      id={`${shell.baseId}-panel-${tab}`}
      aria-labelledby={`${shell.baseId}-tab-${tab}`}
      hidden={!active}
    >
      {children}
    </div>
  )
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable))
}

/** 计数徽章文案：超过 99 只显示 99+。 */
function badgeText(badge: number | undefined): string | undefined {
  return badge ? (badge > 99 ? '99+' : String(badge)) : undefined
}

/**
 * 右栏壳：标签行（WAI-ARIA tabs，方向键 / Home / End 漫游焦点，⌥1–4 直达）、
 * 关闭按钮、内容区。
 *
 * 标签是「图标常驻、文字按需展开」的胶囊：四个标签平时只露图标，被选中的那个原地
 * 长出胶囊底板，标题与计数从图标右侧滑出（CSS `grid-template-columns: 0fr → 1fr`），
 * 切走时同样滑回图标。选中态完全由按钮自身承担——没有需要测量、异步跟随的独立指示条，
 * 展开动画期间也不会出现底板与文字错位。文字与计数始终在 DOM 里（可访问名称 / 测试不变），
 * 收起时只是视觉宽度为 0。
 *
 * Esc 在面板内任意位置按下都关闭右栏（输入框内除外，让输入框自己处理）。
 */
export function InspectorShell({ tabs, activeTab, onTabChange, onClose, children }: InspectorShellProps): React.JSX.Element {
  const baseId = useId()
  const tabRefs = useRef<Map<InspectorTabId, HTMLButtonElement>>(new Map())

  const focusTab = useCallback((tab: InspectorTabId): void => {
    onTabChange(tab)
    tabRefs.current.get(tab)?.focus()
  }, [onTabChange])

  useEffect(() => {
    storeInspectorTab(activeTab)
  }, [activeTab])

  // ⌥1–4（Windows：Alt+1–4）直达标签：右栏可见时才挂载本组件，快捷键随之生效。
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
      const match = /^Digit([1-9])$/.exec(event.code)
      if (!match) return
      const tab = tabs[Number(match[1]) - 1]
      if (!tab || isTypingTarget(event.target)) return
      event.preventDefault()
      onTabChange(tab.id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onTabChange, tabs])

  const onTabListKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const ids = tabs.map((tab) => tab.id)
    const index = ids.indexOf(activeTab)
    if (index < 0) return
    let next: InspectorTabId | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = ids[(index + 1) % ids.length]
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = ids[(index - 1 + ids.length) % ids.length]
    else if (event.key === 'Home') next = ids[0]
    else if (event.key === 'End') next = ids[ids.length - 1]
    if (!next) return
    event.preventDefault()
    focusTab(next)
  }

  const onShellKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || isTypingTarget(event.target)) return
    // 面板内部的弹层（确认框）先消费 Escape：它们会 stopPropagation。
    event.preventDefault()
    onClose()
  }

  return (
    <ShellContext.Provider value={{ baseId, activeTab }}>
      <aside className={`workspace-inspector${activeTab === 'review' ? ' is-review' : ''}`} aria-label="会话辅助工作区" onKeyDown={onShellKeyDown}>
        <header className="workspace-inspector__bar">
          <div className="workspace-inspector__tabs" role="tablist" aria-label="辅助工作区标签" onKeyDown={onTabListKeyDown}>
            {tabs.map((tab, index) => {
              const selected = tab.id === activeTab
              const badge = badgeText(tab.badge)
              // 收起时数字不可见：把计数放进悬停提示，仍然一眼可查。
              const title = [tab.title ?? tab.label, badge ? `${badge} 项` : undefined, inspectorTabShortcutLabel(index)]
                .filter(Boolean).join(' · ')
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    if (element) tabRefs.current.set(tab.id, element)
                    else tabRefs.current.delete(tab.id)
                  }}
                  id={`${baseId}-tab-${tab.id}`}
                  className={`inspector-tab${selected ? ' is-active' : ''}`}
                  role="tab"
                  type="button"
                  aria-label={tab.label}
                  aria-selected={selected}
                  aria-controls={`${baseId}-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  title={title}
                  onClick={() => onTabChange(tab.id)}
                >
                  <span className="inspector-tab__icon">
                    {tab.icon}
                  </span>
                  <span className="inspector-tab__reveal">
                    <span className="inspector-tab__text">
                      <span className="inspector-tab__label">{tab.label}</span>
                      {badge ? <b className="inspector-tab__badge">{badge}</b> : null}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          <button className="workspace-inspector__close" type="button" aria-label="收起右侧工作区" title="收起右侧工作区（Esc）" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" /></svg>
          </button>
        </header>
        <div className="workspace-inspector__body">
          {children}
        </div>
      </aside>
    </ShellContext.Provider>
  )
}
