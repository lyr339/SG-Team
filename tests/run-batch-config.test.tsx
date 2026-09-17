// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorModelSelection } from '../src/domain/cursor-model'
import { cursorModelSelectionFromOption } from '../src/renderer/src/cursor-model-selection'
import { desktopSnapshot } from '../src/renderer/src/preview/mock-data'
import { RunBatchConfig, describeSelectionSpread, majoritySelection } from '../src/renderer/src/run/RunBatchConfig'

const models = desktopSnapshot.cursorModels ?? []
const composer = cursorModelSelectionFromOption(models.find((model) => model.modelId === 'composer-2.5'))!
const fable = cursorModelSelectionFromOption(models.find((model) => model.modelId === 'claude-fable-5'))!
const gpt = cursorModelSelectionFromOption(models.find((model) => model.modelId === 'gpt-5.2'))!
const composerSlow: CursorModelSelection = { ...structuredClone(composer), parameters: [{ id: 'fast', value: 'false' }] }

describe('会话配置行 · RunBatchConfig', () => {
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

  const action = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('.run-batch-config__action')!
  const dialogButton = (label: string): HTMLButtonElement => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.cursor-model-dialog button')].find((candidate) => candidate.textContent === label)
    if (!button) throw new Error(`dialog button "${label}" not found`)
    return button
  }

  it('shows the uniform selection with its provider swatch, the implicit tag and the parameter summary', async () => {
    await act(async () => root.render(
      <RunBatchConfig models={models} seatCount={3} uniform={composer} implicit onSave={() => {}} />
    ))
    const strong = container.querySelector('.run-batch-config__value strong')!
    expect(strong.className).toBe('provider-cursor')
    expect(strong.querySelector('.run-batch-config__swatch')).not.toBeNull()
    expect(strong.querySelector('span')?.textContent).toBe('Composer 2.5')
    expect(container.querySelector('.run-batch-config__tag')?.textContent).toBe('Cursor 当前')
    expect(container.querySelector('.run-batch-config__value > small')?.textContent).toBe('Fast · MAX Mode Off · Context 200K · Standard')
    expect(container.querySelector('.run-batch-config__note')).toBeNull()
    expect(action().textContent).toBe('修改')
    expect(action().disabled).toBe(false)
    expect(action().getAttribute('aria-label')).toBe('修改全部 3 个席位的会话配置')
    // 首次挂载不放换装动画。
    expect(container.querySelector('.run-batch-config__value.is-swapped')).toBeNull()
  })

  it('notes how many seats deviate from the baseline, and drops the implicit tag once the baseline was set explicitly', async () => {
    await act(async () => root.render(
      <RunBatchConfig models={models} seatCount={5} uniform={fable} overriddenCount={2} onSave={() => {}} />
    ))
    expect(container.querySelector('.run-batch-config__value strong')?.className).toBe('provider-anthropic')
    expect(container.querySelector('.run-batch-config__tag')).toBeNull()
    expect(container.querySelector('.run-batch-config__note')?.textContent).toBe('另有 2 席单独配置')
  })

  it('without a baseline it describes the spread and offers 「统一」 drafted from the fallback seat', async () => {
    const onSave = vi.fn()
    await act(async () => root.render(
      <RunBatchConfig models={models} seatCount={4} spread="2 席 Composer 2.5 · 2 席 Claude Fable 5" fallback={fable} onSave={onSave} />
    ))
    expect(container.querySelector('.run-batch-config.is-spread')).not.toBeNull()
    expect(container.querySelector('.run-batch-config__value strong')?.textContent).toBe('各席配置不同')
    expect(container.querySelector('.run-batch-config__value > small')?.textContent).toBe('2 席 Composer 2.5 · 2 席 Claude Fable 5')
    expect(action().textContent).toBe('统一')
    expect(action().getAttribute('aria-label')).toBe('统一全部 4 个席位的会话配置')

    await act(async () => action().click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('全部席位 会话配置')
    expect(dialog.textContent).toContain('全部 4 个席位 · 模型与参数')
    expect(dialog.querySelector('.menu-select__button')?.textContent).toContain('Claude Fable 5')
    await act(async () => dialogButton('应用到 4 个席位').click())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ modelId: 'claude-fable-5' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('「修改」 opens the all-seats dialog drafted from the uniform selection; a successful save closes it and replays the swap animation', async () => {
    const onSave = vi.fn(async (_selection: CursorModelSelection) => {})
    await act(async () => root.render(
      <RunBatchConfig models={models} seatCount={3} uniform={composer} implicit onSave={onSave} />
    ))
    await act(async () => action().click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('.menu-select__button')?.textContent).toContain('Composer 2.5')
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="全部席位 弹层Fast Fast"]')?.getAttribute('aria-pressed')).toBe('true')
    // 全体范围没有「同步其余」开关——本来就是全部。
    expect(dialog.querySelector('footer .toggle-switch')).toBeNull()

    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="全部席位 弹层Fast Off"]')!.click())
    await act(async () => dialogButton('应用到 3 个席位').click())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0].parameters).toEqual([{ id: 'fast', value: 'false' }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('.run-batch-config__value.is-swapped')).not.toBeNull()
  })

  it('keeps the dialog open with the error when saving fails, and does not replay the swap animation', async () => {
    await act(async () => root.render(
      <RunBatchConfig models={models} seatCount={3} uniform={composer} onSave={async () => { throw new Error('CH-2 落库失败') }} />
    ))
    await act(async () => action().click())
    await act(async () => dialogButton('应用到 3 个席位').click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('CH-2 落库失败')
    expect(container.querySelector('.run-batch-config__value.is-swapped')).toBeNull()
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="关闭会话配置"]')!.click())
  })

  it('is inert until the model catalog has loaded, and disabled while launching or with no seats', async () => {
    await act(async () => root.render(<RunBatchConfig models={[]} seatCount={3} onSave={() => {}} />))
    expect(container.querySelector('.run-batch-config__value strong')?.textContent).toBe('Cursor 当前模型')
    expect(container.querySelector('.run-batch-config__value > small')?.textContent).toContain('模型目录加载后')
    expect(container.querySelector('.run-batch-config.is-spread')).toBeNull()
    expect(action().textContent).toBe('修改')
    expect(action().disabled).toBe(true)

    await act(async () => root.render(<RunBatchConfig models={models} seatCount={3} uniform={composer} disabled onSave={() => {}} />))
    expect(action().disabled).toBe(true)
    await act(async () => root.render(<RunBatchConfig models={models} seatCount={0} uniform={composer} onSave={() => {}} />))
    expect(action().disabled).toBe(true)
  })
})

describe('批次基线与分布', () => {
  it('majoritySelection needs a strict majority; parameter order and a missing MAX Mode flag do not split a group', () => {
    const composerReordered: CursorModelSelection = { ...structuredClone(composer), maxMode: undefined }
    expect(majoritySelection([composer, composerReordered, fable])).toBe(composer)
    expect(majoritySelection([composer, fable])).toBeUndefined()
    expect(majoritySelection([composer, composer, fable, fable])).toBeUndefined()
    expect(majoritySelection([composer, composer, fable, gpt, fable])).toBeUndefined()
    expect(majoritySelection([composer, composer, composer, fable, gpt])).toBe(composer)
    expect(majoritySelection([composer, composerSlow, composerSlow])).toBe(composerSlow)
    expect(majoritySelection([])).toBeUndefined()
    expect(majoritySelection([undefined, composer])).toBeUndefined()
    expect(majoritySelection([undefined, composer, composer])).toBe(composer)
  })

  it('describeSelectionSpread groups seats by model, most common first, and names parameter-only differences', () => {
    expect(describeSelectionSpread([composer, fable, fable, gpt])).toBe('2 席 Claude Fable 5 · 1 席 Composer 2.5 · 1 席 GPT-5.2')
    expect(describeSelectionSpread([composer, composerSlow])).toBe('Composer 2.5 · 参数各不相同')
    expect(describeSelectionSpread([undefined, undefined])).toBe('Cursor 当前模型 · 参数各不相同')
    expect(describeSelectionSpread([])).toBe('')
  })
})
