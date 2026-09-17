// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorModelOption, CursorModelSelection } from '../src/domain/cursor-model'
import { RunSeats } from '../src/renderer/src/run/RunSeats'

const opus: CursorModelOption = {
  modelId: 'claude-opus-5',
  displayName: 'Claude Opus 5',
  selected: true,
  parameters: [
    { id: 'thinking', value: 'true' },
    { id: 'context', value: '1m' },
    { id: 'effort', value: 'max' },
    { id: 'fast', value: 'true' }
  ],
  maxMode: true,
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  optionLabels: ['Think', '1M', 'Max', 'Fast'],
  parameterDefinitions: [
    {
      id: 'thinking', displayName: 'Thinking', kind: 'boolean',
      values: [
        { value: 'false', displayName: 'Off', increasesCost: false },
        { value: 'true', displayName: 'On', increasesCost: false }
      ]
    },
    {
      id: 'context', displayName: 'Context', kind: 'enum',
      values: [
        { value: '300k', displayName: '300K', increasesCost: false },
        { value: '1m', displayName: '1M', increasesCost: true }
      ]
    },
    {
      id: 'effort', displayName: 'Effort', kind: 'enum',
      values: [
        { value: 'low', displayName: 'Low', increasesCost: false },
        { value: 'medium', displayName: 'Medium', increasesCost: false },
        { value: 'high', displayName: 'High', increasesCost: false },
        { value: 'xhigh', displayName: 'Extra High', increasesCost: false },
        { value: 'max', displayName: 'Max', increasesCost: false }
      ]
    },
    {
      id: 'fast', displayName: 'Fast', kind: 'boolean',
      values: [
        { value: 'false', displayName: 'Off', increasesCost: false },
        { value: 'true', displayName: 'Fast', increasesCost: true }
      ]
    }
  ],
  contextTokenLimit: 300_000,
  contextTokenLimitForMaxMode: 1_000_000
}

const gptSol: CursorModelOption = {
  modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', selected: true,
  parameters: [{ id: 'context', value: '1m' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }],
  maxMode: true, supportsMaxMode: true, supportsNonMaxMode: true, optionLabels: [],
  parameterDefinitions: [
    { id: 'context', displayName: 'Context', kind: 'enum', values: [
      { value: '272k', displayName: '272K', increasesCost: false },
      { value: '1m', displayName: '1M', increasesCost: true }
    ] },
    { id: 'reasoning', displayName: 'Reasoning', kind: 'enum', values: [
      { value: 'max', displayName: 'Max', increasesCost: false }
    ] },
    { id: 'fast', displayName: 'Fast', kind: 'boolean', values: [
      { value: 'false', displayName: 'Off', increasesCost: false },
      { value: 'true', displayName: 'Fast', increasesCost: true }
    ] }
  ],
  variants: [
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }], maxMode: false },
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'true' }], maxMode: false },
    { parameters: [{ id: 'context', value: '1m' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }], maxMode: true }
  ]
}

function effortOf(selection: CursorModelSelection | undefined): string | undefined {
  return selection?.parameters.find((parameter) => parameter.id === 'effort')?.value
}

describe('run seats · per-session model config', () => {
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

  it('saves Max → High, reopens as High, and launches with High', async () => {
    const persisted: CursorModelSelection[] = []
    const launched = vi.fn<(selection: CursorModelSelection) => void>()

    function Harness(): React.JSX.Element {
      const [selection, setSelection] = useState<CursorModelSelection>(() => structuredClone(opus))
      return (
        <RunSeats
          rows={[{ channelId: '3', name: '会话 3', pending: true }]}
          cursorModels={[opus]}
          selections={{ '3': selection }}
          busy={false}
          createLabel="一键创建会话（1）"
          cdpAutoHealEnabled={false}
          onCreate={() => launched(selection)}
          onModelSave={async (_channelId: string, next: CursorModelSelection) => {
            persisted.push(structuredClone(next))
            setSelection(structuredClone(next))
          }}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    const open = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>(
      'button[aria-label="配置 CH-3 会话"]'
    )!

    await act(async () => open().click())
    const effortMax = document.querySelector<HTMLButtonElement>('button[aria-label="CH-3 弹层Effort Max"]')!
    expect(effortMax.getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('Extra High')
    expect(document.body.textContent).not.toContain('思考强度')

    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="CH-3 弹层Effort High"]')!.click())
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('.cursor-model-dialog button'))
      .find((button) => button.textContent === '保存')!
    await act(async () => save.click())

    expect(persisted).toHaveLength(1)
    expect(effortOf(persisted[0])).toBe('high')
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => open().click())
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="CH-3 弹层Effort High"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="关闭会话配置"]')!.click())

    await act(async () => {
      const launch = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('一键创建会话'))!
      launch.click()
    })
    expect(launched).toHaveBeenCalledTimes(1)
    expect(effortOf(launched.mock.calls[0]?.[0])).toBe('high')
  })

  it('keeps the editor open when persistence fails', async () => {
    await act(async () => root.render(
      <RunSeats
        rows={[{ channelId: '3', name: '会话 3', pending: true }]}
        cursorModels={[opus]}
        selections={{ '3': structuredClone(opus) }}
        busy={false}
        createLabel="一键创建会话（1）"
        cdpAutoHealEnabled={false}
        onCreate={() => {}}
        onModelSave={async () => { throw new Error('落库失败') }}
      />
    ))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-3 会话"]')!.click())
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('.cursor-model-dialog button'))
      .find((button) => button.textContent === '保存')!
    await act(async () => save.click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('落库失败')
  })

  describe('同步其余席位 / 单独配置：席位区与批次「会话配置」的配合', () => {
    const rows = [
      { channelId: '1', name: '会话 1', pending: true },
      { channelId: '2', name: '会话 2', pending: true },
      { channelId: '3', name: '会话 3', pending: true }
    ]
    const dialogButton = (label: string): HTMLButtonElement => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.cursor-model-dialog button'))
        .find((candidate) => candidate.textContent === label)
      if (!button) throw new Error(`dialog button "${label}" not found`)
      return button
    }

    it('an overridden row wears a dismissible 「单独配置」 chip whose × calls onModelReset; without a reset handler the chip is a plain marker', async () => {
      const reset = vi.fn<(channelId: string) => void>()
      const render = (onModelReset?: (channelId: string) => void) => act(async () => root.render(
        <RunSeats
          rows={rows.map((row) => row.channelId === '2' ? { ...row, overridden: true } : row)}
          cursorModels={[opus]}
          selections={{ '1': structuredClone(opus), '2': structuredClone(opus), '3': structuredClone(opus) }}
          busy={false}
          createLabel="创建 3 个独立会话"
          cdpAutoHealEnabled={false}
          restoreHint="恢复为统一配置：Claude Opus 5 · Thinking On"
          onCreate={() => {}}
          onModelSave={() => {}}
          onModelReset={onModelReset}
        />
      ))
      await render(reset)
      const chips = [...container.querySelectorAll<HTMLElement>('.run-seat__override')]
      expect(chips).toHaveLength(1)
      expect(chips[0]!.closest('.run-seat')?.querySelector('.run-seat__channel')?.textContent).toBe('CH-2')
      expect(chips[0]!.textContent).toContain('单独配置')
      expect(chips[0]!.getAttribute('title')).toBe('恢复为统一配置：Claude Opus 5 · Thinking On')
      // 标是行主按钮的兄弟节点：按钮不能嵌在按钮里。
      expect(chips[0]!.closest('.run-seat__main')).toBeNull()
      const restore = container.querySelector<HTMLButtonElement>('button[aria-label="恢复 CH-2 为统一配置"]')!
      await act(async () => restore.click())
      expect(reset).toHaveBeenCalledWith('2')
      // 席位区没有自己的统一入口：统一配置住在批次卡的「会话配置」行。
      expect(container.querySelector('.run-seats__unify')).toBeNull()

      await render(undefined)
      expect(container.querySelectorAll('.run-seat__override')).toHaveLength(1)
      expect(container.querySelector('.run-seat__override button')).toBeNull()
    })

    it('a new syncedAt pulses every row once; the value present at mount does not', async () => {
      const render = (syncedAt?: number) => act(async () => root.render(
        <RunSeats
          rows={rows}
          cursorModels={[opus]}
          selections={{ '1': structuredClone(opus), '2': structuredClone(opus), '3': structuredClone(opus) }}
          busy={false}
          createLabel="创建 3 个独立会话"
          cdpAutoHealEnabled={false}
          syncedAt={syncedAt}
          onCreate={() => {}}
          onModelSave={() => {}}
        />
      ))
      await render(1_000)
      expect(container.querySelector('.run-seat.is-synced')).toBeNull()
      await render(2_000)
      expect(container.querySelectorAll('.run-seat.is-synced')).toHaveLength(3)
    })

    it('a single-seat editor can sync the rest: the toggle relabels the save button and routes through the bulk save', async () => {
      const saveAll = vi.fn<(channelIds: string[], selection: CursorModelSelection) => void>()
      const saveOne = vi.fn()
      await act(async () => root.render(
        <RunSeats
          rows={rows}
          cursorModels={[opus]}
          selections={{ '1': structuredClone(opus), '2': structuredClone(opus), '3': structuredClone(opus) }}
          busy={false}
          createLabel="创建 3 个独立会话"
          cdpAutoHealEnabled={false}
          onCreate={() => {}}
          onModelSave={saveOne}
          onModelSaveAll={saveAll}
        />
      ))
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-2 会话"]')!.click())
      const dialog = document.querySelector('[role="dialog"]')!
      expect(dialog.textContent).toContain('CH-2 · 模型与参数')
      const toggle = dialog.querySelector<HTMLInputElement>('footer .toggle-switch input')!
      expect(dialog.querySelector('footer .toggle-switch__text')?.textContent).toBe('同时应用到其余 2 个席位')
      expect(toggle.checked).toBe(false)
      expect(dialogButton('保存')).toBeTruthy()

      await act(async () => toggle.click())
      expect(toggle.checked).toBe(true)
      expect(dialog.textContent).toContain('保存到 CH-2 及其余 2 个席位')
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="CH-2 弹层Effort Low"]')!.click())
      await act(async () => dialogButton('保存到 3 个席位').click())

      expect(saveOne).not.toHaveBeenCalled()
      expect(saveAll).toHaveBeenCalledTimes(1)
      expect(saveAll.mock.calls[0]?.[0]).toEqual(['1', '2', '3'])
      expect(effortOf(saveAll.mock.calls[0]?.[1])).toBe('low')
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })

    it('syncing the rest falls back to one save per seat when no bulk handler is wired, and stays open if any of them fails', async () => {
      const saved: string[] = []
      await act(async () => root.render(
        <RunSeats
          rows={rows}
          cursorModels={[opus]}
          selections={{ '1': structuredClone(opus), '2': structuredClone(opus), '3': structuredClone(opus) }}
          busy={false}
          createLabel="创建 3 个独立会话"
          cdpAutoHealEnabled={false}
          onCreate={() => {}}
          onModelSave={async (channelId: string) => {
            saved.push(channelId)
            if (channelId === '3') throw new Error('CH-3 落库失败')
          }}
        />
      ))
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-1 会话"]')!.click())
      await act(async () => document.querySelector<HTMLInputElement>('.cursor-model-dialog footer .toggle-switch input')!.click())
      await act(async () => dialogButton('保存到 3 个席位').click())
      expect(saved).toEqual(['1', '2', '3'])
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('CH-3 落库失败')
      expect(container.querySelector('.run-seat.is-synced')).toBeNull()
    })

    it('offers no sync toggle with a single seat, and none once the run has ended', async () => {
      await act(async () => root.render(
        <RunSeats
          rows={[rows[0]!]}
          cursorModels={[opus]}
          selections={{ '1': structuredClone(opus) }}
          busy={false}
          createLabel="创建 1 个独立会话"
          cdpAutoHealEnabled={false}
          onCreate={() => {}}
          onModelSave={() => {}}
        />
      ))
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-1 会话"]')!.click())
      expect(document.querySelector('[role="dialog"] footer .toggle-switch')).toBeNull()
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="关闭会话配置"]')!.click())

      await act(async () => root.render(
        <RunSeats
          rows={rows.map((row) => ({ ...row, pending: false, state: 'offline' as const }))}
          cursorModels={[opus]}
          selections={{ '1': structuredClone(opus), '2': structuredClone(opus), '3': structuredClone(opus) }}
          busy={false}
          ended
          createLabel="补齐会话（0）"
          cdpAutoHealEnabled={false}
          onCreate={() => {}}
          onModelSave={() => {}}
        />
      ))
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-2 会话"]')!.click())
      expect(document.querySelector('[role="dialog"] footer .toggle-switch')).toBeNull()
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="关闭会话配置"]')!.click())
    })
  })

  it('mirrors Cursor linkage when GPT-5.6 Sol Fast conflicts with 1M', async () => {
    await act(async () => root.render(
      <RunSeats
        rows={[{ channelId: '1', name: '会话 1', pending: true }]}
        cursorModels={[gptSol]}
        selections={{ '1': structuredClone(gptSol) }}
        busy={false}
        createLabel="一键创建会话（1）"
        cdpAutoHealEnabled={false}
        onCreate={() => {}}
        onModelSave={() => {}}
      />
    ))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-1 会话"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="CH-1 弹层Fast Fast"]')!.click())
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="CH-1 弹层Context 272K"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector<HTMLInputElement>('.cursor-model-dialog__max-mode input')?.checked).toBe(false)
    expect(document.body.textContent).toContain('Cursor 联动：Context → 272K · MAX Mode → Off')
  })
})
