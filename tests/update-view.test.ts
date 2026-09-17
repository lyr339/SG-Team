import { describe, expect, it } from 'vitest'
import type { AppUpdateRelease, AppUpdateStatus } from '../src/domain/app-update'
import { buildUpdatePanelView, formatReleaseDate, formatUpdateTime, groupReleaseNotes } from '../src/renderer/src/settings/update-view'

const NOW = new Date(2026, 8, 17, 10, 30).getTime()
const release: AppUpdateRelease = {
  version: '0.3.3',
  releaseDate: '2026-09-17T02:00:00.000Z',
  releaseNotes: '## v0.3.3\n- 第一条\n- 第二条',
  sizeBytes: 116_467_543,
  releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
}

function statusOf(state: AppUpdateStatus['state'], settings: Partial<AppUpdateStatus['settings']> = {}): AppUpdateStatus {
  return {
    currentVersion: '0.3.2',
    state,
    settings: { autoCheck: true, checkIntervalHours: 6, ...settings },
    launchedAfterUpdate: false,
    releaseUrl: release.releaseUrl
  }
}

const actionIds = (status: AppUpdateStatus) => buildUpdatePanelView(status, NOW).actions.map((action) => action.id)

describe('软件更新 · 面板视图', () => {
  it('时间：今天只给时刻，其他日子带月-日；发布日期取 ISO 的年月日', () => {
    expect(formatUpdateTime(NOW - 60_000, NOW)).toBe('今天 10:29')
    expect(formatUpdateTime(new Date(2026, 8, 12, 8, 5).getTime(), NOW)).toBe('09-12 08:05')
    expect(formatReleaseDate('2026-09-17T02:00:00.000Z')).toMatch(/^2026-09-1[67]$/)
    expect(formatReleaseDate('garbage')).toBeUndefined()
    expect(formatReleaseDate(undefined)).toBeUndefined()
  })

  it('idle：标签「拾光 <当前>」，没事可说时无胶囊，一句上次检查；明确失败红胶囊 + 原文；按钮立即检查 + 发布页', () => {
    const plain = buildUpdatePanelView(statusOf({ phase: 'idle' }), NOW)
    expect(plain).toMatchObject({ tone: 'neutral', title: '拾光 0.3.2', headline: '尚未检查过更新', busy: false })
    expect(plain.badge).toBeUndefined()
    expect(plain.detail).toBeUndefined()
    expect(plain.actions.map((action) => action.id)).toEqual(['check', 'open-release'])
    expect(buildUpdatePanelView(statusOf({ phase: 'idle', lastCheckedAt: NOW - 60_000 }), NOW).headline).toBe('上次检查 今天 10:29')
    const failed = buildUpdatePanelView(statusOf({ phase: 'idle', lastCheckedAt: NOW - 5 * 60_000, lastError: 'ENOTFOUND' }), NOW)
    expect(failed).toMatchObject({ tone: 'danger', badge: { label: '检查失败', tone: 'danger' }, title: '拾光 0.3.2', headline: 'ENOTFOUND', detail: '上次检查 今天 10:25' })
  })

  it('idle（网络失败）：中性胶囊、人话文案、原始错误只进悬停；自动检查关掉时不承诺重试', () => {
    const view = buildUpdatePanelView(statusOf({ phase: 'idle', lastCheckedAt: NOW - 5 * 60_000, lastError: 'net::ERR_CONNECTION_CLOSED', lastErrorKind: 'network' }), NOW)
    expect(view.tone).toBe('neutral')
    expect(view.badge).toEqual({ label: '暂时连不上更新源', tone: 'neutral' })
    expect(view.headline).toBe('稍后会自动重试，网络恢复后也可「立即检查」')
    expect(view.detail).toBe('上次尝试 今天 10:25')
    expect(view.detailTitle).toBe('net::ERR_CONNECTION_CLOSED')
    const manual = buildUpdatePanelView(statusOf({ phase: 'idle', lastError: 'fetch failed', lastErrorKind: 'network' }, { autoCheck: false }), NOW)
    expect(manual.headline).toBe('网络恢复后也可「立即检查」')
    expect(manual.detail).toBeUndefined()
    // 明确错误仍然报红、原文直给
    const explicit = buildUpdatePanelView(statusOf({ phase: 'idle', lastCheckedAt: NOW - 5 * 60_000, lastError: '更新清单返回 HTTP 500', lastErrorKind: 'other' }), NOW)
    expect(explicit).toMatchObject({ tone: 'danger', badge: { label: '检查失败', tone: 'danger' }, headline: '更新清单返回 HTTP 500', detail: '上次检查 今天 10:25' })
    expect(explicit.detailTitle).toBeUndefined()
  })

  it('unsupported / checking / up_to_date 的胶囊、文案与忙态；标签都是「拾光 <当前>」', () => {
    expect(buildUpdatePanelView(statusOf({ phase: 'unsupported', reason: '开发模式下不检查更新。' }), NOW))
      .toMatchObject({ tone: 'muted', badge: { label: '不支持应用内更新', tone: 'muted' }, title: '拾光 0.3.2', headline: '开发模式下不检查更新。', actions: [{ id: 'open-release', label: '打开发布页', kind: 'link' }] })
    const checking = buildUpdatePanelView(statusOf({ phase: 'checking', startedAt: NOW }), NOW)
    expect(checking).toMatchObject({ tone: 'info', badge: { label: '正在检查…', tone: 'info' }, title: '拾光 0.3.2', busy: true })
    expect(checking.actions[0]).toMatchObject({ id: 'check', disabled: true })
    expect(buildUpdatePanelView(statusOf({ phase: 'up_to_date', checkedAt: NOW - 30_000 }), NOW))
      .toMatchObject({ tone: 'success', badge: { label: '已是最新', tone: 'success' }, title: '拾光 0.3.2', headline: '上次检查 今天 10:29' })
  })

  it('available：标签换成「新版本 x」、状态句是发布日期 · 体积 · 当前版本、说明段落、下载 / 跳过 / 稍后；跳过后胶囊变「已跳过」且只剩取消跳过', () => {
    const view = buildUpdatePanelView(statusOf({ phase: 'available', release, checkedAt: NOW }), NOW)
    expect(view.tone).toBe('accent')
    expect(view.badge).toEqual({ label: '有新版本', tone: 'accent' })
    expect(view.title).toBe('新版本 0.3.3')
    expect(view.headline).toMatch(/^2026-09-1[67] 发布 · 111\.1 MB · 当前 0\.3\.2$/)
    expect(view.detail).toBeUndefined()
    // 清单没给发布日期与体积时，状态句只剩当前版本
    expect(buildUpdatePanelView(statusOf({ phase: 'available', release: { version: '0.3.3', releaseUrl: release.releaseUrl }, checkedAt: NOW }), NOW).headline).toBe('当前 0.3.2')
    expect(view.notes).toEqual(['v0.3.3', '- 第一条', '- 第二条'])
    expect(view.actions.map((action) => action.id)).toEqual(['download', 'skip', 'snooze', 'open-release'])
    expect(view.skippedNote).toBeUndefined()

    const skipped = buildUpdatePanelView(statusOf({ phase: 'available', release, checkedAt: NOW }, { skippedVersion: '0.3.3' }), NOW)
    expect(skipped.tone).toBe('muted')
    expect(skipped.badge).toEqual({ label: '已跳过', tone: 'muted' })
    expect(skipped.skippedNote).toBe('已跳过 0.3.3，出现更高版本时再提醒')
    expect(skipped.actions.map((action) => action.id)).toEqual(['download', 'unskip', 'open-release'])

    const snoozed = buildUpdatePanelView(statusOf({ phase: 'available', release, checkedAt: NOW }, { snoozedUntil: NOW + 3_600_000 }), NOW)
    expect(snoozed.snoozedNote).toBe('已选择稍后，今天 11:30 后恢复提醒')
    expect(snoozed.actions.find((action) => action.id === 'snooze')?.disabled).toBe(true)
  })

  it('downloading：进度百分比与读数、取消；downloaded：安装并重启；installing：无按钮', () => {
    const downloading = buildUpdatePanelView(statusOf({ phase: 'downloading', release, receivedBytes: 58_233_772, totalBytes: 116_467_543, bytesPerSecond: 3_145_728, startedAt: NOW }), NOW)
    expect(downloading.progress).toEqual({ percent: 50, received: '55.5 MB', total: '111.1 MB', rate: '3.0 MB/s' })
    expect(downloading.badge).toEqual({ label: '下载中 50%', tone: 'info' })
    expect(downloading.title).toBe('新版本 0.3.3')
    expect(downloading.headline).toBe('正在下载安装包…')
    expect(downloading.detail).toMatch(/^2026-09-1[67] 发布 · 111\.1 MB · 当前 0\.3\.2$/)
    expect(downloading.actions.map((action) => action.id)).toEqual(['cancel', 'open-release'])
    expect(downloading.busy).toBe(true)
    const unknownTotal = buildUpdatePanelView(statusOf({ phase: 'downloading', release, receivedBytes: 10, totalBytes: 0, startedAt: NOW }), NOW)
    expect(unknownTotal.progress).toMatchObject({ percent: 0, total: '—' })
    expect(unknownTotal.badge?.label).toBe('下载中 0%')

    const downloaded = buildUpdatePanelView(statusOf({ phase: 'downloaded', release, downloadedAt: NOW }), NOW)
    expect(downloaded.badge).toEqual({ label: '待安装', tone: 'accent' })
    expect(downloaded.title).toBe('新版本 0.3.3')
    expect(downloaded.headline).toMatch(/^已下载校验通过/)
    expect(downloaded.detail).toMatch(/· 当前 0\.3\.2$/)
    expect(downloaded.actions.map((action) => action.id)).toEqual(['install', 'skip', 'snooze', 'open-release'])

    const installing = buildUpdatePanelView(statusOf({ phase: 'installing', release, startedAt: NOW }), NOW)
    expect(installing).toMatchObject({ tone: 'info', badge: { label: '正在安装', tone: 'info' }, title: '新版本 0.3.3', detail: '当前 0.3.2', actions: [], busy: true })
  })

  it('failed：正文是人话、技术原文退到弱行、目标版本留在标签', () => {
    const view = buildUpdatePanelView(statusOf({ phase: 'failed', step: 'download', message: 'sha512 checksum mismatch, expected 5f2a got 91c0', at: NOW, release }), NOW)
    expect(view).toMatchObject({ tone: 'danger', badge: { label: '下载失败', tone: 'danger' }, title: '新版本 0.3.3' })
    // 正文不再是技术串，但原文一字不改地留在下面一行——读得懂，也照抄得出来。
    expect(view.headline).toBe('安装包没下完或没通过校验；重试即可，反复失败可在下方换用镜像源，或到发布页手动下载。')
    expect(view.detail).toBe('sha512 checksum mismatch, expected 5f2a got 91c0')
    const check = buildUpdatePanelView(statusOf({ phase: 'failed', step: 'check', message: 'x', at: NOW }), NOW)
    expect(check.badge?.label).toBe('检查失败')
    expect(check.title).toBe('拾光 0.3.2')
    expect(check.headline).toBe('没能问到更新源；稍后再试，或到发布页查看。')
    expect(buildUpdatePanelView(statusOf({ phase: 'failed', step: 'install', message: 'EACCES', at: NOW, release }), NOW).badge?.label).toBe('安装失败')
    expect(buildUpdatePanelView(statusOf({ phase: 'failed', step: 'rollback', message: 'EPERM', at: NOW }), NOW).badge?.label).toBe('回滚失败')
  })

  it('failed：能一键重来的才叫「重试」，回滚 / 检查失败老实叫「知道了」', () => {
    // dismiss 后状态回到 available，那里唯一能接着做的是重新下载：下载与安装失败都从这里重来。
    const download = buildUpdatePanelView(statusOf({ phase: 'failed', step: 'download', message: 'sha512 mismatch', at: NOW, release }), NOW)
    expect(actionIds(statusOf({ phase: 'failed', step: 'download', message: 'sha512 mismatch', at: NOW, release }))).toEqual(['retry-download', 'open-release'])
    expect(download.actions[0]?.label).toBe('重试下载')
    const install = buildUpdatePanelView(statusOf({ phase: 'failed', step: 'install', message: 'EACCES', at: NOW, release }), NOW)
    expect(install.actions[0]).toMatchObject({ id: 'retry-download', label: '重新下载' })
    // 回滚失败没有 release，dismiss 只能回到 idle：没有一键可重的下一步，就别叫「重试」。
    expect(buildUpdatePanelView(statusOf({ phase: 'failed', step: 'rollback', message: 'EPERM', at: NOW }), NOW).actions[0])
      .toMatchObject({ id: 'dismiss', label: '知道了' })
    expect(buildUpdatePanelView(statusOf({ phase: 'failed', step: 'check', message: 'x', at: NOW }), NOW).actions[0])
      .toMatchObject({ id: 'dismiss', label: '知道了' })
  })

  it('failed（下载遇网络瞬断）：与检查失败同一读法——中性胶囊、不报红、人话正文', () => {
    const view = buildUpdatePanelView(statusOf({ phase: 'failed', step: 'download', message: 'net::ERR_CONNECTION_CLOSED', at: NOW, release }), NOW)
    expect(view).toMatchObject({ tone: 'neutral', badge: { label: '下载未完成', tone: 'neutral' } })
    expect(view.headline).toBe('下载中断了，多半是网络波动；重试即可，反复失败可在下方换用镜像源。')
    expect(view.detail).toBe('net::ERR_CONNECTION_CLOSED')
    expect(view.actions[0]?.label).toBe('重试下载')
    // 服务端的明确答复不是网络波动：照旧报红。
    expect(buildUpdatePanelView(statusOf({ phase: 'failed', step: 'download', message: '返回 HTTP 500', at: NOW, release }), NOW))
      .toMatchObject({ tone: 'danger', badge: { label: '下载失败' } })
  })

  it('downloading（verify）：胶囊改为正在校验、进度满格、速率与取消都收起、文案改为校验解压', () => {
    const view = buildUpdatePanelView(statusOf({
      phase: 'downloading', release, receivedBytes: 116_467_543, totalBytes: 116_467_543, bytesPerSecond: 3_145_728, activity: 'verify', startedAt: NOW
    }), NOW)
    expect(view.badge).toEqual({ label: '正在校验', tone: 'info' })
    expect(view.headline).toBe('下载已完成；正在核对签名与版本，几秒后就绪。')
    expect(view.progress).toMatchObject({ percent: 100 })
    expect(view.progress?.rate).toBeUndefined()
    expect(view.actions[0]).toMatchObject({ id: 'cancel', disabled: true })
    expect(view.busy).toBe(true)
  })

  it('available（downloadable=false）：状态句说明只能去发布页，主按钮改为发布页，没有下载入口', () => {
    const view = buildUpdatePanelView(statusOf({ phase: 'available', release: { ...release, downloadable: false }, checkedAt: NOW }), NOW)
    expect(view.title).toBe('新版本 0.3.3')
    expect(view.headline).toBe('此版本未提供应用内下载，请到发布页手动更新')
    expect(view.detail).toMatch(/发布 · 111\.1 MB · 当前 0\.3\.2$/)
    expect(view.actions.map((action) => action.id)).toEqual(['open-release', 'skip', 'snooze'])
    expect(view.actions[0]).toMatchObject({ id: 'open-release', kind: 'primary' })
  })

  it('rolling_back：忙态、无按钮，标签是「回滚到 x」、补充行给当前版本', () => {
    expect(buildUpdatePanelView(statusOf({ phase: 'rolling_back', targetVersion: '0.3.1', startedAt: NOW }), NOW))
      .toMatchObject({ tone: 'info', badge: { label: '正在回滚', tone: 'info' }, title: '回滚到 0.3.1', detail: '当前 0.3.2', actions: [], busy: true })
  })

  it('发布说明分块：连续的列表行合成一个列表并去掉记号，标题 / 段落各成一段', () => {
    expect(groupReleaseNotes(['v0.3.3', '- 第一条', '* 第二条', '修复', '• 第三条'])).toEqual([
      { kind: 'text', text: 'v0.3.3' },
      { kind: 'list', items: ['第一条', '第二条'] },
      { kind: 'text', text: '修复' },
      { kind: 'list', items: ['第三条'] }
    ])
    expect(groupReleaseNotes([])).toEqual([])
    // 只有记号没有内容的行不是列表项，原样成段
    expect(groupReleaseNotes(['-'])).toEqual([{ kind: 'text', text: '-' }])
  })

  it('rollback 备份脚注：空闲相位给出（含数据回退警告），忙相位收起', () => {
    const backup = { version: '0.3.2', createdAt: NOW - 3_600_000, dir: 'D:\\backup\\0.3.2-1' }
    const idle = buildUpdatePanelView({ ...statusOf({ phase: 'idle', lastCheckedAt: NOW }), rollback: backup }, NOW)
    expect(idle.rollback?.version).toBe('0.3.2')
    expect(idle.rollback?.note).toContain('保留了 0.3.2 的备份（今天 09:30）')
    expect(idle.rollback?.note).toContain('回滚会退出拾光')
    const busy = buildUpdatePanelView({ ...statusOf({ phase: 'checking', startedAt: NOW }), rollback: backup }, NOW)
    expect(busy.rollback).toBeUndefined()
  })
})
