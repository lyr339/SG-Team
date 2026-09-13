import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS,
  CHAT_HISTORY_OLDER_THAN_OPTIONS,
  CURSOR_STORAGE_CATALOG,
  buildCleanupPlan,
  cursorStorageRiskLabel,
  type CursorStorageItemId,
  type CursorStorageItemSpec,
  type CursorStorageScan,
  type CursorStorageScanEntry
} from '../../../domain/cursor-storage-cleanup'
import { formatFileSize } from '../../../shared/format-file-size'
import { MenuSelect } from '../lobby/MenuSelect'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { formatFullClock } from '../format'
import type { SettingsPageProps } from './settings-view'
import { SettingsSection } from './SettingsSection'

type CleanupProps = Pick<SettingsPageProps,
  | 'storageScan' | 'storageScanBusy' | 'storageScanError' | 'storageCleanupBusy' | 'storageCleanupResult'
  | 'onScanCursorStorage' | 'onCleanCursorStorage' | 'onRevealCursorStorage'
> & { active?: boolean }

/** 默认预选：可放心、且此刻就能执行的项（Cursor 已退出时含缓存/日志）——打开面板就能直接清。 */
function defaultSelection(scan: CursorStorageScan): Set<CursorStorageItemId> {
  const selected = new Set<CursorStorageItemId>()
  for (const spec of CURSOR_STORAGE_CATALOG) {
    if (spec.diagnostic || spec.risk !== 'low') continue
    if (spec.needsCursorClosed && scan.cursorRunning !== false) continue
    const entry = scan.entries.find((item) => item.id === spec.id)
    if (entry?.cleanable) selected.add(spec.id)
  }
  return selected
}

function runningLabel(scan: CursorStorageScan): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (scan.cursorRunning === true) return { text: 'Cursor 正在运行 · 标「需退出」的项要先退出 Cursor', tone: 'warn' }
  if (scan.cursorRunning === false) return { text: 'Cursor 已退出 · 全部项都可以清理', tone: 'ok' }
  return { text: '无法确认 Cursor 是否在运行 · 需退出的项暂不可清理', tone: 'muted' }
}

interface RowProps {
  spec: CursorStorageItemSpec
  entry: CursorStorageScanEntry | undefined
  scan: CursorStorageScan
  selected: boolean
  blockedReason?: string
  disabled: boolean
  onToggle: (checked: boolean) => void
  onReveal?: () => void
  children?: React.ReactNode
}

function CleanupRow({ spec, entry, scan, selected, blockedReason, disabled, onToggle, onReveal, children }: RowProps): React.JSX.Element {
  const cleanable = Boolean(entry?.cleanable)
  const blocked = Boolean(blockedReason) && cleanable
  const tone = spec.diagnostic ? 'is-diagnostic' : !cleanable ? 'is-empty' : blocked ? 'is-blocked' : selected ? 'is-selected' : ''
  const bytes = entry?.bytes ?? 0
  const sizeText = spec.id === 'chat-history' && bytes > 0 ? `约 ${formatFileSize(bytes)}` : bytes > 0 ? formatFileSize(bytes) : '—'
  const lockNeeded = spec.needsCursorClosed && !spec.diagnostic && scan.cursorRunning !== false
  return (
    <li className={`storage-cleanup__row ${tone}`.trim()} data-item={spec.id}>
      <label className="storage-cleanup__pick">
        {spec.diagnostic ? (
          <i className="storage-cleanup__pick-placeholder" aria-hidden="true" />
        ) : (
          <input
            type="checkbox"
            /* 重新盘点后失去可清理内容的项不再显示为「勾着但禁用」：勾选态只反映会被执行的事实。 */
            checked={selected && cleanable}
            disabled={disabled || !cleanable}
            aria-label={`清理${spec.label}`}
            onChange={(event) => onToggle(event.target.checked)}
          />
        )}
      </label>
      <div className="storage-cleanup__copy">
        <div className="storage-cleanup__title">
          <strong>{spec.label}</strong>
          <em className={`storage-cleanup__risk is-${spec.risk}`}>{cursorStorageRiskLabel(spec.risk)}</em>
          {lockNeeded ? <em className="storage-cleanup__lock">需退出 Cursor</em> : null}
          {entry?.partial ? <em className="storage-cleanup__partial" title="有读不到的部分，体量偏小">部分</em> : null}
        </div>
        <p className="storage-cleanup__summary">{spec.summary}</p>
        {entry?.note ? <p className="storage-cleanup__note">{entry.note}</p> : null}
        {selected && !spec.diagnostic ? <p className="storage-cleanup__loss">清掉后：{spec.loss}</p> : null}
        {blocked && selected ? <p className="storage-cleanup__blocked" role="status">{blockedReason}</p> : null}
        {children}
      </div>
      <div className="storage-cleanup__meta">
        <b className="storage-cleanup__size">{sizeText}</b>
        {onReveal ? (
          <button type="button" className="storage-cleanup__reveal" onClick={onReveal} title="在文件管理器中定位">定位</button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * 存储清理：盘点 → 勾选 → 确认 → 执行。数字全部来自主进程的最新一次扫描；
 * 计划（哪些能清、合计多少、哪些不可恢复）与主进程共用同一份领域规则。
 */
export function SettingsCleanup({
  active = true,
  storageScan,
  storageScanBusy = false,
  storageScanError,
  storageCleanupBusy = false,
  storageCleanupResult,
  onScanCursorStorage,
  onCleanCursorStorage,
  onRevealCursorStorage
}: CleanupProps): React.JSX.Element | null {
  const [selected, setSelected] = useState<Set<CursorStorageItemId>>()
  const [olderThanDays, setOlderThanDays] = useState<number>(CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS)
  const [compact, setCompact] = useState(false)
  const [confirming, setConfirming] = useState(false)
  /** 已收起的结果横幅：按对象引用记忆，新一次清理的结果会重新显示。 */
  const [dismissedResult, setDismissedResult] = useState<CleanupProps['storageCleanupResult']>()
  const confirmCancelRef = useRef<HTMLButtonElement>(null)
  const primaryButtonRef = useRef<HTMLButtonElement>(null)

  // 确认块出现时焦点移入取消键；Escape / 取消后焦点交还「清理所选」。
  useEffect(() => { if (confirming) confirmCancelRef.current?.focus() }, [confirming])

  // 首次进入分组时盘点一次；之后由「重新盘点」和阈值变化驱动。
  useEffect(() => {
    if (active && !storageScan && !storageScanBusy && !storageScanError && onScanCursorStorage) void onScanCursorStorage({ chatHistoryOlderThanDays: olderThanDays })
  }, [active, storageScan, storageScanBusy, storageScanError, onScanCursorStorage, olderThanDays])
  useEffect(() => { if (!active) setConfirming(false) }, [active])

  const selection = useMemo(() => selected ?? (storageScan ? defaultSelection(storageScan) : new Set<CursorStorageItemId>()), [selected, storageScan])
  const plan = useMemo(() => (storageScan
    ? buildCleanupPlan(storageScan, { ids: [...selection], chatHistoryOlderThanDays: olderThanDays, compactDatabase: compact })
    : undefined), [storageScan, selection, olderThanDays, compact])
  const blockedById = useMemo(() => new Map(plan?.blocked.map((item) => [item.id, item.reason]) ?? []), [plan])

  if (!onScanCursorStorage) return null
  const busy = storageScanBusy || storageCleanupBusy

  const toggle = (id: CursorStorageItemId, checked: boolean): void => {
    setConfirming(false)
    setSelected((current) => {
      const next = new Set(current ?? selection)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const rescan = (days = olderThanDays): void => {
    setConfirming(false)
    void onScanCursorStorage({ chatHistoryOlderThanDays: days })
  }
  const closeConfirm = (): void => {
    setConfirming(false)
    primaryButtonRef.current?.focus()
  }
  const confirm = async (): Promise<void> => {
    if (!plan || !onCleanCursorStorage) return
    setConfirming(false)
    await onCleanCursorStorage({ ids: plan.runnable, chatHistoryOlderThanDays: olderThanDays, compactDatabase: compact })
    setSelected(undefined)
  }

  const running = storageScan ? runningLabel(storageScan) : undefined
  const chat = storageScan?.chatHistory
  const entryOf = (id: CursorStorageItemId): CursorStorageScanEntry | undefined => storageScan?.entries.find((entry) => entry.id === id)

  return (
    <SettingsSection
      title="存储清理"
      description={storageScan?.userDataRoot ?? 'Cursor 用户数据目录'}
      descriptionTitle={storageScan?.userDataRoot}
      aside={storageScan ? <span className="settings-section__meta">盘点于 {formatFullClock(storageScan.scannedAt)}</span> : undefined}
    >
      <div className="storage-cleanup">
        <header className="storage-cleanup__head">
          <div className="storage-cleanup__headline">
            {/* 空态眉题用「盘点结果」：「可清理：没有可清理的内容」连读矛盾。 */}
            <span className="storage-cleanup__eyebrow">{storageScanBusy ? '正在盘点…' : !storageScan ? '尚未盘点' : storageScan.totalBytes > 0 ? '可清理' : '盘点结果'}</span>
            <b className={`storage-cleanup__total${storageScan && storageScan.totalBytes === 0 ? ' is-empty' : ''}`}>
              {!storageScan ? '—' : storageScan.totalBytes > 0 ? `约 ${formatFileSize(storageScan.totalBytes)}` : '没有可清理的内容'}
            </b>
            {running ? <span className={`storage-cleanup__running is-${running.tone}`}><i aria-hidden="true" />{running.text}</span> : null}
          </div>
          <div className="storage-cleanup__actions">
            <button type="button" className="storage-cleanup__button" disabled={busy} onClick={() => rescan()}>
              {storageScanBusy ? '盘点中…' : '重新盘点'}
            </button>
            <button
              ref={primaryButtonRef}
              type="button"
              className={`storage-cleanup__button is-primary${plan?.irreversible.length ? ' is-danger' : ''}`}
              disabled={busy || !plan?.runnable.length || !onCleanCursorStorage}
              onClick={() => setConfirming(true)}
            >
              {storageCleanupBusy ? '清理中…' : plan?.runnable.length ? `清理所选 · 约 ${formatFileSize(plan.totalBytes)}` : '清理所选'}
            </button>
          </div>
        </header>

        {storageScanError ? <p className="cursor-maintenance__error" role="alert">{storageScanError}</p> : null}

        {confirming && plan ? (
          <div
            className={`storage-cleanup__confirm${plan.irreversible.length ? ' is-danger' : ''}`}
            role="dialog"
            aria-label="确认清理"
            onKeyDown={(event) => { if (event.key === 'Escape') closeConfirm() }}
          >
            <p className="storage-cleanup__confirm-title">
              将清理 {plan.runnable.length} 项，释放约 {formatFileSize(plan.totalBytes)}
              {plan.irreversible.includes('chat-history') && chat ? `；其中 ${chat.candidateCount} 个 ${chat.olderThanDays} 天前的会话会永久删除，无法恢复` : '；目录内容进入系统回收站，可找回'}
            </p>
            <ul className="storage-cleanup__confirm-list">
              {plan.runnable.map((id) => {
                const spec = CURSOR_STORAGE_CATALOG.find((item) => item.id === id)!
                const entry = entryOf(id)
                return <li key={id}><strong>{spec.label}</strong><span>{formatFileSize(id === 'chat-history' ? (chat?.candidateBytesEstimate ?? 0) : (entry?.bytes ?? 0))}</span></li>
              })}
            </ul>
            <div className="storage-cleanup__confirm-actions">
              <button ref={confirmCancelRef} type="button" className="storage-cleanup__button" onClick={closeConfirm}>取消</button>
              <button type="button" className={`storage-cleanup__button is-primary${plan.irreversible.length ? ' is-danger' : ''}`} disabled={busy} onClick={() => void confirm()}>
                {plan.irreversible.length ? '确认永久删除并清理' : '确认清理'}
              </button>
            </div>
          </div>
        ) : null}

        {storageCleanupResult && storageCleanupResult !== dismissedResult ? (
          <div className={storageCleanupResult.ok ? 'storage-cleanup__result is-ok' : 'storage-cleanup__result is-error'} role={storageCleanupResult.ok ? 'status' : 'alert'}>
            <p>{storageCleanupResult.message}</p>
            {storageCleanupResult.skipped.length ? (
              <ul>
                {storageCleanupResult.skipped.map((item) => (
                  <li key={item.id}>{CURSOR_STORAGE_CATALOG.find((spec) => spec.id === item.id)?.label ?? item.id}：{item.reason}</li>
                ))}
              </ul>
            ) : null}
            <button type="button" className="storage-cleanup__result-dismiss" aria-label="收起清理结果" onClick={() => setDismissedResult(storageCleanupResult)}>×</button>
          </div>
        ) : null}

        <ul className={`storage-cleanup__list${storageScanBusy && !storageScan ? ' is-loading' : ''}`} aria-busy={busy}>
          {CURSOR_STORAGE_CATALOG.map((spec) => (
            <CleanupRow
              key={spec.id}
              spec={spec}
              entry={entryOf(spec.id)}
              scan={storageScan ?? { scannedAt: 0, userDataRoot: '', cursorRunning: undefined, entries: [], totalBytes: 0 }}
              selected={selection.has(spec.id)}
              blockedReason={blockedById.get(spec.id)}
              disabled={busy || !storageScan}
              onToggle={(checked) => toggle(spec.id, checked)}
              onReveal={onRevealCursorStorage ? () => onRevealCursorStorage(spec.id) : undefined}
            >
              {spec.id === 'chat-history' && chat ? (
                <div className="storage-cleanup__chat">
                  <span className="storage-cleanup__chat-field">
                    <span>清理</span>
                    <MenuSelect
                      ariaLabel="对话历史阈值"
                      value={String(olderThanDays)}
                      disabled={busy}
                      options={CHAT_HISTORY_OLDER_THAN_OPTIONS.map((days) => ({ value: String(days), label: `${days} 天前` }))}
                      onChange={(value) => { const days = Number(value); setOlderThanDays(days); rescan(days) }}
                    />
                    <span>未更新的会话</span>
                  </span>
                  <span className="storage-cleanup__chat-facts">
                    {chat.candidateCount} 个会话 · 保留 {chat.indexedCount - chat.candidateCount} 个
                    {chat.protectedCount ? ` · ${chat.protectedCount} 个受拾光保护` : ''}
                    {chat.specialCount ? ` · ${chat.specialCount} 个项目 / 规格 / 子会话不清理` : ''}
                  </span>
                  <span className="storage-cleanup__chat-compact">
                    <ToggleSwitch checked={compact && chat.compactable} disabled={busy || !chat.compactable || !chat.candidateCount} onChange={setCompact}>
                      清理后压实数据库文件
                    </ToggleSwitch>
                    <small>{chat.compactable
                      ? '压实（VACUUM）会真正缩小文件，需要几分钟'
                      : `磁盘空闲不足（需 ≥ ${formatFileSize(chat.fileBytes * 1.1)}）；释放的空间由 Cursor 后续写入复用`}</small>
                  </span>
                </div>
              ) : null}
            </CleanupRow>
          ))}
        </ul>
      </div>
    </SettingsSection>
  )
}
