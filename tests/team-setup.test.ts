import { describe, expect, it } from 'vitest'
import { resolveIndependentSessionMembers } from '../src/application/team-setup'
import type { CursorModelOption } from '../src/domain/cursor-model'

const workspacePath = '/workspace'

const cursorModels: CursorModelOption[] = [{
  modelId: 'kimi-k3', displayName: 'Kimi K3', selected: true,
  parameters: [{ id: 'reasoning', value: 'high' }], optionLabels: ['High'],
  maxMode: false, supportsMaxMode: true, supportsNonMaxMode: true,
  contextTokenLimit: 1_048_576, contextTokenLimitForMaxMode: 1_048_576,
  parameterDefinitions: [{
    id: 'reasoning', displayName: 'Reasoning', kind: 'enum',
    values: [
      { value: 'low', displayName: 'Low', increasesCost: false },
      { value: 'high', displayName: 'High', increasesCost: true }
    ]
  }],
  // 真实运行态目录形态：全部 variants 均为 maxMode:false，MAX Mode 为正交开关
  variants: [
    { parameters: [{ id: 'reasoning', value: 'low' }], maxMode: false },
    { parameters: [{ id: 'reasoning', value: 'high' }], maxMode: false }
  ]
}, {
  modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', selected: false,
  parameters: [{ id: 'reasoning', value: 'medium' }], optionLabels: [],
  maxMode: false,
  parameterDefinitions: [{
    id: 'reasoning', displayName: 'Reasoning', kind: 'enum',
    values: [
      { value: 'medium', displayName: 'Medium', increasesCost: false },
      { value: 'high', displayName: 'High', increasesCost: true }
    ]
  }]
}]

/** 阶段 2 · 2B 起只剩会话池一种创建路径：席位全部 solo，模型校验是这条路径唯一的业务规则。 */
describe('resolveIndependentSessionMembers', () => {
  it('builds 1–16 isolated sessions with sequential channels and validated models', () => {
    const resolved = resolveIndependentSessionMembers(cursorModels, {
      workspacePath,
      sessions: [{}, {
        modelSelection: {
          modelId: 'kimi-k3', displayName: 'Kimi K3', maxMode: false,
          parameters: [{ id: 'reasoning', value: 'low' }]
        }
      }]
    })
    expect(resolved.map((member) => [member.channelId, member.roleTemplateKey, member.solo, member.skills])).toEqual([
      ['1', 'solo', true, []], ['2', 'solo', true, []]
    ])
    expect(resolved[1]?.modelSelection?.parameters).toEqual([{ id: 'reasoning', value: 'low' }])
    expect(() => resolveIndependentSessionMembers(cursorModels, { workspacePath, sessions: [] })).toThrowError(/1 到 16/)
    expect(() => resolveIndependentSessionMembers(cursorModels, {
      workspacePath, sessions: Array.from({ length: 17 }, () => ({}))
    })).toThrowError(/1 到 16/)
    expect(() => resolveIndependentSessionMembers(cursorModels, {
      workspacePath, sessions: [null as unknown as Record<string, never>]
    })).toThrowError(/配置无效/)
  })

  it('defaults every seat to Cursor current model and rejects stale or invalid parameters', () => {
    const [member] = resolveIndependentSessionMembers(cursorModels, { workspacePath, sessions: [{}] })
    expect(member?.modelSelection).toMatchObject({ modelId: 'kimi-k3', displayName: 'Kimi K3' })
    expect(() => resolveIndependentSessionMembers(cursorModels, {
      workspacePath,
      sessions: [{ modelSelection: { modelId: 'retired-model', displayName: 'Old', parameters: [] } }]
    })).toThrowError(/不可用或已失效/)
    expect(() => resolveIndependentSessionMembers(cursorModels, {
      workspacePath,
      sessions: [{ modelSelection: { modelId: 'kimi-k3', displayName: 'Kimi K3', parameters: [{ id: 'reasoning', value: 'ultra' }] } }]
    })).toThrowError(/参数不可用/)
  })

  it('resolves the display name from the catalog, not from the caller', () => {
    const [member] = resolveIndependentSessionMembers(cursorModels, {
      workspacePath,
      sessions: [{
        modelSelection: {
          modelId: 'gpt-5.3-codex', displayName: '伪造名称', maxMode: false,
          parameters: [{ id: 'reasoning', value: 'high' }]
        }
      }]
    })
    expect(member?.modelSelection).toEqual({
      modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', maxMode: false,
      parameters: [{ id: 'reasoning', value: 'high' }]
    })
  })

  it('persists MAX Mode independently from reasoning parameters', () => {
    const [member] = resolveIndependentSessionMembers(cursorModels, {
      workspacePath,
      sessions: [{
        modelSelection: {
          modelId: 'kimi-k3', displayName: 'Kimi K3', maxMode: true,
          parameters: [{ id: 'reasoning', value: 'high' }]
        }
      }]
    })
    expect(member?.modelSelection).toMatchObject({
      modelId: 'kimi-k3',
      maxMode: true,
      parameters: [{ id: 'reasoning', value: 'high' }]
    })
  })

  it('orthogonal catalog (all-false variants) accepts MAX Mode on any parameter combo, constrained catalog still enforces', () => {
    // Kimi K3 形态：目录全 false + supportsMaxMode——maxMode 不参与组合约束
    expect(() => resolveIndependentSessionMembers(cursorModels, {
      workspacePath,
      sessions: [{
        modelSelection: {
          modelId: 'kimi-k3', displayName: 'Kimi K3', maxMode: true,
          parameters: [{ id: 'reasoning', value: 'low' }]
        }
      }]
    })).not.toThrow()

    // 约束型目录（含 true 条目）：不存在的组合仍然拒绝
    const constrained: CursorModelOption[] = [{
      modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', selected: true,
      parameters: [{ id: 'context', value: '272k' }], optionLabels: [],
      maxMode: false, supportsMaxMode: true, supportsNonMaxMode: true,
      parameterDefinitions: [{ id: 'context', displayName: 'Context', kind: 'enum', values: [
        { value: '272k', displayName: '272K', increasesCost: false },
        { value: '1m', displayName: '1M', increasesCost: true }
      ] }],
      variants: [
        { parameters: [{ id: 'context', value: '272k' }], maxMode: false },
        { parameters: [{ id: 'context', value: '1m' }], maxMode: true }
      ]
    }]
    expect(() => resolveIndependentSessionMembers(constrained, {
      workspacePath,
      sessions: [{
        modelSelection: {
          modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', maxMode: true,
          parameters: [{ id: 'context', value: '272k' }]
        }
      }]
    })).toThrowError(/模型参数组合不可用/)
    expect(() => resolveIndependentSessionMembers(constrained, {
      workspacePath,
      sessions: [{
        modelSelection: {
          modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', maxMode: true,
          parameters: [{ id: 'context', value: '1m' }]
        }
      }]
    })).not.toThrow()
  })
})
