import { describe, expect, it } from 'vitest'
import type { CursorModelOption, CursorModelVariant } from '../src/domain/cursor-model'
import {
  SESSION_WARMUP_PROMPT,
  SESSION_WARMUP_SESSION_NAME,
  isWarmupModelRejection,
  pickWarmupSelectionFromOption,
  rankWarmupModelCandidates,
  warmupDoneMessage
} from '../src/domain/session-warmup'
import { SessionWarmupService } from '../src/application/session-warmup-service'
import type {
  CursorCdpCreateInput,
  CursorCdpCreateResult,
  CursorComposerRuntimeEvidence
} from '../src/infrastructure/cursor/cursor-cdp-session-creator'

function modelOption(modelId: string, displayName: string, variants?: CursorModelVariant[]): CursorModelOption {
  return {
    modelId,
    displayName,
    parameters: [],
    maxMode: false,
    selected: false,
    optionLabels: [],
    parameterDefinitions: [],
    ...(variants ? { variants } : {})
  }
}

describe('rankWarmupModelCandidates', () => {
  it('按牌价偏好链排序：Luna 首选，目录缺失的型号跳过', () => {
    const candidates = rankWarmupModelCandidates([
      modelOption('gpt-5-4-nano', 'GPT-5.4 Nano'),
      modelOption('gpt-5-6-luna', 'GPT-5.6 Luna'),
      modelOption('gpt-5-6-sol', 'GPT-5.6 Sol')
    ])
    expect(candidates.map((candidate) => candidate.label)).toEqual(['GPT-5.6 Luna', 'GPT-5.4 Nano'])
  })

  it('词边界匹配：gpt-5-mini 不命中 gpt-5-6-mini 等变体名', () => {
    const candidates = rankWarmupModelCandidates([modelOption('gpt-5-6-mini-thinker', 'GPT-5.6 Mini Thinker')])
    expect(candidates).toEqual([])
  })

  it('目录没有任何低成本模型时返回空（调用方报告，绝不静默换贵模型）', () => {
    expect(rankWarmupModelCandidates([modelOption('gpt-5-6-sol', 'GPT-5.6 Sol')])).toEqual([])
    expect(rankWarmupModelCandidates([])).toEqual([])
  })

  it('候选数量封顶，且 maxMode 恒为 false', () => {
    const candidates = rankWarmupModelCandidates([
      modelOption('gpt-5-6-luna', 'GPT-5.6 Luna'),
      modelOption('gpt-4o-mini', 'GPT-4o mini'),
      modelOption('gpt-5-4-nano', 'GPT-5.4 Nano'),
      modelOption('gpt-5-mini', 'GPT-5 Mini')
    ])
    expect(candidates).toHaveLength(3)
    expect(candidates.every((candidate) => candidate.selection.maxMode === false)).toBe(true)
  })
})

describe('pickWarmupSelectionFromOption（无思考变体）', () => {
  const thinkingDefinition = {
    id: 'thinking',
    displayName: 'Thinking',
    kind: 'enum' as const,
    values: [
      { value: 'off', displayName: 'Off', increasesCost: false },
      { value: 'high', displayName: 'High', increasesCost: true }
    ]
  }

  it('选成本分最低的 variant（思考关闭），同分优先目录默认非 MAX 配置', () => {
    const option: CursorModelOption = {
      ...modelOption('gpt-5-6-luna', 'GPT-5.6 Luna'),
      parameterDefinitions: [thinkingDefinition],
      variants: [
        { parameters: [{ id: 'thinking', value: 'high' }], maxMode: false },
        { parameters: [{ id: 'thinking', value: 'off' }], maxMode: false, isDefaultNonMaxConfig: true },
        { parameters: [{ id: 'thinking', value: 'off' }], maxMode: true }
      ]
    }
    const selection = pickWarmupSelectionFromOption(option)
    expect(selection.parameters).toEqual([{ id: 'thinking', value: 'off' }])
    expect(selection.maxMode).toBe(false)
  })

  it('无 variants 时沿用条目默认参数', () => {
    const option: CursorModelOption = {
      ...modelOption('gpt-4o-mini', 'GPT-4o mini'),
      parameters: [{ id: 'thinking', value: 'off' }]
    }
    expect(pickWarmupSelectionFromOption(option).parameters).toEqual([{ id: 'thinking', value: 'off' }])
  })
})

describe('isWarmupModelRejection / warmupDoneMessage', () => {
  it('模型配置类错误换候选重试，链路与账号类错误立即失败', () => {
    expect(isWarmupModelRejection('model_unconfirmed:gpt-5')).toBe(true)
    expect(isWarmupModelRejection('model_config_service_not_ready')).toBe(true)
    expect(isWarmupModelRejection('composer_handle_not_ready')).toBe(true)
    expect(isWarmupModelRejection('未检测到 Cursor 调试端口')).toBe(false)
    expect(isWarmupModelRejection('Cursor 拒绝了创建请求')).toBe(false)
  })

  it('完成文案：常规与偏慢两种形态', () => {
    expect(warmupDoneMessage('GPT-5.6 Luna', 1_800, false)).toBe('预热通过 · GPT-5.6 Luna · 1.8s')
    expect(warmupDoneMessage('GPT-5.6 Luna', 12_400, true)).toContain('响应偏慢')
  })
})

interface WarmupHarness {
  service: SessionWarmupService
  created: CursorCdpCreateInput[]
  deleted: string[]
  setEvidence: (evidence: CursorComposerRuntimeEvidence | undefined) => void
  createResults: CursorCdpCreateResult[]
}

function warmupHarness(options: {
  models?: CursorModelOption[]
  evidence?: CursorComposerRuntimeEvidence
  createResults?: CursorCdpCreateResult[]
  timeoutMs?: number
} = {}): WarmupHarness {
  const created: CursorCdpCreateInput[] = []
  const deleted: string[] = []
  let evidence = options.evidence
  const createResults = [...(options.createResults ?? [{ ok: true, message: 'ok', composerId: 'warmup-c1' }])]
  const service = new SessionWarmupService({
    creator: {
      createAgentSession: async (input) => {
        created.push(input)
        return createResults.length > 1 ? createResults.shift()! : createResults[0]!
      },
      inspectComposerRuntime: async (_workspace, composerIds) => {
        const current = evidence
        return current && composerIds.includes(current.composerId) ? { [current.composerId]: current } : {}
      },
      resolveWorkbenchSocket: async () => 'ws://preview'
    },
    evaluate: async (_socket, expression) => {
      const match = expression.match(/deleteComposer\("([^"]+)"\)/)
      if (match) deleted.push(match[1]!)
      return { ok: true }
    },
    activeWorkspacePath: () => '/tmp/team-workspace',
    listModels: () => options.models ?? [modelOption('gpt-5-6-luna', 'GPT-5.6 Luna')],
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
    timeoutMs: options.timeoutMs ?? 5_000,
    pollIntervalMs: 2
  })
  return {
    service,
    created,
    deleted,
    setEvidence: (next) => { evidence = next },
    createResults
  }
}

function doneEvidence(composerId: string, text = '1'): CursorComposerRuntimeEvidence {
  return {
    composerId,
    state: 'stopped',
    detail: '',
    observedAt: Date.now(),
    isGenerating: false,
    responseText: text
  }
}

describe('SessionWarmupService', () => {
  it(' happy path：创建→观测到响应完成→删除预热会话，产出耗时', async () => {
    const harness = warmupHarness({ evidence: doneEvidence('warmup-c1') })
    const run = await harness.service.warmup()
    expect(run.phase).toBe('done')
    expect(run.modelLabel).toBe('GPT-5.6 Luna')
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
    expect(run.message).toContain('预热通过')
    expect(harness.created).toHaveLength(1)
    expect(harness.created[0]).toMatchObject({
      channelId: '0',
      name: SESSION_WARMUP_SESSION_NAME,
      prompt: SESSION_WARMUP_PROMPT,
      workspacePath: '/tmp/team-workspace'
    })
    // 预热会话的模型配置随创建提交
    expect(harness.created[0]?.modelSelection?.modelId).toBe('gpt-5-6-luna')
    expect(harness.deleted).toEqual(['warmup-c1'])
  })

  it('仍在生成中（isGenerating）时继续等待，直到响应落定', async () => {
    const harness = warmupHarness({
      evidence: { ...doneEvidence('warmup-c1'), isGenerating: true, responseText: '1' }
    })
    let polls = 0
    const service = new SessionWarmupService({
      creator: {
        createAgentSession: async () => ({ ok: true, message: 'ok', composerId: 'warmup-c1' }),
        inspectComposerRuntime: async () => {
          polls += 1
          // 前两拍仍在生成，第三拍落定
          return polls >= 3 ? { 'warmup-c1': doneEvidence('warmup-c1') } : { 'warmup-c1': { ...doneEvidence('warmup-c1'), isGenerating: true } }
        },
        resolveWorkbenchSocket: async () => 'ws://preview'
      },
      evaluate: async () => ({ ok: true }),
      activeWorkspacePath: () => undefined,
      listModels: () => [modelOption('gpt-5-6-luna', 'GPT-5.6 Luna')],
      sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
      pollIntervalMs: 2
    })
    const run = await service.warmup()
    expect(run.phase).toBe('done')
    expect(polls).toBeGreaterThanOrEqual(3)
  })

  it('模型被 Cursor 拒绝时换下一个候选，成功路径仍删除两个预热会话', async () => {
    const harness = warmupHarness({
      models: [modelOption('gpt-5-6-luna', 'GPT-5.6 Luna'), modelOption('gpt-4o-mini', 'GPT-4o mini')],
      createResults: [
        { ok: false, message: 'model_unconfirmed:gpt-5-6-luna', composerId: 'warmup-bad' },
        { ok: true, message: 'ok', composerId: 'warmup-good' }
      ],
      evidence: doneEvidence('warmup-good')
    })
    // 模型拒绝路径不删除（创建方已回滚删除），成功路径删除
    const run = await harness.service.warmup()
    expect(run.phase).toBe('done')
    expect(run.modelLabel).toBe('GPT-4o mini')
    expect(harness.created).toHaveLength(2)
    expect(harness.deleted).toEqual(['warmup-good'])
  })

  it('非模型类创建失败（如 CDP 不可达）立即中止，不尝试后续候选', async () => {
    const harness = warmupHarness({
      models: [modelOption('gpt-5-6-luna', 'GPT-5.6 Luna'), modelOption('gpt-4o-mini', 'GPT-4o mini')],
      createResults: [{ ok: false, message: '未检测到 Cursor 调试端口（127.0.0.1:9333）' }]
    })
    const run = await harness.service.warmup()
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('调试端口')
    expect(harness.created).toHaveLength(1)
  })

  it('响应超时：失败并删除预热会话，提示账号可能不可用', async () => {
    const harness = warmupHarness({ evidence: undefined, timeoutMs: 20 })
    const run = await harness.service.warmup()
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('预热响应超时')
    expect(run.message).toContain('已中止批量发起')
    expect(harness.deleted).toEqual(['warmup-c1'])
  })

  it('无低成本候选：直接失败且不创建任何会话', async () => {
    const harness = warmupHarness({ models: [modelOption('gpt-5-6-sol', 'GPT-5.6 Sol')] })
    const run = await harness.service.warmup()
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('绝不静默切换贵模型')
    expect(harness.created).toHaveLength(0)
  })

  it('删除失败不翻转预热结论（尽力而为）', async () => {
    const harness = warmupHarness({ evidence: doneEvidence('warmup-c1') })
    const service = new SessionWarmupService({
      creator: {
        createAgentSession: async () => ({ ok: true, message: 'ok', composerId: 'warmup-c1' }),
        inspectComposerRuntime: async () => ({ 'warmup-c1': doneEvidence('warmup-c1') }),
        resolveWorkbenchSocket: async () => undefined // socket 不可得：删除跳过
      },
      evaluate: async () => ({ ok: true }),
      activeWorkspacePath: () => undefined,
      listModels: () => [modelOption('gpt-5-6-luna', 'GPT-5.6 Luna')],
      sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
      pollIntervalMs: 2
    })
    const run = await service.warmup()
    expect(run.phase).toBe('done')
  })

  it('并发调用不叠加：共享同一在途轮次，同获终态', async () => {
    const harness = warmupHarness({ evidence: doneEvidence('warmup-c1') })
    let resolveCreate: ((result: CursorCdpCreateResult) => void) | undefined
    const service = new SessionWarmupService({
      creator: {
        createAgentSession: (input) => {
          harness.created.push(input)
          return new Promise((resolve) => { resolveCreate = resolve })
        },
        inspectComposerRuntime: async () => ({ 'warmup-c1': doneEvidence('warmup-c1') }),
        resolveWorkbenchSocket: async () => 'ws://preview'
      },
      evaluate: async () => ({ ok: true }),
      activeWorkspacePath: () => undefined,
      listModels: () => [modelOption('gpt-5-6-luna', 'GPT-5.6 Luna')],
      sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
      pollIntervalMs: 2
    })
    const first = service.warmup()
    const second = service.warmup()
    // 放行创建后，两个调用拿到同一个终态；全程只创建一次
    resolveCreate!({ ok: true, message: 'ok', composerId: 'warmup-c1' })
    const [firstRun, secondRun] = await Promise.all([first, second])
    expect(firstRun.phase).toBe('done')
    expect(secondRun.phase).toBe('done')
    expect(harness.created).toHaveLength(1)
  })
})
