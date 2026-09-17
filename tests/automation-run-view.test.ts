import { describe, expect, it } from 'vitest'
import type { AccountAutomationRun } from '../src/domain/account-automation'
import {
  automationRunView,
  automationTerminalStageHint,
  countdownSeconds
} from '../src/renderer/src/settings/automation-run-view'

const totals = { beforeProcess: 10, beforeHardening: 8 }

function runFor(overrides: Partial<AccountAutomationRun>): AccountAutomationRun {
  return { phase: 'idle', message: '', startedAt: 0, ...overrides }
}

function states(view: ReturnType<typeof automationRunView>): string[] {
  return view.stages.map((stage) => stage.state)
}

describe('countdownSeconds', () => {
  it('0.5s 步进向上取整，等待期间永不显示 0', () => {
    expect(countdownSeconds(10)).toBe(10)
    expect(countdownSeconds(6.5)).toBe(7)
    expect(countdownSeconds(0.5)).toBe(1)
    expect(countdownSeconds(undefined)).toBeUndefined()
    expect(countdownSeconds(Number.NaN)).toBeUndefined()
  })
})

describe('automationRunView · 活跃相位', () => {
  it('处理前倒计时：准备步进行中并带进度环，其余等待；可取消', () => {
    const view = automationRunView({
      run: runFor({ phase: 'countdown', remainingSec: 6.5, message: '将在 6.5s 后自动处理当前账号（可取消）' }),
      lastActivePhase: 'countdown',
      countdownTotalSec: totals
    })
    expect(view.tone).toBe('running')
    expect(view.statusLabel).toBe('进行中')
    expect(view.cancellable).toBe(true)
    expect(states(view)).toEqual(['running', 'waiting', 'waiting', 'waiting'])
    expect(view.stages[0]).toMatchObject({ title: '准备', detail: '7 秒后开始处理当前账号', countdown: { remainingSec: 6.5, totalSec: 10 } })
    expect(view.durationText).toBe('')
    expect(view.summary).toBeUndefined()
  })

  it('倒计时归零后的复核窗口：无读数、不可取消', () => {
    const view = automationRunView({
      run: runFor({ phase: 'countdown', message: '将在 0.5s 后自动处理当前账号（可取消）' }),
      lastActivePhase: 'countdown',
      countdownTotalSec: totals
    })
    expect(view.cancellable).toBe(false)
    expect(view.stages[0]).toMatchObject({ detail: '倒计时结束，正在复核会话' })
    expect(view.stages[0]!.countdown).toBeUndefined()
  })

  it('处理中：实时消息落在奥仔处理步；importing / deleting / cleaning 依次归属加固与收尾', () => {
    const processing = automationRunView({
      run: runFor({ phase: 'processing', message: '奥仔：正在提交 Session Token 处理…' }),
      lastActivePhase: 'processing',
      countdownTotalSec: totals
    })
    expect(states(processing)).toEqual(['done', 'running', 'waiting', 'waiting'])
    expect(processing.stages[0]!.detail).toBe('检查通过')
    expect(processing.stages[1]!.detail).toBe('奥仔：正在提交 Session Token 处理…')
    expect(processing.cancellable).toBe(false)

    for (const phase of ['importing', 'deleting'] as const) {
      const view = automationRunView({ run: runFor({ phase, message: 'x' }), lastActivePhase: phase, countdownTotalSec: totals })
      expect(states(view)).toEqual(['done', 'done', 'running', 'waiting'])
    }
    const cleaning = automationRunView({ run: runFor({ phase: 'cleaning', message: '清场中' }), lastActivePhase: 'cleaning', countdownTotalSec: totals })
    expect(states(cleaning)).toEqual(['done', 'done', 'done', 'running'])
    expect(cleaning.stages[3]!.detail).toBe('清场中')
  })

  it('加固前倒计时：归属加固步，总时长取第二段设置', () => {
    const view = automationRunView({
      run: runFor({ phase: 'hardening-countdown', remainingSec: 4, message: '奥仔已完成，将在 4s 后加固当前账号（可取消）' }),
      lastActivePhase: 'hardening-countdown',
      countdownTotalSec: totals
    })
    expect(states(view)).toEqual(['done', 'done', 'running', 'waiting'])
    expect(view.stages[2]).toMatchObject({ detail: '4 秒后加固账号', countdown: { remainingSec: 4, totalSec: 8 } })
    expect(view.cancellable).toBe(true)
  })

  it('服务端实时消息为空时回退到该步的固定说明', () => {
    const view = automationRunView({ run: runFor({ phase: 'processing', message: '' }), lastActivePhase: 'processing', countdownTotalSec: totals })
    expect(view.stages[1]!.detail).toBe('提交当前账号的 Token 自助处理')
  })
})

describe('automationRunView · 终态', () => {
  it('完成：四步全部完成，总结进摘要，耗时可读', () => {
    const view = automationRunView({
      run: runFor({ phase: 'done', message: '自动化完成：已处理', startedAt: 1_000, finishedAt: 43_000 }),
      lastActivePhase: 'cleaning',
      countdownTotalSec: totals
    })
    expect(view.tone).toBe('done')
    expect(view.statusLabel).toBe('已完成')
    expect(states(view)).toEqual(['done', 'done', 'done', 'done'])
    expect(view.summary).toBe('自动化完成：已处理')
    expect(view.durationText).toBe('42 秒')
    expect(view.cancellable).toBe(false)
  })

  it('失败：按本轮最后活跃相位归属；之前完成、之后未执行；原因只落在失败步', () => {
    const view = automationRunView({
      run: runFor({ phase: 'failed', message: '新 Token 入库失败：磁盘只读', startedAt: 1_000, finishedAt: 31_000 }),
      lastActivePhase: 'importing',
      countdownTotalSec: totals
    })
    expect(view.tone).toBe('failed')
    expect(view.statusLabel).toBe('未完成')
    expect(states(view)).toEqual(['done', 'done', 'failed', 'skipped'])
    expect(view.stages[2]!.detail).toBe('新 Token 入库失败：磁盘只读')
    expect(view.stages[3]!.detail).toBe('未执行')
    expect(view.summary).toBeUndefined()
  })

  it('失败且无活跃轨迹（持久化恢复）：按消息推断归属', () => {
    const view = automationRunView({
      run: runFor({ phase: 'failed', message: '奥仔处理失败：卡密余额不足（本地账号已保留）' }),
      lastActivePhase: null,
      countdownTotalSec: totals
    })
    expect(states(view)).toEqual(['done', 'failed', 'skipped', 'skipped'])
  })

  it('取消：处理前取消落在准备步；加固前取消保留前两步完成', () => {
    const early = automationRunView({
      run: runFor({ phase: 'cancelled', message: '已取消本次自动化' }),
      lastActivePhase: 'countdown',
      countdownTotalSec: totals
    })
    expect(early.tone).toBe('cancelled')
    expect(early.statusLabel).toBe('已取消')
    expect(states(early)).toEqual(['cancelled', 'skipped', 'skipped', 'skipped'])
    expect(early.stages[0]!.detail).toBe('已取消本次自动化')

    const late = automationRunView({
      run: runFor({ phase: 'cancelled', message: '奥仔处理已完成；已取消后续账号加固，本地账号保留' }),
      lastActivePhase: 'hardening-countdown',
      countdownTotalSec: totals
    })
    expect(states(late)).toEqual(['done', 'done', 'cancelled', 'skipped'])
  })

  it('终态归属推断：与服务端消息文案对齐', () => {
    expect(automationTerminalStageHint('奥仔处理失败：卡密余额不足')).toBe('process')
    expect(automationTerminalStageHint('新 Token 获取失败：网络超时（本地账号已保留）')).toBe('harden')
    expect(automationTerminalStageHint('官网持续要求先退出团队（已等待 60s 重试 3 次）')).toBe('harden')
    expect(automationTerminalStageHint('尚未选择 Cursor 账号，自动化中止')).toBe('prepare')
    // preflight 类失败含「会话」但发生在准备阶段，不能误标到加固步骤
    expect(automationTerminalStageHint('浏览器会话读取失败，请先登录')).toBe('prepare')
    expect(automationTerminalStageHint('奥仔处理已完成；已取消后续账号加固，本地账号保留')).toBe('harden')
  })
})

describe('automationRunView · 无感切换子状态', () => {
  const handover = { accountId: 'a2', label: 'spare@example.com', startedAt: 1_000 }

  it('状态用用户语句，原文保留在 rawMessage', () => {
    const preparing = automationRunView({
      run: runFor({ phase: 'processing', message: 'x', handover: { ...handover, status: 'preparing', message: '票据已就绪，等待退款完成' } }),
      lastActivePhase: 'processing',
      countdownTotalSec: totals
    }).handover
    expect(preparing).toEqual({ label: 'spare@example.com', status: 'preparing', detail: '准备中', rawMessage: '票据已就绪，等待退款完成' })

    const switching = automationRunView({
      run: runFor({ phase: 'deleting', message: 'x', handover: { ...handover, status: 'switching', message: '等待 Cursor 接收并确认' } }),
      lastActivePhase: 'deleting',
      countdownTotalSec: totals
    }).handover
    expect(switching?.detail).toBe('等待 Cursor 确认')
  })

  it('切换前等待只把秒数提上屏；完成附耗时；失败附原因', () => {
    const waiting = automationRunView({
      run: runFor({ phase: 'hardening-countdown', remainingSec: 4, message: 'x', handover: { ...handover, status: 'preparing', message: '票据已就绪，3.5s 后切换' } }),
      lastActivePhase: 'hardening-countdown',
      countdownTotalSec: totals
    }).handover
    expect(waiting?.detail).toBe('4 秒后切换')

    const done = automationRunView({
      run: runFor({ phase: 'done', message: 'x', handover: { ...handover, status: 'done', message: 'Cursor 已完成接手', finishedAt: 3_000 } }),
      lastActivePhase: 'cleaning',
      countdownTotalSec: totals
    }).handover
    expect(done?.detail).toBe('已切换 · 2.0 秒')

    const failed = automationRunView({
      run: runFor({ phase: 'done', message: 'x', handover: { ...handover, status: 'failed', message: '切号补丁未安装', finishedAt: 3_000 } }),
      lastActivePhase: 'cleaning',
      countdownTotalSec: totals
    }).handover
    expect(failed?.detail).toBe('切换失败：切号补丁未安装')
  })
})
