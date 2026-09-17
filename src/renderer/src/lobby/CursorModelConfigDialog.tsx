import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import {
  cursorModelParameterLabel,
  cursorModelParameterValue,
  cursorModelAutomaticChanges,
  cursorModelSelectionFromOption,
  fixedCursorModelContext,
  withCursorModelMaxMode,
  withCursorModelParameter
} from '../cursor-model-selection'
import { MenuSelect } from './MenuSelect'
import { ToggleSwitch } from './ToggleSwitch'
import { modelProviderClass } from '../model-provider'

/**
 * 弹层的作用范围：单个席位（可顺带同步到其余席位），或一次为全部席位统一配置。
 * `othersCount` > 0 时页脚出现「同时应用到其余 N 个席位」开关。
 */
export type CursorModelConfigScope =
  | { kind: 'seat'; channelId: string; othersCount?: number }
  | { kind: 'all'; count: number }

interface CursorModelConfigDialogProps {
  scope: CursorModelConfigScope
  models: CursorModelOption[]
  selection?: CursorModelSelection
  disabled?: boolean
  /** `applyToAll`：范围为全部席位，或用户勾了同步开关——调用方把同一份配置写到每个席位。 */
  onSave: (selection: CursorModelSelection, options: { applyToAll: boolean }) => Promise<void> | void
  onClose: () => void
}

export function CursorModelConfigDialog({
  scope,
  models,
  selection,
  disabled = false,
  onSave,
  onClose
}: CursorModelConfigDialogProps): React.JSX.Element {
  const initialOption = models.find((model) => model.modelId === selection?.modelId)
    ?? models.find((model) => model.selected)
    ?? models[0]
  const [draft, setDraft] = useState<CursorModelSelection | undefined>(() => (
    selection ? structuredClone(selection) : cursorModelSelectionFromOption(initialOption)
  ))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [linkNotice, setLinkNotice] = useState('')
  const [syncOthers, setSyncOthers] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  const option = models.find((model) => model.modelId === draft?.modelId)
    ?? initialOption
  const resolvedSelection = draft ?? cursorModelSelectionFromOption(option)
  const fixedContext = fixedCursorModelContext(option, resolvedSelection)

  // 单席位弹层沿用 CH-x 口径（aria 与文案）；统一配置弹层用「全部席位」。
  const subject = scope.kind === 'all' ? '全部席位' : `CH-${scope.channelId}`
  const othersCount = scope.kind === 'seat' ? scope.othersCount ?? 0 : 0
  const applyToAll = scope.kind === 'all' || (othersCount > 0 && syncOthers)
  const targetCount = scope.kind === 'all' ? scope.count : othersCount + 1
  const saveLabel = scope.kind === 'all'
    ? `应用到 ${scope.count} 个席位`
    : applyToAll
      ? `保存到 ${targetCount} 个席位`
      : '保存'

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, saving])

  // 打开时把焦点收进弹层，关闭后还给触发它的那个按钮——否则键盘用户得从页首重新 Tab 回来。
  useEffect(() => {
    const opener = document.activeElement
    dialog.current?.focus()
    return () => { if (opener instanceof HTMLElement) opener.focus() }
  }, [])

  /** Tab 在弹层内循环。模型下拉的列表挂在 body 上（React 事件仍会冒泡到这里）：焦点在列表里时不拦。 */
  const keepTabInside = (event: React.KeyboardEvent): void => {
    const root = dialog.current
    if (event.key !== 'Tab' || !root || !root.contains(event.target as Node)) return
    const stops = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    const leaving = event.shiftKey ? active === first || active === root : active === last
    if (!leaving) return
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }

  const save = async (): Promise<void> => {
    if (!resolvedSelection || saving) return
    setSaving(true)
    setSaveError('')
    try {
      await onSave(resolvedSelection, { applyToAll })
      onClose()
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="cursor-model-dialog__backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <section
        ref={dialog}
        aria-label={`${subject} 会话配置`}
        aria-modal="true"
        className={`cursor-model-dialog${scope.kind === 'all' ? ' is-all' : ''}`}
        role="dialog"
        tabIndex={-1}
        onKeyDown={keepTabInside}
      >
        <header>
          {scope.kind === 'all' ? (
            <span><small>Agent 会话 · 统一配置</small><strong>全部 {scope.count} 个席位 · 模型与参数</strong></span>
          ) : (
            <span><small>Agent 会话</small><strong>CH-{scope.channelId} · 模型与参数</strong></span>
          )}
          <button aria-label="关闭会话配置" disabled={saving} onClick={onClose}>×</button>
        </header>
        <div className="cursor-model-dialog__body">
          <div className="cursor-model-dialog__model">
            <span>Model</span>
            <MenuSelect
              ariaLabel={`${subject} 弹层模型`}
              disabled={disabled || saving || !models.length}
              value={option?.modelId ?? ''}
              options={models.map((model) => ({
                value: model.modelId,
                label: model.displayName,
                tone: modelProviderClass(model.modelId, model.displayName)
              }))}
              onChange={(modelId) => {
                const next = cursorModelSelectionFromOption(models.find((model) => model.modelId === modelId))
                if (next) {
                  setDraft(next)
                  setLinkNotice('')
                }
              }}
            />
          </div>
          {option?.parameterDefinitions.map((definition) => {
            const label = cursorModelParameterLabel(definition)
            const current = cursorModelParameterValue(resolvedSelection, option, definition)
            return (
              <div className="cursor-model-option" key={definition.id} title={definition.tooltip}>
                <header><span>{label}</span></header>
                <div role="group" aria-label={`${subject} 弹层${label}`}>
                  {definition.values.map((value) => (
                    <button
                      type="button"
                      key={value.value}
                      className={current === value.value ? 'is-active' : ''}
                      aria-label={`${subject} 弹层${label} ${value.displayName}`}
                      aria-pressed={current === value.value}
                      disabled={disabled || saving || !resolvedSelection}
                      onClick={() => {
                        if (!resolvedSelection) return
                        const next = withCursorModelParameter(
                          resolvedSelection,
                          option,
                          definition.id,
                          value.value
                        )
                        const linked = cursorModelAutomaticChanges(
                          resolvedSelection,
                          next,
                          option,
                          definition.id
                        )
                        setLinkNotice(linked.length ? `Cursor 联动：${linked.join(' · ')}` : '')
                        setDraft(next)
                      }}
                    >
                      <span>{value.displayName}</span>
                      {value.increasesCost ? <i>High cost</i> : null}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {option?.supportsMaxMode && resolvedSelection ? (
            <div className="cursor-model-dialog__max-mode">
              <span><b>MAX Mode</b><small>{resolvedSelection.maxMode ? 'Maximum context' : 'Standard context'}</small></span>
              <ToggleSwitch
                checked={resolvedSelection.maxMode === true}
                disabled={disabled || saving}
                label={`${subject} MAX Mode`}
                onChange={(checked) => {
                  const next = withCursorModelMaxMode(resolvedSelection, option, checked)
                  const linked = cursorModelAutomaticChanges(resolvedSelection, next, option, 'maxMode')
                  setLinkNotice(linked.length ? `Cursor 联动：${linked.join(' · ')}` : '')
                  setDraft(next)
                }}
              />
            </div>
          ) : null}
          {fixedContext ? (
            <div className="cursor-model-dialog__fixed"><span>Context</span><b>{fixedContext}</b></div>
          ) : null}
          {linkNotice ? <p className="cursor-model-dialog__linked" role="status">{linkNotice}</p> : null}
          {saveError ? <em className="cursor-model-dialog__error" role="alert">{saveError}</em> : null}
          <p>
            {scope.kind === 'all'
              ? `保存后 ${scope.count} 个席位下一次新建 Composer 都用这套配置，不改变 Cursor 全局模型。`
              : applyToAll
                ? `保存到 CH-${scope.channelId} 及其余 ${othersCount} 个席位的新建 Composer，不改变 Cursor 全局模型。`
                : `保存到 CH-${scope.channelId} 新建 Composer，不改变 Cursor 全局模型。`}
          </p>
        </div>
        <footer>
          {scope.kind === 'seat' && othersCount > 0 ? (
            <ToggleSwitch
              checked={syncOthers}
              disabled={disabled || saving}
              title="其余席位下一次新建会话也用这套模型与参数"
              onChange={setSyncOthers}
            >
              同时应用到其余 {othersCount} 个席位
            </ToggleSwitch>
          ) : null}
          <button disabled={disabled || saving || !resolvedSelection} onClick={() => void save()}>{saving ? '保存中…' : saveLabel}</button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
