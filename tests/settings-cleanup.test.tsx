// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorStorageCleanupResult, CursorStorageItemId, CursorStorageScan, CursorStorageScanEntry } from '../src/domain/cursor-storage-cleanup'
import { SettingsCleanup } from '../src/renderer/src/settings/SettingsCleanup'
import { SettingsPage } from '../src/renderer/src/settings/SettingsPage'
import type { SettingsPageProps } from '../src/renderer/src/settings/settings-view'
import { formatFileSize } from '../src/shared/format-file-size'

const GB = 1024 ** 3
const MB = 1024 ** 2

function entry(id: CursorStorageItemId, bytes: number, count = bytes ? 1 : 0): CursorStorageScanEntry {
  return { id, bytes, count, cleanable: bytes > 0 }
}

function scan(overrides: Partial<CursorStorageScan> = {}, chat: Partial<NonNullable<CursorStorageScan['chatHistory']>> = {}): CursorStorageScan {
  return {
    scannedAt: 1_757_600_000_000,
    userDataRoot: '/Users/demo/Library/Application Support/Cursor',
    cursorRunning: true,
    entries: [
      entry('chat-history', 5.4 * GB, 298),
      entry('snapshots', 16.1 * GB, 48_211),
      entry('local-history', 208 * MB, 3_940),
      entry('orphan-workspaces', 1.02 * GB, 20),
      entry('stale-backups', 1.56 * GB, 2),
      entry('caches', 146 * MB, 1_204),
      entry('logs', 28 * MB, 612),
      { id: 'legacy-patch', bytes: 243_503, count: 1, cleanable: false }
    ],
    chatHistory: {
      databasePath: '/db/state.vscdb', fileBytes: 20.9 * GB, sidecarBytes: 0, composerCount: 1922, indexedCount: 1321, bubbleCount: 1_088_294,
      candidateCount: 298, candidateBytesEstimate: 5.4 * GB, protectedCount: 6, specialCount: 3, olderThanDays: 90, freeDiskBytes: 21 * GB, compactable: false,
      ...chat
    },
    totalBytes: (5.4 + 16.1 + 1.02 + 1.56) * GB + (208 + 146 + 28) * MB,
    ...overrides
  }
}

describe('存储清理面板', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  type Props = Parameters<typeof SettingsCleanup>[0]
  const render = async (props: Props): Promise<void> => { await act(async () => root.render(<SettingsCleanup {...props} />)) }
  const checkbox = (id: CursorStorageItemId): HTMLInputElement => container.querySelector<HTMLInputElement>(`[data-item="${id}"] input[type="checkbox"]`)!
  const row = (id: CursorStorageItemId): HTMLElement => container.querySelector<HTMLElement>(`[data-item="${id}"]`)!
  const buttonByText = (text: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith(text))!

  it('只在分组首次激活时盘点一次；隐藏分组不触发，有结果后不重复', async () => {
    const onScan = vi.fn(async () => {})
    await render({ active: false, onScanCursorStorage: onScan })
    expect(onScan).not.toHaveBeenCalled()
    await render({ active: true, onScanCursorStorage: onScan })
    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith({ chatHistoryOlderThanDays: 90 })
    await render({ active: true, onScanCursorStorage: onScan, storageScan: scan() })
    await render({ active: true, onScanCursorStorage: onScan, storageScan: scan(), storageScanBusy: false })
    expect(onScan).toHaveBeenCalledTimes(1)
    // 盘点失败后也不自动重试，由用户点「重新盘点」。
    await render({ active: true, onScanCursorStorage: vi.fn(async () => {}), storageScanError: '数据库操作超时' })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('数据库操作超时')
  })

  it('Cursor 运行中：默认只预选可放心且此刻可执行的项；勾上需退出的项会看到阻断原因，且不计入合计', async () => {
    const onClean = vi.fn(async () => {})
    await render({ storageScan: scan(), onScanCursorStorage: vi.fn(async () => {}), onCleanCursorStorage: onClean })

    expect(checkbox('orphan-workspaces').checked).toBe(true)
    expect(checkbox('stale-backups').checked).toBe(true)
    for (const id of ['caches', 'logs', 'snapshots', 'local-history', 'chat-history'] as const) expect(checkbox(id).checked).toBe(false)
    expect(container.querySelector('[data-item="legacy-patch"] input[type="checkbox"]')).toBeNull()
    expect(row('legacy-patch').className).toContain('is-diagnostic')
    expect(container.querySelector('.storage-cleanup__running')?.textContent).toContain('Cursor 正在运行')
    expect(container.querySelector('.storage-cleanup__total')?.textContent).toBe(`约 ${formatFileSize(scan().totalBytes)}`)
    const selectedBytes = (1.02 + 1.56) * GB
    expect(buttonByText('清理所选').textContent).toBe(`清理所选 · 约 ${formatFileSize(selectedBytes)}`)
    expect(row('snapshots').querySelector('.storage-cleanup__lock')?.textContent).toBe('需退出 Cursor')

    await act(async () => { checkbox('snapshots').click() })
    expect(row('snapshots').className).toContain('is-blocked')
    expect(row('snapshots').querySelector('.storage-cleanup__blocked')?.textContent).toBe('需要先退出 Cursor')
    expect(buttonByText('清理所选').textContent).toBe(`清理所选 · 约 ${formatFileSize(selectedBytes)}`)
    expect(row('orphan-workspaces').querySelector('.storage-cleanup__loss')?.textContent).toContain('清掉后：')
  })

  it('确认流：先看到将清理什么、可否找回，确认后才把可执行项交给回调', async () => {
    const onClean = vi.fn(async () => {})
    await render({ storageScan: scan(), onScanCursorStorage: vi.fn(async () => {}), onCleanCursorStorage: onClean })
    await act(async () => { buttonByText('清理所选').click() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.className).not.toContain('is-danger')
    expect(dialog.querySelector('.storage-cleanup__confirm-title')?.textContent)
      .toBe(`将清理 2 项，释放约 ${formatFileSize((1.02 + 1.56) * GB)}；目录内容进入系统回收站，可找回`)
    expect([...dialog.querySelectorAll('li strong')].map((node) => node.textContent)).toEqual(['失效工作区存储', '旧数据库备份'])
    expect(onClean).not.toHaveBeenCalled()

    await act(async () => { buttonByText('取消').click() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { buttonByText('清理所选').click() })
    await act(async () => { buttonByText('确认清理').click() })
    expect(onClean).toHaveBeenCalledWith({ ids: ['orphan-workspaces', 'stale-backups'], chatHistoryOlderThanDays: 90, compactDatabase: false })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('Cursor 已退出：勾选对话历史后整块转红，确认文案点明永久删除的会话数；压实开关随磁盘空间启用', async () => {
    const onClean = vi.fn(async () => {})
    const closed = scan({ cursorRunning: false }, { compactable: true })
    await render({ storageScan: closed, onScanCursorStorage: vi.fn(async () => {}), onCleanCursorStorage: onClean })
    // 已退出时缓存 / 日志也进入默认预选。
    expect(checkbox('caches').checked).toBe(true)
    expect(checkbox('logs').checked).toBe(true)
    expect(container.querySelector('.storage-cleanup__running')?.textContent).toContain('Cursor 已退出')
    expect(row('snapshots').querySelector('.storage-cleanup__lock')).toBeNull()

    await act(async () => { checkbox('chat-history').click() })
    expect(row('chat-history').querySelector('.storage-cleanup__chat-facts')?.textContent)
      .toBe('298 个会话 · 保留 1023 个 · 6 个受拾光保护 · 3 个项目 / 规格 / 子会话不清理')
    const compactToggle = row('chat-history').querySelector<HTMLInputElement>('.toggle-switch input')!
    expect(compactToggle.disabled).toBe(false)
    await act(async () => { compactToggle.click() })
    expect(buttonByText('清理所选').className).toContain('is-danger')

    await act(async () => { buttonByText('清理所选').click() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.className).toContain('is-danger')
    expect(dialog.querySelector('.storage-cleanup__confirm-title')?.textContent).toContain('其中 298 个 90 天前的会话会永久删除，无法恢复')
    await act(async () => { buttonByText('确认永久删除并清理').click() })
    expect(onClean).toHaveBeenCalledWith({
      ids: ['orphan-workspaces', 'stale-backups', 'caches', 'logs', 'chat-history'],
      chatHistoryOlderThanDays: 90,
      compactDatabase: true
    })
  })

  it('磁盘空闲不足时压实开关禁用并说明门槛；切换阈值立刻按新阈值重新盘点', async () => {
    const onScan = vi.fn(async () => {})
    await render({ storageScan: scan(), onScanCursorStorage: onScan })
    const compactToggle = row('chat-history').querySelector<HTMLInputElement>('.toggle-switch input')!
    expect(compactToggle.disabled).toBe(true)
    expect(row('chat-history').querySelector('.storage-cleanup__chat-compact small')?.textContent)
      .toBe(`磁盘空闲不足（需 ≥ ${formatFileSize(20.9 * GB * 1.1)}）；释放的空间由 Cursor 后续写入复用`)

    const select = row('chat-history').querySelector<HTMLButtonElement>('.menu-select button, button[aria-haspopup]')!
    await act(async () => { select.click() })
    const option = [...document.body.querySelectorAll<HTMLButtonElement>('.menu-select__menu button')].find((button) => button.textContent?.includes('30 天前'))!
    await act(async () => { option.click() })
    expect(onScan).toHaveBeenCalledWith({ chatHistoryOlderThanDays: 30 })
  })

  it('结果块回显主进程结论，被跳过的项逐条列出原因；失败结果用 alert 语义', async () => {
    const ok: CursorStorageCleanupResult = {
      ok: true, freedBytes: 2.5 * GB, done: ['orphan-workspaces', 'stale-backups'],
      skipped: [{ id: 'snapshots', reason: '需要先退出 Cursor' }],
      message: '已清理 失效工作区存储、旧数据库备份，释放约 2.5 GB'
    }
    await render({ storageScan: scan(), onScanCursorStorage: vi.fn(async () => {}), storageCleanupResult: ok })
    const status = container.querySelector<HTMLElement>('.storage-cleanup__result')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.className).toContain('is-ok')
    expect(status.querySelector('p')?.textContent).toBe(ok.message)
    expect([...status.querySelectorAll('li')].map((node) => node.textContent)).toEqual(['检查点快照：需要先退出 Cursor'])

    await render({
      storageScan: scan(), onScanCursorStorage: vi.fn(async () => {}),
      storageCleanupResult: { ok: false, freedBytes: 0, done: [], skipped: [], message: '未清理：需要先退出 Cursor' }
    })
    const failed = container.querySelector<HTMLElement>('.storage-cleanup__result')!
    expect(failed.getAttribute('role')).toBe('alert')
    expect(failed.className).toContain('is-error')
  })

  it('结果横幅可收起；同一结果保持收起，新一次清理的结果重新显示', async () => {
    const first: CursorStorageCleanupResult = { ok: true, freedBytes: GB, done: ['caches'], skipped: [], message: '已清理 界面缓存，释放约 1 GB' }
    const base = { storageScan: scan(), onScanCursorStorage: vi.fn(async () => {}) }
    await render({ ...base, storageCleanupResult: first })
    expect(container.querySelector('.storage-cleanup__result')).not.toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('.storage-cleanup__result-dismiss')!.click() })
    expect(container.querySelector('.storage-cleanup__result')).toBeNull()
    await render({ ...base, storageCleanupResult: first })
    expect(container.querySelector('.storage-cleanup__result')).toBeNull()
    const second: CursorStorageCleanupResult = { ok: true, freedBytes: GB, done: ['logs'], skipped: [], message: '已清理 日志，释放约 1 GB' }
    await render({ ...base, storageCleanupResult: second })
    expect(container.querySelector('.storage-cleanup__result p')?.textContent).toBe('已清理 日志，释放约 1 GB')
  })

  it('确认框键盘可达：出现时焦点落在取消键，Escape 关闭并把焦点交还清理按钮', async () => {
    await render({ storageScan: scan(), onScanCursorStorage: vi.fn(async () => {}), onCleanCursorStorage: vi.fn(async () => {}) })
    await act(async () => { buttonByText('清理所选').click() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(document.activeElement).toBe(buttonByText('取消'))
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(buttonByText('清理所选'))
  })

  it('空态：总览说明没有可清理的内容，清理按钮禁用，压实开关在没有候选时也禁用', async () => {
    const empty = scan(
      { cursorRunning: false, totalBytes: 0, entries: scan().entries.map((item) => ({ ...item, bytes: 0, count: 0, cleanable: false })) },
      { candidateCount: 0, candidateBytesEstimate: 0, compactable: true }
    )
    await render({ storageScan: empty, onScanCursorStorage: vi.fn(async () => {}), onCleanCursorStorage: vi.fn(async () => {}) })
    const total = container.querySelector<HTMLElement>('.storage-cleanup__total')!
    expect(total.textContent).toBe('没有可清理的内容')
    expect(total.className).toContain('is-empty')
    // 眉题不再与空态大字连读成「可清理：没有可清理的内容」。
    expect(container.querySelector('.storage-cleanup__eyebrow')?.textContent).toBe('盘点结果')
    expect(buttonByText('清理所选').disabled).toBe(true)
    expect(row('chat-history').querySelector<HTMLInputElement>('.toggle-switch input')!.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLInputElement>('.storage-cleanup__row input[type="checkbox"]')].every((input) => input.disabled && !input.checked)).toBe(true)
  })

  it('没有盘点回调（预览之外的降级）时整段不渲染', async () => {
    await render({ storageScan: scan() })
    expect(container.innerHTML).toBe('')
  })

  it('设置页：#account:cleanup 深链落到「存储清理」分组并触发首次盘点；切到别的分组不再盘点', async () => {
    history.replaceState(null, '', '#account:cleanup')
    const onScan = vi.fn(async () => {})
    const pageProps: SettingsPageProps = {
      accounts: [], busy: false, error: '',
      onSave: vi.fn(async () => {}), onSelect: vi.fn(async () => {}), onRemove: vi.fn(async () => {}),
      onScanCursorStorage: onScan
    }
    await act(async () => root.render(<SettingsPage {...pageProps} />))
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('存储清理')
    expect(container.querySelector('.settings-groups > div:not([hidden]) .storage-cleanup')).not.toBeNull()
    expect(onScan).toHaveBeenCalledTimes(1)

    const maintenance = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find((button) => button.textContent === 'Cursor 维护')!
    await act(async () => { maintenance.click() })
    expect(container.querySelector('.settings-groups > div:not([hidden]) .storage-cleanup')).toBeNull()
    expect(onScan).toHaveBeenCalledTimes(1)
    history.replaceState(null, '', '#account')
  })
})
