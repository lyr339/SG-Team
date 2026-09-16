/**
 * 设计走查入口：mock 掉 preload API，在纯浏览器里渲染完整应用。
 * 仅供 preview.html 使用，不进入生产构建，不连接任何端口。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AccountAutomationRun } from '../../../domain/account-automation'
import { parseCursorAccountCard } from '../../../domain/cursor-account-card'
import type { ConversationEntry } from '../../../domain/conversation-entry'
import { AGENT_AVATAR_IDS, createConfiguredTeamBundle, emptyTeamControlSnapshot } from '../../../domain/team-control'
import type { TeamRunStatus } from '../../../domain/team-control'
import type { LiveProcessState, LiveStatusLineState, SgDesktopApi } from '../../../shared/desktop-api'
import type { WorkspaceReviewSummary } from '../../../domain/workspace-review'
import { estimateTurnCostUsd, estimateUsageFromReference, priceForModel, projectUsage, type CursorUsageSnapshot, type UsageTurn } from '../../../domain/cursor-usage'
import { CURSOR_STORAGE_CATALOG, buildCleanupPlan, type CursorStorageScan } from '../../../domain/cursor-storage-cleanup'
import { formatFileSize } from '../../../shared/format-file-size'
import { App } from '../App'
import { applyAppearancePreferences, readAppearancePreferences } from '../appearance-preferences'
import {
  collaborationSnapshot,
  continuitySnapshot,
  desktopSnapshot,
  memorySnapshot,
  taskPoolSnapshot,
  teamControlSnapshot
} from './mock-data'
import '../claude-theme.css'
import '../styles.css'
import '../lobby/lobby.css'
import '../settings/settings.css'
import '../settings/stats.css'
import '../run/run.css'
import '../controls.css'
import '../workspace-inspector.css'

type Listener<T> = (snapshot: T) => void

const previewParameters = new URLSearchParams(window.location.search)
const pumpScene = previewParameters.get('pump')
const setupMode = previewParameters.get('setup') === '1'
const detectedWorkspaceMode = previewParameters.get('detectedWorkspace') === '1'
const activeExecutingMode = previewParameters.get('activeExecuting') === '1'
const manualHandoffMode = previewParameters.get('handoff') === '1'
const offlineSessionsPreviewMode = previewParameters.get('offlineSessions') === '1'
const messageFormatPreviewMode = previewParameters.get('messageFormat') === '1'
const requestedRunStatus = previewParameters.get('runStatus')
// 账号自动化走查场景：?automation=countdown|processing|importing|deleting|done|failed|cancelled
const automationScene = (['countdown', 'processing', 'importing', 'deleting', 'done', 'failed', 'cancelled'] as const)
  .find((phase) => phase === previewParameters.get('automation'))
const previewNow = Date.now()
const automationSceneRun: AccountAutomationRun | undefined = automationScene ? ({
  countdown: { phase: 'countdown', message: '将在 6.5s 后自动处理当前账号（可取消）', remainingSec: 6.5, planId: 'preview-plan', startedAt: previewNow - 3_500 },
  processing: {
    phase: 'processing', message: '奥仔：正在提交 Session Token 处理…', planId: 'preview-plan', startedAt: previewNow - 12_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'preparing', message: '票据已就绪，等待退款完成', startedAt: previewNow - 10_000 }
  },
  importing: { phase: 'importing', message: '会话已失效，正在刷新浏览器会话获取新 Token…', planId: 'preview-plan', startedAt: previewNow - 26_000 },
  deleting: {
    phase: 'deleting', message: '奥仔已完成，正在刷新浏览器会话并秒级加固账号…', planId: 'preview-plan', startedAt: previewNow - 31_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'switching', message: '等待 Cursor 接收并确认', startedAt: previewNow - 8_000 }
  },
  done: {
    phase: 'done', message: '自动化完成：已处理、账号已加固（浏览器会话内秒级执行）、本地记录已移除', planId: 'preview-plan', startedAt: previewNow - 47_000, finishedAt: previewNow - 5_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'done', message: 'Cursor 已完成接手', startedAt: previewNow - 18_000, finishedAt: previewNow - 16_000 }
  },
  failed: { phase: 'failed', message: '奥仔处理失败：卡密余额不足，请先充值或更换卡密（本地账号已保留）', planId: 'preview-plan', startedAt: previewNow - 22_000, finishedAt: previewNow - 8_000 },
  cancelled: { phase: 'cancelled', message: '已取消本次自动化', planId: 'preview-plan', startedAt: previewNow - 9_000, finishedAt: previewNow - 4_000 }
} as const)[automationScene] : undefined
// 会话预热走查场景：?warmup=running|done|slow|failed|no-model
const warmupScene = (['running', 'done', 'slow', 'failed', 'no-model'] as const)
  .find((scene) => scene === previewParameters.get('warmup'))
const previewWarmupRun: import('../../../domain/session-warmup').SessionWarmupRun | undefined = warmupScene ? ({
  running: { phase: 'waiting' as const, message: '预热会话已提交，等待 GPT-5.6 Luna 响应…', modelLabel: 'GPT-5.6 Luna', startedAt: previewNow - 2_000 },
  done: { phase: 'done' as const, message: '预热通过 · GPT-5.6 Luna · 1.8s', modelLabel: 'GPT-5.6 Luna', startedAt: previewNow - 1_800, finishedAt: previewNow, durationMs: 1_800 },
  slow: { phase: 'done' as const, message: '预热通过 · GPT-5.6 Luna · 12.4s（响应偏慢，账号可能拥挤）', modelLabel: 'GPT-5.6 Luna', startedAt: previewNow - 12_400, finishedAt: previewNow, durationMs: 12_400, slow: true },
  failed: { phase: 'failed' as const, message: '预热响应超时（30s 内 GPT-5.6 Luna 未产出回复）——账号可能已不可用，已中止批量发起', modelLabel: 'GPT-5.6 Luna', startedAt: previewNow - 30_000, finishedAt: previewNow - 1_000 },
  'no-model': { phase: 'failed' as const, message: '未在 Cursor 模型目录中找到可用的低成本模型（GPT-5.6 Luna 等）；已中止预热，绝不静默切换贵模型', startedAt: previewNow - 500, finishedAt: previewNow }
} as const)[warmupScene] : undefined
const previewRunStatus = (['draft', 'ready', 'launching', 'running', 'attention', 'paused', 'completed'] as TeamRunStatus[])
  .find((status) => status === requestedRunStatus)
// 右栏「变更」面板走查：?review=clean|not_git|error|many（缺省为两文件就绪态）。
const reviewScene = (['clean', 'not_git', 'error', 'many'] as const).find((scene) => scene === previewParameters.get('review'))
/** 预览里的「Cursor 当前工程」与它的通道号：`?detectedWorkspace=1` 换成另一个工程（4 个通道）。 */
const previewWorkspace = detectedWorkspaceMode
  ? { workspaceId: 'detected-property-app', workspaceName: '物业管理', workspacePath: '/Users/demo/Workspace/物业管理', channelIds: ['1', '2', '3', '4'] }
  : { workspaceId: 'wedge-demo', workspaceName: 'wedge-demo', workspacePath: '/Users/demo/Workspace/wedge-demo', channelIds: ['1', '2', '3', '4', '5'] }

// `?setup=1`：没有任何运行的空工作区——运行页直接进入批次配置。
const initialTeam = structuredClone(setupMode ? emptyTeamControlSnapshot() : teamControlSnapshot)
if (activeExecutingMode && initialTeam.activeRun) {
  initialTeam.members = initialTeam.members.map((member) => ({
    ...member,
    runtime: member.runtime ? { ...member.runtime, online: true, waiting: false } : member.runtime,
    readiness: 'active' as const
  }))
  initialTeam.preflight = {
    ...initialTeam.preflight,
    agentsWaiting: false,
    canLaunch: false,
    blockers: ['并非所有 Agent 通道都已在线待命', '团队已经运行']
  }
}
if (previewRunStatus && initialTeam.activeRun) {
  initialTeam.activeRun = { ...initialTeam.activeRun, status: previewRunStatus }
  initialTeam.runs = initialTeam.runs.map((run) => (
    run.id === initialTeam.activeRun?.id ? { ...run, status: previewRunStatus } : run
  ))
  if (previewRunStatus === 'launching') {
    initialTeam.bindings = initialTeam.bindings.map((binding, index) => ({
      ...binding,
      launchStatus: index === 0 ? 'acknowledged' as const : 'delivered' as const
    }))
    initialTeam.members = initialTeam.members.map((member, index) => ({
      ...member,
      binding: member.binding ? {
        ...member.binding,
        launchStatus: index === 0 ? 'acknowledged' as const : 'delivered' as const
      } : member.binding,
      readiness: index === 0 ? 'active' as const : 'launching' as const
    }))
  } else if (previewRunStatus === 'completed') {
    initialTeam.members = initialTeam.members.map((member) => ({
      ...member,
      runtime: member.runtime ? { ...member.runtime, online: false, waiting: false } : member.runtime,
      readiness: 'offline' as const
    }))
    initialTeam.runtimeChannels = initialTeam.runtimeChannels.map((channel) => ({
      ...channel,
      online: false,
      waiting: false,
      status: 'offline' as const
    }))
    initialTeam.standbyChannels = initialTeam.standbyChannels.map((channel) => ({
      ...channel,
      online: false,
      waiting: false,
      status: 'offline' as const
    }))
  }
  initialTeam.preflight = {
    ...initialTeam.preflight,
    mcpInstalled: false,
    agentsWaiting: false,
    canLaunch: false,
    blockers: ['Agent MCP 尚未接入全部本轮通道', '并非所有 Agent 通道都已在线待命']
  }
}
// 运行页独立批次走查：?independent=live|mixed|ended|groups
//（席位形态：全部待命 / 待命+执行中+离线+待确认 / 已结束 / 会话池里两个协作组 + 一个刚解散的组）。
const independentScene = (['live', 'mixed', 'ended', 'groups'] as const).find((scene) => scene === previewParameters.get('independent'))
if (independentScene && initialTeam.activeRun) {
  const solo = initialTeam.members.find((member) => member.slot.solo === true)!
  const shapes = independentScene === 'live'
    ? ['waiting', 'waiting', 'waiting'] as const
    : independentScene === 'groups'
      ? ['waiting', 'working', 'waiting', 'offline', 'waiting'] as const
      : ['waiting', 'working', 'offline', 'unconfirmed'] as const
  const status = independentScene === 'ended' ? 'completed' as const : 'running' as const
  const run = { ...initialTeam.activeRun, name: 'wedge-demo · 独立批次 #3', templateId: 'independent-session-v1', status }
  initialTeam.activeRun = run
  initialTeam.runs = [run]
  initialTeam.members = shapes.map((shape, index) => {
    const channelId = String(index + 1)
    const base = { channelId, queueDepth: 0, lastSeenAt: previewNow - (index + 1) * 40_000, healthEvidence: [], workingFiles: [] }
    return {
      ...solo,
      slot: { ...solo.slot, id: `slot:solo-${channelId}`, name: `独立席 ${channelId}`, channelId },
      binding: solo.binding ? { ...solo.binding, channelId } : undefined,
      runtime: shape === 'unconfirmed'
        ? undefined
        : shape === 'waiting'
          ? { ...base, status: 'waiting' as const, online: true, waiting: true, connectionPhase: 'waiting' }
          : shape === 'working'
            ? { ...base, status: 'running' as const, online: false, waiting: false, connectionPhase: 'processing' }
            : { ...base, status: 'offline' as const, online: false, waiting: false, connectionPhase: 'cursor_stopped', runtimeEvidence: 'stopped' as const }
    }
  })
  if (independentScene === 'groups') {
    // CH-1（lead）+ CH-2（builder）成组「接口重构」；CH-3（lead）+ CH-4（reviewer，已确认离线 → attention）成组「验收」；CH-5 独立。
    const groupRole = (member: typeof solo, groupId: string, templateKey: string, name: string, order: number) => ({
      ...member.role, id: `team-role:${groupId}:${member.slot.id}`, key: `g${groupId.slice(-8)}:${templateKey}`, templateKey, name, groupId, order
    })
    const grouped = (channelId: string, groupId: string, templateKey: string, name: string, order: number) => {
      const member = initialTeam.members.find((candidate) => candidate.slot.channelId === channelId)!
      const role = groupRole(member, groupId, templateKey, name, order)
      return { ...member, role, slot: { ...member.slot, solo: false, groupId, roleId: role.id, homeRoleId: member.slot.roleId, groupJoinedAt: previewNow - 25 * 60_000 } }
    }
    const refactorId = 'team-group:wedge-demo:preview-refactor'
    const acceptanceId = 'team-group:wedge-demo:preview-acceptance'
    const dissolvedId = 'team-group:wedge-demo:preview-dissolved'
    const members = [
      grouped('1', refactorId, 'lead', '主控协调', 0),
      grouped('2', refactorId, 'builder', '架构实现', 1),
      grouped('3', acceptanceId, 'lead', '主控协调', 0),
      grouped('4', acceptanceId, 'reviewer', '质量验证', 1),
      initialTeam.members[4]!
    ]
    initialTeam.members = members
    initialTeam.roles = [...initialTeam.roles, ...members.slice(0, 4).map((member) => member.role)]
    initialTeam.slots = members.map((member) => member.slot)
    const groupBase = { runId: run.id, planPolicy: 'lead_only' as const, createdAt: previewNow - 30 * 60_000, updatedAt: previewNow - 4 * 60_000 }
    initialTeam.groups = [
      {
        group: { ...groupBase, id: refactorId, name: '接口重构', goal: '把 TaskAgentService 的查询路径收成一个入口，补齐组作用域测试。', status: 'active', leadSlotId: members[0]!.slot.id },
        members: members.slice(0, 2), effectiveLeadSlotId: members[0]!.slot.id, attention: false
      },
      {
        group: { ...groupBase, id: acceptanceId, name: '验收', goal: '', status: 'active', leadSlotId: members[2]!.slot.id },
        members: members.slice(2, 4), effectiveLeadSlotId: members[2]!.slot.id, attention: true
      },
      {
        group: { ...groupBase, id: dissolvedId, name: '文档整理', goal: '统一 ARCHITECTURE 与 TASK-MCP 的术语。', status: 'dissolved', dissolvedAt: previewNow - 50 * 60_000 },
        members: [], effectiveLeadSlotId: undefined, attention: false
      }
    ]
  }
}
if (manualHandoffMode && initialTeam.activeRun) {
  initialTeam.activeRun = { ...initialTeam.activeRun, status: 'attention' }
  initialTeam.runs = initialTeam.runs.map((run) => run.id === initialTeam.activeRun?.id ? { ...run, status: 'attention' } : run)
  initialTeam.members = initialTeam.members.map((member, index) => ({
    ...member,
    runtime: member.runtime ? {
      ...member.runtime,
      online: index !== 0,
      waiting: index !== 0,
      queueDepth: 0,
      status: index === 0 ? 'offline' as const : 'waiting' as const
    } : member.runtime,
    readiness: index === 0 ? 'offline' as const : 'active' as const
  }))
  initialTeam.runtimeChannels = initialTeam.runtimeChannels.map((channel, index) => ({
    ...channel,
    online: index !== 0,
    waiting: index !== 0,
    queueDepth: 0,
    status: index === 0 ? 'offline' as const : 'waiting' as const
  }))
  initialTeam.standbyChannels = []
}

const state = {
  desktop: structuredClone(desktopSnapshot),
  memory: structuredClone(memorySnapshot),
  team: initialTeam
}
if (messageFormatPreviewMode) {
  const example = state.desktop.conversations['2']?.find((entry) => entry.id === 'e5')
  state.desktop.conversations = example ? { '2': [example] } : {}
}
if (previewRunStatus === 'completed') {
  state.desktop.sessions = state.desktop.sessions.map((session) => ({
    ...session,
    status: 'offline',
    online: false,
    connected: false,
    waiting: false
  }))
  state.team.members = state.team.members.map((member) => ({
    ...member,
    runtime: member.runtime ? {
      ...member.runtime,
      status: 'offline',
      online: false,
      waiting: false,
      connectionPhase: 'cursor_stopped'
    } : member.runtime,
    readiness: 'offline'
  }))
}
if (offlineSessionsPreviewMode) {
  const template = state.desktop.sessions[0]!
  const existing = new Set(state.desktop.sessions.map((session) => session.channelId))
  state.desktop.sessions = [
    ...state.desktop.sessions,
    ...previewWorkspace.channelIds
      .filter((channelId) => !existing.has(channelId))
      .map((channelId) => ({
        ...template,
        id: `preview-channel-${channelId}`,
        channelId,
        displayName: `SG Team CH-${channelId}`,
        roleName: '未绑定外置团队'
      }))
  ].map((session) => ({
    ...session,
    status: 'offline',
    online: false,
    connected: false,
    waiting: false,
    queueDepth: 0
  }))
}
if (manualHandoffMode) {
  state.desktop.sessions = state.desktop.sessions.map((session, index) => ({
    ...session,
    status: index === 0 ? 'offline' : 'waiting',
    online: index !== 0,
    connected: index !== 0,
    waiting: index !== 0,
    queueDepth: 0
  }))
}
// 会话名册走查：?sessions=none（空态）| many（四个状态组齐全、需要滚动、含未绑定的备用通道）。
const sessionsScene = (['none', 'many'] as const).find((scene) => scene === previewParameters.get('sessions'))
if (sessionsScene === 'none') {
  state.desktop.sessions = []
  state.desktop.conversations = {}
} else if (sessionsScene === 'many') {
  const [lead, builder, solo] = state.desktop.sessions
  if (lead && builder && solo) {
    const variant = (
      base: typeof lead,
      channelId: string,
      patch: Partial<typeof lead>
    ): typeof lead => ({ ...base, ...patch, id: `preview-many-${channelId}`, channelId, queueDepth: patch.queueDepth ?? 0 })
    state.desktop.sessions = [
      lead,
      builder,
      variant(builder, '4', { displayName: '后端实现 · CH-4', roleName: '后端席', roleTemplateKey: 'backend', avatarId: 'devops', status: 'running', connectionPhase: 'processing', waiting: false, contextUsage: { used: 512_000, limit: 1_000_000, ratio: 0.512 }, changes: { additions: 42, deletions: 3, files: 2 }, modelName: 'GPT-5.6', executionProfile: undefined }),
      variant(lead, '5', { displayName: '质量验证 · CH-5', roleName: '验收席', roleTemplateKey: 'reviewer', avatarId: 'reviewer', isEffectiveLead: false, status: 'review', connectionPhase: 'processing', waiting: false, contextUsage: { used: 880_000, limit: 1_000_000, ratio: 0.88 }, changes: undefined, queueDepth: 1 }),
      variant(lead, '6', { displayName: '前端体验 · CH-6', roleName: '体验席', roleTemplateKey: 'frontend', avatarId: 'frontend', isEffectiveLead: false, status: 'blocked', connectionPhase: 'approval', waiting: false, contextUsage: { used: 210_000, limit: 1_000_000, ratio: 0.21 }, changes: { additions: 9, deletions: 1, files: 1 }, modelName: 'Kimi K3', executionProfile: undefined }),
      variant(lead, '7', { displayName: '研究分析 · CH-7', roleName: '研究席', roleTemplateKey: 'researcher', avatarId: 'researcher', isEffectiveLead: false, status: 'waiting', connectionPhase: 'keepalive', waiting: true, contextUsage: undefined, changes: undefined, modelName: 'Gemini 3.5 Pro', executionProfile: undefined }),
      solo,
      variant(solo, '8', { displayName: 'SG Team CH-8', roleName: '未绑定外置团队', roleTemplateKey: undefined, avatarId: undefined, status: 'offline', online: false, connected: false, waiting: false, contextUsage: undefined, lastSeenAt: previewNow - 3 * 60 * 60_000, queueDepth: 0, modelName: undefined, executionProfile: undefined })
    ]
  }
}
// 续作走查：?continuation=1 —— 会话交接后「已接手」已落库，Agent 没回 check_messages 而继续干活。
// 回复之下应出现续作行：已持久化的续作块在前、直播中的续作块在后（运行中 shell 贴底跟随）。
if (previewParameters.get('continuation') === '1') {
  const handoffAt = previewNow - 6 * 60_000
  const replyAt = previewNow - 5 * 60_000
  state.desktop.conversations = {
    ...state.desktop.conversations,
    '2': [
      {
        id: 'outbox:handoff-1', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
        timestamp: handoffAt, deliveredAt: handoffAt + 1_000,
        text: '【会话交接】来自 CH-1（独立席 1 · Claude Opus） · 2026-09-11 20:08\n\n请先阅读并接续下面的上下文，再处理后续消息：\n\n1. Cursor 会话转录（JSONL）：\n   /Users/lyr/.cursor/projects/Users-lyr-Downloads/agent-transcripts/3b51b5de/3b51b5de.jsonl'
      },
      {
        id: 'reply:handoff-1', channelId: '2', role: 'assistant', source: 'cursor', status: 'complete',
        timestamp: replyAt, replyToEntryId: 'outbox:handoff-1', turn: 'cursor:preview-native-turn:virtual:outbox:handoff-1',
        text: '已接手 CH-1 的上下文。我读到的最后一个任务：把拾光的过程流做成 Cursor 原生那样的块状结构——分组、Shell 独立卡、红绿 diff。当前处于阶段 A 尚未动工。',
        processBlocks: [
          { kind: 'tool', id: 'handoff-read-transcript', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: '3b51b5de.jsonl', hint: '191 行', status: 'done', startedAt: handoffAt + 5_000 },
          { kind: 'tool', id: 'handoff-read-record', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: 'CH-1-3b51b5de-20260911-200815.md', status: 'done', startedAt: handoffAt + 9_000 }
        ],
        continuationBlocks: [
          { kind: 'tool', id: 'cont-todo', toolName: 'todos', toolKind: 'todo', summary: '任务清单 0/4', status: 'done', startedAt: replyAt + 4_000,
            todos: [
              { content: '阶段 A：投影层分组', status: 'in_progress' },
              { content: '阶段 B：Shell 独立卡', status: 'pending' },
              { content: '阶段 C：头部降噪', status: 'pending' },
              { content: '阶段 D：红绿 diff', status: 'pending' }
            ] },
          { kind: 'tool', id: 'cont-read-1', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: 'src/renderer/src/process-turn-view.ts', hint: 'L1-120', status: 'done', startedAt: replyAt + 12_000 },
          { kind: 'tool', id: 'cont-read-2', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: 'src/renderer/src/ProcessTurnCard.tsx', hint: 'L360-520', status: 'done', startedAt: replyAt + 18_000 },
          { kind: 'tool', id: 'cont-read-3', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: 'src/domain/conversation-entry.ts', status: 'done', startedAt: replyAt + 25_000 },
          { kind: 'tool', id: 'cont-edit', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: 'src/renderer/src/process-step-groups.ts', hint: '+42 −0', status: 'done', startedAt: replyAt + 90_000,
            diff: { lines: [
              { type: 'hunk', text: '@@ -0,0 +1,6 @@' },
              { type: 'added', text: "export type ProcessGroupVariant = 'thought' | 'explore' | 'commands' | 'edits'", newLine: 1 },
              { type: 'added', text: 'export interface ProcessTurnGroup {', newLine: 2 },
              { type: 'added', text: "  kind: 'group'", newLine: 3 },
              { type: 'added', text: '  id: string', newLine: 4 },
              { type: 'added', text: '  steps: ProcessTurnStep[]', newLine: 5 },
              { type: 'added', text: '}', newLine: 6 }
            ] } }
        ]
      }
    ]
  }
  state.desktop.liveProcess = {
    '2': {
      turn: 'cursor:preview-native-turn',
      startedAt: handoffAt + 5_000,
      updatedAt: previewNow - 800,
      generating: true,
      blocks: [
        { kind: 'thinking', id: 'cont-live-think', text: '分组函数已经落地，跑一遍相关测试确认 identity 稳定，再把 compact 分支切到 items 渲染。', status: 'done', durationMs: 4_100, startedAt: previewNow - 40_000 },
        {
          kind: 'tool', id: 'cont-live-shell', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall',
          title: '运行分组相关测试', summary: 'npx vitest run tests/process-step-groups.test.ts tests/process-blocks.test.tsx', hint: 'npx',
          status: 'running', startedAt: previewNow - 12_000,
          input: { command: 'npx vitest run tests/process-step-groups.test.ts tests/process-blocks.test.tsx', description: '运行分组相关测试' },
          output: [' RUN  v4.1.11 /Users/lyr/Downloads/qingtian/qingtian-team', '', ' ✓ tests/process-step-groups.test.ts (17 tests) 41ms', ' · tests/process-blocks.test.tsx running…'].join('\n')
        }
      ]
    }
  }
  state.desktop.liveAgentResponses = undefined
  state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === '2'
    ? { ...session, status: 'running', connectionPhase: 'processing', waiting: true, online: true, deliveryMode: 'queued' }
    : session)
}
// 待投递托盘走查：?queued=1 —— Agent 正在处理上一条消息（过程流直播中），用户又发了两条：
// 它们不进时间线，停在输入区上方的托盘里（一条带「等待新会话」保持位；另有 1 条内部静默消息只计数）。
if (previewParameters.get('queued') === '1') {
  state.desktop.conversations = {
    ...state.desktop.conversations,
    '2': [
      // 基础夹具是直连口径（用户消息不带投递时刻）；切到队列传输后，历史消息按"已投递"补齐。
      ...(state.desktop.conversations['2'] ?? []).map((entry) => (
        entry.role === 'user' && entry.deliveredAt === undefined ? { ...entry, deliveredAt: entry.timestamp + 1_000 } : entry
      )),
      {
        id: 'outbox:queued-1', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
        timestamp: previewNow - 50_000,
        text: '顺手把托盘的暗色也走查一下，注意与输入区同宽、同圆角。'
      },
      {
        id: 'outbox:queued-2', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
        timestamp: previewNow - 12_000, heldForNextSession: true,
        text: '【会话交接】CH-2（架构实现 · CH-2） 上一段会话的上下文 · 2026-09-12 16:40\n\n你是该席位重建后的新会话。请先阅读并接续下面的上下文，再处理后续消息。',
        attachments: [{ id: 'queued-att-1', name: 'CH-2-handoff.md', mimeType: 'text/markdown', size: 2_048 }]
      }
    ]
  }
  state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === '2'
    ? { ...session, status: 'running', connectionPhase: 'processing', waiting: false, online: true, deliveryMode: 'queued', queueDepth: 3 }
    : session)
}
// 计划页长清单走查：?plan=long —— 真实颗粒度的 10 项技术任务：多行长文本、路径 token、
// 完成 / 进行中 / 待办 / 取消四态齐全，检验单行收拢、mono 渲染、分段进度与当前项示位。
if (previewParameters.get('plan') === 'long') {
  const live = state.desktop.liveProcess?.['2']
  if (live) {
    state.desktop.liveProcess = {
      ...state.desktop.liveProcess,
      '2': {
        ...live,
        blocks: live.blocks.map((block) => block.kind === 'tool' && block.toolKind === 'todo'
          ? {
              ...block,
              summary: '任务清单 2/10',
              todos: [
                { content: '恢复上下文：确认 5a 已完成步骤（围栏逐轮复核、bubbleCount、prepareComposerRelaunch allowIdleOnline）', status: 'completed' },
                { content: 'domain/seat-rotation.ts：设置类型/默认/归一化 + 纯决策函数 + 通知类型', status: 'in_progress' },
                { content: 'application/seat-rotation-settings-store.ts（userData/seat-rotation.json）', status: 'pending' },
                { content: 'application/seat-rotation-service.ts：订阅快照→待命计时→交接→轮换令牌→launch→通知/冷却/失败停用', status: 'pending' },
                { content: 'AgentSession.seatRotation 投影：DesktopSessionService.noteSeatRotation + 指纹 + run 切换清理', status: 'pending' },
                { content: 'IPC/preload/desktop-api：seatRotation get/save settings；主进程装配（index.ts）', status: 'pending' },
                { content: '渲染层：设置页「席位自动轮换」区块 + 名册卡轮换徽标/气泡数提示', status: 'pending' },
                { content: '旧版 usage 面板迁移（并入新会话页后不再需要）', status: 'cancelled' },
                { content: 'typecheck / vitest 全量 / knip / build / smoke:channel；ARCHITECTURE 追加记录', status: 'pending' },
                { content: '向用户汇报并 record_reply，回到 check_messages 待命', status: 'completed' }
              ]
            }
          : block)
      }
    }
  }
}
// 图片生成卡走查：?image=1 —— Agent 用 Cursor 图片生成工具出图：一张已完成（缩略图内联在头部之下）、
// 一张进行中（只有头部动词与状态）。浏览器预览没有 sg-image 协议，夹具以 data: URL 代替本地路径
//（渲染层同一解析入口 resolveMessageImageSource）；真实块的 image.path 是生成文件的绝对路径。
if (previewParameters.get('image') === '1') {
  const boardSvg = (letters: string, tile: string): string => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" rx="28" fill="#f2f2f2"/><rect x="200" y="40" width="240" height="240" rx="54" fill="${tile}"/><text x="320" y="212" font-family="-apple-system, Helvetica, sans-serif" font-size="150" font-weight="700" text-anchor="middle" fill="#ff6b35">${letters}</text><text x="320" y="352" font-family="-apple-system, Helvetica, sans-serif" font-size="22" text-anchor="middle" fill="#777">preview fixture</text></svg>`
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
  }
  const live = state.desktop.liveProcess?.['2']
  if (live) {
    state.desktop.liveProcess = {
      ...state.desktop.liveProcess,
      '2': {
        ...live,
        blocks: [
          ...live.blocks,
          {
            kind: 'tool', id: 'live-image-done', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall',
            summary: 'shiguang-sg-v1-charcoal-orange.png', status: 'done',
            startedAt: previewNow - 64_000, completedAt: previewNow - 40_000, timingEstimated: true,
            input: { description: 'Design board for a macOS app icon: charcoal squircle, lowercase "sg" in a warm orange gradient.', filePath: 'shiguang-sg-v1-charcoal-orange.png' },
            image: { path: boardSvg('sg', '#141416') }
          },
          {
            kind: 'tool', id: 'live-image-running', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall',
            summary: 'shiguang-sg-v2-cream-orange.png', status: 'running',
            startedAt: previewNow - 18_000, timingEstimated: true,
            input: { description: 'Same board on a warm cream tile.', filePath: 'shiguang-sg-v2-cream-orange.png' }
          }
        ]
      }
    }
  }
}
// 名册常驻状态行走查：?railactivity=1（搭配 sessions=many）—— 复刻 Cursor 会话列表副标题的全部形态同台：
// 工具动词 + 对象（Cursor 侧事实 / 过程块回退两条路）、正文首行片段、To-Dos 进度、待命席位的 Thinking、
// Awaiting approval、离线 Completed，以及 Cursor 一个都没扫到时的兜底 Planning next moves（第 9 席，仅本场景）。
// `long` 变体给对象一个极长文件名，走查明细省略。
if (['1', 'long'].includes(previewParameters.get('railactivity') ?? '')) {
  const long = previewParameters.get('railactivity') === 'long'
  const activity = (id: string, blocks: LiveProcessState['blocks'], generating = true): LiveProcessState => ({
    turn: `cursor:preview-rail-activity:${id}`,
    startedAt: previewNow - 90_000,
    updatedAt: previewNow - 600,
    generating,
    blocks
  })
  const cursorLine = (id: string, statusLine: LiveStatusLineState['statusLine'], generating = true): LiveStatusLineState => ({
    composerId: `preview-composer-${id}`, generating, composerStatus: generating ? 'generating' : 'completed', statusLine, updatedAt: previewNow - 400
  })
  const longName = `${'session-rail-view-with-a-very-long-name-'.repeat(long ? 4 : 0)}session-rail-view.ts`
  // 基础夹具里 CH-2 有一段流式正文；它是最新气泡，会压过读取中的工具——这里只走查工具回退路。
  state.desktop.liveAgentResponses = undefined
  // 过程块回退路（旧 hook 帧）：读取中的工具 → Reading + basename。
  state.desktop.liveProcess = {
    ...(state.desktop.liveProcess ?? {}),
    '2': activity('2', [
      { kind: 'tool', id: 'rail-act-grep', toolName: 'grep_v2', toolKind: 'search', toolCase: 'grepToolCall', summary: 'sessionRailActivity', status: 'done', startedAt: previewNow - 30_000 },
      { kind: 'tool', id: 'rail-act-read', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: `src/renderer/src/${longName}`, status: 'running', startedAt: previewNow - 8_000 }
    ]),
    '5': activity('5', [{
      kind: 'tool', id: 'rail-act-question', toolName: 'ask_question', toolKind: 'question', toolCase: 'askQuestionToolCall', status: 'running', startedAt: previewNow - 20_000,
      question: { toolCallId: 'tc-rail-1', title: '状态行放在状态行下方还是上方？', status: 'pending', questions: [] }
    }], false)
  }
  // Cursor 侧事实路（hook v32 帧）：与 Cursor 自己的侧栏同一算法给出的副标题。
  state.desktop.liveStatusLine = {
    '1': cursorLine('1', { kind: 'tool', label: `Grepping sessionRailActivity in src/ (${long ? '**/*.{ts,tsx,css,md,mjs}' : '*.ts'})`, detail: `sessionRailActivity in src/ (${long ? '**/*.{ts,tsx,css,md,mjs}' : '*.ts'})`, toolKind: 'search' }),
    '3': cursorLine('3', { kind: 'text', label: 'I dug into the Cursor 3.6.31 bundle and probed the…' }),
    '4': cursorLine('4', { kind: 'tool', label: 'Editing SessionRailCard.tsx', detail: 'SessionRailCard.tsx', toolKind: 'edit' }),
    '6': cursorLine('6', { kind: 'todos', label: '3/7 To-Dos Completed', toolKind: 'todo' }),
    // 待命席位（check_messages 长轮询）：MCP 无详情被跳过，扫到轮询前那段 keepalive 思考 → Thinking。
    '7': cursorLine('7', { kind: 'thinking', label: 'Thinking' }),
    // 回合存活但 Cursor 一个都没扫到（刚开始生成 / 连续无详情工具）：它自己的兜底原话。
    '9': cursorLine('9', undefined)
  }
  const planningBase = state.desktop.sessions.find((session) => session.channelId === '4')
  if (planningBase) {
    state.desktop.sessions = [...state.desktop.sessions, {
      ...planningBase, id: 'preview-many-9', channelId: '9', displayName: '数据接入 · CH-9', roleName: '数据席', avatarId: 'architect',
      contextUsage: { used: 96_000, limit: 1_000_000, ratio: 0.096 }, changes: undefined, queueDepth: 0, modelName: 'Fable 5'
    }]
  }
  state.desktop.sessions = state.desktop.sessions.map((session) => ['1', '2', '3', '4', '5', '9'].includes(session.channelId)
    ? { ...session, status: 'running', connectionPhase: 'processing', waiting: false, online: true, awaitingUser: session.channelId === '5' }
    : session)
}
// 统计页走查：?stats=1 —— 三个在册席位 + 两个历史 Composer，账本铺满 30 天，
// 小时（今天）与天（7/30 天）两种分桶、四桶构成、多模型分布、历史归属一次看全。
const statsPreviewMode = previewParameters.has('stats')
if (statsPreviewMode) {
  state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === '3'
    ? { ...session, composerId: 'composer-03' }
    : session)
}

function previewStatsTurn(at: number, modelId: string, scale: number): UsageTurn {
  const price = priceForModel(modelId)
  const cacheReadTokens = Math.round(31_000 * scale)
  const cacheWriteTokens = Math.round(2_400 * scale)
  const fresh = Math.round(80 * scale)
  const outputTokens = Math.round(760 * scale)
  const counts = { inputTokens: cacheReadTokens + cacheWriteTokens + fresh, outputTokens, cacheReadTokens, cacheWriteTokens }
  return { ...counts, estimatedCostUsd: estimateTurnCostUsd({ ...counts, occurredAt: at }, price), price, exact: true, at }
}

function previewStatsUsage(): CursorUsageSnapshot {
  const hour = 3_600_000
  // [composerId, 模型, 回合的「几小时前」序列]：近端密（今天有小时节奏）、远端疏（30 天有形状）。
  const composers: Array<[string, string, number[]]> = [
    ['composer-01', 'claude-fable-5', [0.4, 1.3, 2.6, 3.2, 4.7, 6.3, 7.9, 9.4, 25, 29, 49, 74, 97, 121, 168, 240, 380, 520, 700]],
    ['composer-02', 'claude-fable-5', [0.8, 1.9, 3.5, 5.2, 8.3, 24, 48, 72, 120, 170, 238, 312, 430, 560]],
    ['composer-03', 'gpt-5-6-sol', [1.1, 2.3, 6.5, 26, 50, 95, 144, 199, 300]],
    ['hist-4f2a9c1e', 'claude-fable-5-1', [128, 250, 405, 552, 640]],
    ['hist-b83d07aa', 'composer-2-5-fast', [88, 295, 630]]
  ]
  return Object.fromEntries(composers.map(([composerId, modelId, hoursAgo]) => {
    const turns = Object.fromEntries(hoursAgo.map((back, index) => [
      `gen-${composerId}-${index}`,
      previewStatsTurn(previewNow - Math.round(back * hour), modelId, 0.55 + ((index * 7) % 9) * 0.45)
    ]))
    return [composerId, projectUsage(composerId, { turns })]
  }))
}

const previewTasks = structuredClone(taskPoolSnapshot)
if (previewRunStatus === 'completed') {
  for (const task of Object.values(previewTasks.tasks)) {
    if (!['done', 'failed', 'cancelled'].includes(task.status)) {
      task.status = 'cancelled'
      task.failureReason = '本轮全部 Agent 已离线，未完成任务自动取消'
    }
  }
  for (const attempt of Object.values(previewTasks.attempts)) {
    if (['leased', 'running', 'review'].includes(attempt.status)) attempt.status = 'cancelled'
  }
  for (const review of Object.values(previewTasks.reviews)) {
    if (review.status === 'queued' || review.status === 'leased') review.status = 'cancelled'
  }
}
const desktopListeners = new Set<Listener<typeof state.desktop>>()
const memoryListeners = new Set<Listener<typeof state.memory>>()
const teamListeners = new Set<Listener<typeof state.team>>()
let previewCursorAccounts: Array<{
  id: string; label: string; maskedToken: string; active: boolean; createdAt: number; updatedAt: number
  fingerprintProfileId?: string
  email?: string
  hasCredentials?: boolean
}> = [
  // 首个账号预置窗口绑定 + 卡号凭据：预览同时覆盖「已绑定 / 跟随默认」与「可自动登录 / 仅 Token」两种行形态
  { id: 'preview-acc-1', label: 'work@example.com', maskedToken: '••••9f2k', active: true, createdAt: previewNow - 40 * 60_000, updatedAt: previewNow - 5 * 60_000, fingerprintProfileId: 'bit-proxy', email: 'work@example.com', hasCredentials: true },
  { id: 'preview-acc-2', label: 'spare@example.com', maskedToken: '••••41qz', active: false, createdAt: previewNow - 90 * 60_000, updatedAt: previewNow - 30 * 60_000 }
]

/**
 * 存储清理走查：?cleanup=running（默认，Cursor 运行中，需退出的项被阻断）| closed（全部可清）| empty。
 * 数字取自 2026-09-12 一台真实机器的盘点（22GB 聊天库 / 16GB 快照 / 78 个工作区里 20 个失效）。
 */
const previewCleanupScene = previewParameters.get('cleanup') ?? 'running'
function previewStorageScan(olderThanDays = 90): CursorStorageScan {
  const GB = 1024 ** 3
  const MB = 1024 ** 2
  const candidateCount = olderThanDays === 30 ? 796 : olderThanDays === 90 ? 298 : 121
  const candidateBytes = olderThanDays === 30 ? 12.9 * GB : olderThanDays === 90 ? 5.4 * GB : 2.1 * GB
  if (previewCleanupScene === 'empty') {
    return {
      scannedAt: previewNow, userDataRoot: '/Users/demo/Library/Application Support/Cursor', cursorRunning: false,
      entries: [
        { id: 'chat-history', bytes: 0, count: 0, note: `数据库 1.2 GB · 64 个会话 · 没有 ${olderThanDays} 天前的会话`, cleanable: false },
        { id: 'snapshots', bytes: 0, count: 0, cleanable: false },
        { id: 'local-history', bytes: 0, count: 0, cleanable: false },
        { id: 'orphan-workspaces', bytes: 0, count: 0, note: '每个工作区的文件夹都还在', cleanable: false },
        { id: 'stale-backups', bytes: 0, count: 0, cleanable: false },
        { id: 'caches', bytes: 0, count: 0, cleanable: false },
        { id: 'logs', bytes: 0, count: 0, cleanable: false },
        { id: 'legacy-patch', bytes: 0, count: 0, note: '未检测到', cleanable: false }
      ],
      chatHistory: { databasePath: '/Users/demo/Library/Application Support/Cursor/User/globalStorage/state.vscdb', fileBytes: 1.2 * GB, sidecarBytes: 0, composerCount: 64, indexedCount: 64, bubbleCount: 12_000, candidateCount: 0, candidateBytesEstimate: 0, protectedCount: 0, specialCount: 0, olderThanDays, freeDiskBytes: 120 * GB, compactable: true },
      legacyPatch: { detected: false, markers: [] },
      totalBytes: 0
    }
  }
  return {
    scannedAt: previewNow,
    userDataRoot: '/Users/demo/Library/Application Support/Cursor',
    cursorRunning: previewCleanupScene === 'closed' ? false : true,
    entries: [
      { id: 'chat-history', bytes: candidateBytes, count: candidateCount, note: `数据库 20.9 GB · 1321 个会话 · ${olderThanDays} 天前的 ${candidateCount} 个可清理 · 6 个受拾光保护 · 3 个项目 / 规格 / 子会话不清理`, cleanable: true },
      { id: 'snapshots', bytes: 16.1 * GB, count: 48_211, note: '48211 个文件', cleanable: true },
      { id: 'local-history', bytes: 208 * MB, count: 3_940, note: '3940 个历史版本', cleanable: true },
      { id: 'orphan-workspaces', bytes: 1.02 * GB, count: 20, note: '20 个文件夹已不存在', cleanable: true },
      { id: 'stale-backups', bytes: 1.56 * GB, count: 2, note: 'state.vscdb.backup、state.vscdb.bak', cleanable: true },
      { id: 'caches', bytes: 146 * MB, count: 1_204, note: '1204 个文件', cleanable: true },
      { id: 'logs', bytes: 28 * MB, count: 612, note: '612 个文件', cleanable: true },
      { id: 'legacy-patch', bytes: 243_503, count: 1, note: '__QINGTIAN_SEAMLESS__ · __QINGTIAN_COMPOSER_BRIDGE_V2__', cleanable: false }
    ],
    chatHistory: {
      databasePath: '/Users/demo/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
      fileBytes: 20.9 * GB, sidecarBytes: 5.6 * MB, composerCount: 1922, indexedCount: 1321, bubbleCount: 1_088_294,
      candidateCount, candidateBytesEstimate: candidateBytes, protectedCount: 6, specialCount: 3, olderThanDays, freeDiskBytes: 21 * GB, compactable: false
    },
    legacyPatch: { detected: true, bundlePath: '/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js', bytes: 243_503, markers: ['__QINGTIAN_SEAMLESS__', '__QINGTIAN_COMPOSER_BRIDGE_V2__'] },
    totalBytes: candidateBytes + 16.1 * GB + 208 * MB + 1.02 * GB + 1.56 * GB + 146 * MB + 28 * MB
  }
}

function pushDesktop(): void {
  state.desktop = { ...state.desktop, updatedAt: Date.now() }
  for (const listener of desktopListeners) listener(structuredClone(state.desktop))
}

function pushMemory(): void {
  state.memory = { ...state.memory, revision: state.memory.revision + 1, updatedAt: Date.now() }
  for (const listener of memoryListeners) listener(structuredClone(state.memory))
}

function pushTeam(): void {
  for (const listener of teamListeners) listener(structuredClone(state.team))
}

const api: SgDesktopApi = {
  listCursorAccounts: async () => structuredClone(previewCursorAccounts),
  saveCursorAccount: async ({ label, token }) => {
    const at = Date.now()
    previewCursorAccounts = previewCursorAccounts.map((account) => ({ ...account, active: false }))
    previewCursorAccounts.push({
      id: `preview-cursor-account-${at}`,
      label: label.trim(),
      maskedToken: `••••${token.trim().slice(-4)}`,
      active: true,
      createdAt: at,
      updatedAt: at
    })
    return structuredClone(previewCursorAccounts)
  },
  saveCursorAccountCard: async ({ card }) => {
    // 与主进程同一领域解析：预览所见即真实入库结果
    const parsed = parseCursorAccountCard(card)
    const at = Date.now()
    const existing = parsed.sub
      ? previewCursorAccounts.find((account) => account.label === parsed.email)
      : undefined
    if (existing) {
      previewCursorAccounts = previewCursorAccounts.map((account) => ({
        ...account,
        active: account.id === existing.id,
        ...(account.id === existing.id
          ? { maskedToken: `••••${parsed.token.slice(-4)}`, updatedAt: at, hasCredentials: true }
          : {})
      }))
      return { accounts: structuredClone(previewCursorAccounts), outcome: 'updated' as const, accountId: existing.id, label: existing.label }
    }
    previewCursorAccounts = previewCursorAccounts.map((account) => ({ ...account, active: false }))
    const created = {
      id: `preview-cursor-account-${at}`,
      label: parsed.label,
      maskedToken: `••••${parsed.token.slice(-4)}`,
      active: true,
      createdAt: at,
      updatedAt: at,
      email: parsed.email,
      hasCredentials: true
    }
    previewCursorAccounts.push(created)
    return { accounts: structuredClone(previewCursorAccounts), outcome: 'created' as const, accountId: created.id, label: created.label }
  },
  loginCursorAccount: async (accountId) => {
    const at = Date.now()
    previewCursorAccounts = previewCursorAccounts.map((account) => (
      account.id === accountId ? { ...account, maskedToken: '••••rfrsh', updatedAt: at } : account
    ))
    return { accounts: structuredClone(previewCursorAccounts), outcome: 'logged_in' as const }
  },
  // 预览停在提交前闸门（verified）：预览环境绝不模拟「已提交待付款」。
  startCursorProUpgrade: async () => ({
    outcome: 'verified' as const,
    detail: '账单资料已填写并复核通过；按测试闸门停在提交前（未生成付款二维码）'
  }),
  selectCursorAccount: async (accountId) => {
    previewCursorAccounts = previewCursorAccounts.map((account) => ({ ...account, active: account.id === accountId }))
    return structuredClone(previewCursorAccounts)
  },
  removeCursorAccount: async (accountId) => {
    const wasActive = previewCursorAccounts.find((account) => account.id === accountId)?.active
    previewCursorAccounts = previewCursorAccounts.filter((account) => account.id !== accountId)
    if (wasActive && previewCursorAccounts[0]) previewCursorAccounts[0].active = true
    return structuredClone(previewCursorAccounts)
  },
  setCursorAccountFingerprintProfile: async (accountId, profileId) => {
    previewCursorAccounts = previewCursorAccounts.map((account) => (
      account.id === accountId ? { ...account, fingerprintProfileId: profileId } : account
    ))
    return structuredClone(previewCursorAccounts)
  },
  importCursorAccountFromLocalCursor: async () => {
    return api.saveCursorAccount({
      label: 'preview@example.com（本机 Cursor）',
      token: 'preview-local-cursor-token'
    })
  },
  importCursorAccountFromBrowser: async () => {
    return api.saveCursorAccount({
      label: 'user_preview_0001（Microsoft Edge）',
      token: 'user_preview_0001::preview-browser-token'
    })
  },
  restartCursorWithAccount: async () => ({
    switched: true,
    killedCursor: true,
    relaunchMode: 'cdp' as const,
    cdpPortReady: true,
    machineIdentityApplied: true,
    runtimeVerified: true,
    backupDir: `/backup/account-switch-${Date.now()}`
  }),
  verifyCursorRuntimeAccount: async () => ({ status: 'matched' as const, cursorLabel: 'preview@cursor.com', activeLabel: 'preview@cursor.com' }),
  switchCursorAccountLive: async () => ({ switched: true }),
  getCursorSwitchPumpStatus: async () => pumpScene === 'external'
    ? ({
        kind: 'installed' as const, managed: false,
        config: { port: 51824, key: 'preview', revision: 2 },
        message: '检测到兼容切号补丁（端口 51824，由其他工具管理）'
      })
    : pumpScene === 'missing'
      ? ({ kind: 'not-installed' as const, message: '切号补丁未安装' })
      : ({
          kind: 'installed' as const, managed: true,
          config: { port: 51824, key: 'preview', revision: 1 },
          message: '拾光切号补丁已安装（端口 51824）'
        }),
  ensureCursorSwitchPump: async () => ({ ok: true, changed: false, message: '切号补丁已是当前配置' }),
  removeCursorSwitchPump: async () => ({ ok: true, changed: true, message: '切号补丁已卸载，重启 Cursor 生效。' }),
  refreshCursorMembership: async () => ({ state: 'ok' as const, profile: { tier: 'pro' as const, raw: 'pro', trialEligible: false, isTeamMember: false, lastPaymentFailed: false, fetchedAt: Date.now() } }),
  refreshCursorAccountMemberships: async (accountIds) => Object.fromEntries(
    previewCursorAccounts
      .filter((account) => !accountIds || accountIds.includes(account.id))
      .map((account, index) => [account.id, {
        state: 'ok' as const,
        profile: { tier: index === 0 ? 'free' as const : 'pro' as const, raw: index === 0 ? 'free' : 'pro', fetchedAt: Date.now() }
      }])
  ),
  getAozaiCardStatus: async () => automationSceneRun
    ? { saved: true, maskedCode: '••••6l8Q', type: '50次卡', remaining: 46 }
    : { saved: false },
  saveAozaiCard: async () => ({ saved: true, maskedCode: '••••6l8Q', type: '50次卡', remaining: 46 }),
  clearAozaiCard: async () => ({ saved: false }),
  refreshAozaiBalance: async () => ({ saved: true, maskedCode: '••••6l8Q', type: '50次卡', remaining: 46 }),
  processAozaiAccount: async () => ({ ok: true, message: '处理成功', remaining: 45 }),
  processAozaiToken: async () => ({ ok: true, message: '处理成功', remaining: 45 }),
  onAozaiProgress: () => () => {},
  launchAgentSessions: async (requests) => ({
    id: 'preview-launch',
    state: 'done',
    items: requests.map((request) => ({
      channelId: request.channelId,
      modelSelection: request.modelSelection,
      stage: 'done' as const,
      message: '会话已就绪',
      composerId: `preview-composer-${request.channelId}`
    })),
    startedAt: Date.now(),
    finishedAt: Date.now()
  }),
  getAgentLaunchPlan: async () => undefined,
  onAgentLaunchProgress: () => () => {},
  // 会话预热走查场景：?warmup=running|done|slow|failed|no-model
  runSessionWarmup: async () => previewWarmupRun ?? { phase: 'done' as const, message: '预热通过 · GPT-5.6 Luna · 1.8s', modelLabel: 'GPT-5.6 Luna', startedAt: previewNow - 1_800, finishedAt: previewNow, durationMs: 1_800 },
  getSessionWarmupRun: async () => previewWarmupRun,
  onSessionWarmupProgress: () => () => {},
  enableCursorCdp: async () => ({ ok: true, message: 'Cursor 已重启并启用会话创建端口（9333）' }),
  getCursorCdpSettings: async () => ({ autoHealEnabled: false }),
  saveCursorCdpSettings: async (settings) => settings,
  getSeatRotationSettings: async () => ({ enabled: true, bubbleThreshold: 400 }),
  saveSeatRotationSettings: async (settings) => settings,
  getCursorUpdatePreferences: async () => ({
    settingsPath: '/Users/demo/Library/Application Support/Cursor/User/settings.json',
    updateMode: undefined,
    autoUpdateDisabled: false,
    settingsExists: true
  }),
  setCursorAutoUpdateDisabled: async (disabled) => ({
    settingsPath: '/Users/demo/Library/Application Support/Cursor/User/settings.json',
    updateMode: disabled ? 'none' : undefined,
    autoUpdateDisabled: disabled,
    settingsExists: true,
    changed: true
  }),
  scanCursorStorage: async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    return previewStorageScan(input?.chatHistoryOlderThanDays)
  },
  cleanCursorStorage: async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 900))
    const scan = previewStorageScan(request.chatHistoryOlderThanDays)
    const plan = buildCleanupPlan(scan, request)
    const after: CursorStorageScan = {
      ...scan,
      entries: scan.entries.map((entry) => plan.runnable.includes(entry.id) ? { ...entry, bytes: 0, count: 0, cleanable: false, note: undefined } : entry),
      totalBytes: scan.entries.filter((entry) => entry.cleanable && !plan.runnable.includes(entry.id) && entry.id !== 'legacy-patch').reduce((sum, entry) => sum + entry.bytes, 0)
    }
    return {
      ok: plan.runnable.length > 0,
      freedBytes: plan.totalBytes,
      done: plan.runnable,
      skipped: plan.blocked,
      message: plan.runnable.length
        ? `已清理 ${plan.runnable.map((id) => CURSOR_STORAGE_CATALOG.find((spec) => spec.id === id)?.label ?? id).join('、')}，释放约 ${formatFileSize(plan.totalBytes)}`
        : `未清理：${plan.blocked[0]?.reason ?? '没有可执行的项'}`,
      scan: after
    }
  },
  revealCursorStorage: async () => {},
  cancelCdpAutoHealCountdown: async () => {},
  onCdpAutoHealEvent: () => () => {},
  getAccountAutomationSettings: async () => ({ enabled: Boolean(automationSceneRun), delaySec: 10, postProcessDelaySec: 10 }),
  saveAccountAutomationSettings: async (settings) => settings,
  getAccountAutomationRun: async () => automationSceneRun ?? { phase: 'idle' as const, message: '', startedAt: 0 },
  cancelAccountAutomation: async () => ({ phase: 'cancelled' as const, message: '已取消本次自动化', startedAt: 0, finishedAt: Date.now() }),
  listAccountAutomationBitProfiles: async () => ({
    ok: true,
    profiles: [
      { id: 'bit-proxy', name: '代理', seq: 1 },
      { id: 'bit-direct', name: '直连', seq: 2 }
    ]
  }),
  getAccountAutomationRoxyApiKey: async () => ({ saved: true, maskedKey: '6192****eada' }),
  saveAccountAutomationRoxyApiKey: async () => ({ saved: true, maskedKey: '6192****eada' }),
  importCursorAccountFromFingerprint: async () => {
    const imported = await api.saveCursorAccount({
      label: 'user_preview_0001（Roxy指纹）',
      token: 'user_preview_0001::preview-fingerprint-token'
    })
    // 导入即绑定：新账号固定到读取它的窗口（预览固定为「代理」窗口）
    const created = imported.find((account) => account.label.includes('Roxy指纹'))
    if (created) return api.setCursorAccountFingerprintProfile(created.id, 'bit-proxy')
    return imported
  },
  openFingerprintLoginPage: async () => {},
  cleanupFingerprintEnvironment: async () => {},
  acknowledgeCursorModelDataPolicies: async () => ({
    changed: false,
    tokenUpdated: false,
    modelIds: ['claude-fable-5'],
    message: 'claude-fable-5 的数据政策已确认，无需重复提交'
  }),
  onAccountAutomationProgress: () => () => {},
  getSnapshot: async () => structuredClone(state.desktop),
  sendMessage: async ({ channelId, text }) => {
    const entry: ConversationEntry = {
      id: `outbox:preview-${Date.now()}`,
      channelId,
      role: 'user',
      text,
      timestamp: Date.now(),
      status: 'complete',
      source: 'desktop'
    }
    state.desktop.conversations = {
      ...state.desktop.conversations,
      [channelId]: [...(state.desktop.conversations[channelId] ?? []), entry]
    }
    const session = state.desktop.sessions.find((candidate) => candidate.channelId === channelId)
    const bumpDepth = (delta: number): void => {
      state.desktop.sessions = state.desktop.sessions.map((candidate) => candidate.channelId === channelId
        ? { ...candidate, queueDepth: Math.max(0, candidate.queueDepth + delta) }
        : candidate)
    }
    bumpDepth(1)
    pushDesktop()
    // 模拟真实投递：Agent 待命时 check_messages 约 1s 内取走（消息从托盘移入时间线）；
    // 正在处理 / 离线时留在托盘，直到预览里手动撤回。
    if (session?.deliveryMode === 'queued' && session.online && session.waiting) {
      setTimeout(() => {
        const entries = state.desktop.conversations[channelId] ?? []
        if (!entries.some((candidate) => candidate.id === entry.id && candidate.deliveredAt === undefined)) return
        state.desktop.conversations = {
          ...state.desktop.conversations,
          [channelId]: entries.map((candidate) => candidate.id === entry.id ? { ...candidate, deliveredAt: Date.now() } : candidate)
        }
        bumpDepth(-1)
        pushDesktop()
      }, 900)
    }
    return { commandId: entry.id }
  },
  withdrawQueuedMessage: async ({ channelId, entryId }) => {
    const entries = state.desktop.conversations[channelId] ?? []
    if (!entries.some((entry) => entry.id === entryId && entry.deliveredAt === undefined)) return false
    state.desktop.conversations = {
      ...state.desktop.conversations,
      [channelId]: entries.filter((entry) => entry.id !== entryId)
    }
    state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === channelId
      ? { ...session, queueDepth: Math.max(0, session.queueDepth - 1) }
      : session)
    pushDesktop()
    return true
  },
  releaseQueuedMessage: async ({ channelId, entryId }) => {
    const entries = state.desktop.conversations[channelId] ?? []
    if (!entries.some((entry) => entry.id === entryId && entry.heldForNextSession)) return false
    state.desktop.conversations = {
      ...state.desktop.conversations,
      [channelId]: entries.map((entry) => entry.id === entryId ? { ...entry, heldForNextSession: undefined } : entry)
    }
    pushDesktop()
    return true
  },
  answerCursorQuestion: async ({ channelId, toolCallId, selections, freeformTexts, note }) => {
    const live = state.desktop.liveProcess?.[channelId]
    if (!live) return { ok: false, code: 'question_not_pending', message: '预览：该通道没有进行中的提问' }
    state.desktop.liveProcess = {
      ...state.desktop.liveProcess,
      [channelId]: {
        ...live,
        updatedAt: Date.now(),
        blocks: live.blocks.map((block) => block.kind === 'tool' && block.question?.toolCallId === toolCallId
          ? {
              ...block,
              status: 'done',
              question: {
                ...block.question,
                status: 'submitted',
                note: note?.trim() || undefined,
                answers: block.question.questions.map((item) => ({
                  questionId: item.id,
                  selectedOptionIds: (selections[item.id] ?? []).filter((id) => id !== '__freeform_other__'),
                  ...(freeformTexts?.[item.id] ? { freeformText: freeformTexts[item.id] } : {})
                }))
              }
            }
          : block)
      }
    }
    pushDesktop()
    return { ok: true, status: 'submitted' }
  },
  skipCursorQuestion: async ({ channelId, toolCallId }) => {
    const live = state.desktop.liveProcess?.[channelId]
    if (!live) return { ok: false, code: 'question_not_pending', message: '预览：该通道没有进行中的提问' }
    state.desktop.liveProcess = {
      ...state.desktop.liveProcess,
      [channelId]: {
        ...live,
        updatedAt: Date.now(),
        blocks: live.blocks.map((block) => block.kind === 'tool' && block.question?.toolCallId === toolCallId
          ? { ...block, status: 'done', question: { ...block.question, status: 'cancelled', skipReason: 'user' } }
          : block)
      }
    }
    pushDesktop()
    return { ok: true, status: 'cancelled' }
  },
  getSessionHandoffContext: async ({ channelId }) => {
    const session = state.desktop.sessions.find((candidate) => candidate.channelId === channelId)
    const entries = state.desktop.conversations[channelId] ?? []
    const composerId = session?.composerId ?? 'preview-composer-0000'
    return {
      channelId,
      displayName: session?.displayName ?? `CH-${channelId}`,
      composerId,
      modelName: session?.executionProfile?.displayName ?? session?.modelName,
      transcript: {
        path: `/Users/preview/.cursor/projects/Users-preview-workspace/agent-transcripts/${composerId}/${composerId}.jsonl`,
        exists: true,
        sizeBytes: 347_478,
        modifiedAt: Date.now() - 42 * 60_000,
        recordCount: 191,
        resolution: 'workspace'
      },
      holdSupported: true,
      userMessageCount: entries.filter((entry) => entry.role === 'user').length,
      assistantMessageCount: entries.filter((entry) => entry.role === 'assistant').length,
      firstMessageAt: entries[0]?.timestamp,
      lastMessageAt: entries.at(-1)?.timestamp
    }
  },
  deliverSessionHandoff: async ({ sourceChannelId, target, note }) => {
    const targetChannelId = target.kind === 'self' ? sourceChannelId : target.channelId
    const held = target.kind === 'self'
    const entry: ConversationEntry = {
      id: `outbox:preview-handoff-${Date.now()}`,
      channelId: targetChannelId,
      role: 'user',
      text: `【会话交接】来自 CH-${sourceChannelId}${note ? `\n\n交接说明：${note}` : ''}`,
      timestamp: Date.now(),
      status: 'complete',
      source: 'desktop',
      heldForNextSession: held ? true : undefined
    }
    state.desktop.conversations = {
      ...state.desktop.conversations,
      [targetChannelId]: [...(state.desktop.conversations[targetChannelId] ?? []), entry]
    }
    pushDesktop()
    return {
      targetChannelId,
      held,
      transcriptPath: '/Users/preview/.cursor/projects/Users-preview-workspace/agent-transcripts/preview/preview.jsonl',
      recordPath: '/Users/preview/Library/Application Support/sg-team/handoff/CH-1-preview-20260904-200000.md',
      commandId: entry.id,
      issuedAt: entry.timestamp
    }
  },
  revealPathInFolder: async () => true,
  copyImageToClipboard: async () => true,
  saveImageAs: async () => true,
  getTaskPoolSnapshot: async () => structuredClone(previewTasks),
  installTaskMcp: async () => ({
    workspacePath: previewWorkspace.workspacePath,
    workspaceId: previewWorkspace.workspaceId,
    runId: state.team.activeRun?.id ?? 'preview-run',
    serverNames: ['SG Team']
  }),
  getTeamControlSnapshot: async () => structuredClone(state.team),
  detectCursorWorkspace: async () => ({
    state: 'detected',
    workspace: {
      id: previewWorkspace.workspaceId,
      name: previewWorkspace.workspaceName,
      path: previewWorkspace.workspacePath,
      cursorWorkspaceId: 'preview-cursor-workspace'
    },
    candidates: [],
    detail: '预览中的 Cursor 工作区',
    observedAt: Date.now()
  }),
  createIndependentSessions: async (input) => {
    const configured = createConfiguredTeamBundle({
      workspaceId: previewWorkspace.workspaceId,
      workspaceName: previewWorkspace.workspaceName,
      workspacePath: input.workspacePath,
      mode: 'independent',
      now: Date.now(),
      members: input.sessions.map((session, index) => ({
        channelId: String(index + 1), roleTemplateKey: 'solo', avatarId: AGENT_AVATAR_IDS[(index + 5) % AGENT_AVATAR_IDS.length]!,
        skills: [], solo: true, modelSelection: session.modelSelection
      }))
    })
    const bindings = configured.slots.map((slot) => ({
      id: `preview-independent-binding-${slot.channelId}`, workspaceId: configured.workspace.id, runId: configured.run.id,
      slotId: slot.id, channelId: slot.channelId!, agentSessionId: `preview-independent:ch-${slot.channelId}:g1`,
      generation: 'g1', installedAt: Date.now(), launchStatus: 'not_started' as const,
      launchDetail: '', lastCheckInNote: '', composerBindingKey: `preview-independent-${slot.channelId}`
    }))
    const members = configured.slots.map((slot, index) => ({
      slot,
      role: configured.roles[index]!,
      binding: bindings[index],
      runtime: undefined,
      readiness: 'offline' as const
    }))
    state.team = {
      ...emptyTeamControlSnapshot(), revision: state.team.revision + 1,
      activeWorkspaceId: configured.workspace.id, workspaces: [configured.workspace], runs: [configured.run],
      roles: configured.roles, slots: configured.slots, bindings, activeRun: configured.run, members,
      runtimeChannels: bindings.map((binding) => ({
        channelId: binding.channelId, displayName: `SG Team CH-${binding.channelId}`, status: 'offline' as const,
        online: false, waiting: false, queueDepth: 0, registered: true, assignedSlotId: binding.slotId,
        agentSessionId: binding.agentSessionId, generation: binding.generation
      })),
      preflight: {
        bridgeConnected: true, workspaceBound: true, goalDefined: false, mcpInstalled: true,
        agentsWaiting: false, canLaunch: false, blockers: []
      },
      updatedAt: Date.now()
    }
    pushTeam()
    return structuredClone(state.team)
  },
  chooseIndependentWorkspace: async () => ({
    id: previewWorkspace.workspaceId,
    name: previewWorkspace.workspaceName,
    path: previewWorkspace.workspacePath
  }),
  endActiveRun: async () => {
    state.team = {
      ...state.team,
      runs: state.team.runs.map((run) => (
        run.id === state.team.activeRun?.id ? { ...run, status: 'completed' as const, updatedAt: Date.now() } : run
      )),
      activeRun: state.team.activeRun
        ? { ...state.team.activeRun, status: 'completed' as const, updatedAt: Date.now() }
        : undefined
    }
    pushTeam()
    return structuredClone(state.team)
  },
  setSlotModelSelection: async () => structuredClone(state.team),
  // 协作组操作在预览里只回传当前快照；组卡片的交互预览由 ⑤b 的 `?groups=1` 场景补齐。
  createTeamGroup: async () => structuredClone(state.team),
  addTeamGroupMembers: async () => structuredClone(state.team),
  removeTeamGroupMember: async () => structuredClone(state.team),
  setTeamGroupLead: async () => structuredClone(state.team),
  updateTeamGroupGoal: async () => structuredClone(state.team),
  setTeamGroupPlanPolicy: async () => structuredClone(state.team),
  dissolveTeamGroup: async () => structuredClone(state.team),
  planTeamGroupTasks: async () => [],
  getTeamCollaborationSnapshot: async () => structuredClone(collaborationSnapshot),
  getManualHandoffOptions: async (slotId) => {
    const source = state.team.members.find((member) => member.slot.id === slotId)
    if (!source?.binding) throw new Error('待交接角色不存在')
    return {
      runId: state.team.activeRun!.id,
      sourceSlotId: source.slot.id,
      sourceRoleName: source.role.name,
      sourceChannelId: source.binding.channelId,
      candidates: [
        ...state.team.standbyChannels.filter((channel) => channel.agentSessionId).map((channel) => ({
          agentSessionId: channel.agentSessionId!,
          kind: 'standby' as const,
          mode: 'role_rebind' as const,
          channelId: channel.channelId,
          roleName: channel.displayName,
          eligible: channel.online && channel.waiting && channel.queueDepth === 0,
          blocker: !channel.online ? '备用 Agent 已离线' : !channel.waiting ? '备用 Agent 尚未待命' : channel.queueDepth ? `队列中还有 ${channel.queueDepth} 条消息` : undefined,
          impact: '备用 Agent 将直接接管，不会产生新的职责空缺'
        })),
        ...state.team.members.filter((member) => member.slot.solo !== true && member.slot.id !== source.slot.id && member.binding && member.runtime?.online).map((member) => ({
        agentSessionId: member.binding!.agentSessionId,
        kind: 'member' as const,
        mode: source.role.templateKey === 'lead' ? 'lead_authority' as const : 'role_rebind' as const,
        channelId: member.binding!.channelId,
        slotId: member.slot.id,
        roleName: member.role.name,
        avatarId: member.slot.avatarId,
        eligible: source.role.templateKey === 'lead'
          ? true
          : member.runtime!.waiting && member.runtime!.queueDepth === 0 && member.role.templateKey !== 'lead',
        blocker: source.role.templateKey !== 'lead' && member.role.templateKey === 'lead'
          ? '不能挪走当前唯一主控'
          : undefined,
        impact: source.role.templateKey === 'lead'
          ? `保留${member.role.name}职责与现有任务，同时接管唯一主控权限`
          : `${member.role.name}席将转为离线空缺`
        }))
      ]
    }
  },
  manualHandoff: async ({ sourceSlotId, replacementAgentSessionId }) => {
    const source = state.team.members.find((member) => member.slot.id === sourceSlotId)!
    const donor = state.team.members.find((member) => member.binding?.agentSessionId === replacementAgentSessionId)
    const standby = state.team.standbyChannels.find((channel) => channel.agentSessionId === replacementAgentSessionId)
    const sourceBinding = source.binding!
    if (source.role.templateKey === 'lead' && donor) {
      state.team = {
        ...state.team,
        revision: state.team.revision + 1,
        activeRun: state.team.activeRun
          ? { ...state.team.activeRun, actingLeadSlotId: donor.slot.id, updatedAt: Date.now() }
          : undefined,
        runs: state.team.runs.map((run) => run.id === state.team.activeRun?.id
          ? { ...run, actingLeadSlotId: donor.slot.id, updatedAt: Date.now() }
          : run)
      }
      pushTeam()
      return {
        handoff: {
          mode: 'lead_authority' as const,
          messageId: 'preview-lead-authority-message',
          actingLeadSlotId: donor.slot.id,
          recoveredTaskIds: []
        },
        team: structuredClone(state.team)
      }
    }
    const sourceChannel = sourceBinding.channelId
    const replacementChannelId = donor?.binding?.channelId ?? standby!.channelId
    const replacementAgentSessionIdResolved = donor?.binding?.agentSessionId ?? standby!.agentSessionId!
    source.binding = {
      ...sourceBinding,
      channelId: replacementChannelId,
      agentSessionId: replacementAgentSessionIdResolved,
      slotId: source.slot.id,
      launchStatus: 'sending'
    }
    source.slot = { ...source.slot, channelId: replacementChannelId, avatarId: donor?.slot.avatarId ?? source.slot.avatarId }
    source.runtime = donor?.runtime
      ? { ...donor.runtime, channelId: replacementChannelId }
      : { channelId: replacementChannelId, status: 'waiting', online: true, waiting: true, queueDepth: 0, lastSeenAt: Date.now(), healthEvidence: ['备用 Agent 已接管'], workingFiles: [] }
    source.readiness = 'launching'
    if (donor?.binding) {
      donor.binding = { ...sourceBinding, slotId: donor.slot.id, launchStatus: 'failed' }
      donor.slot = { ...donor.slot, channelId: sourceChannel }
      donor.runtime = donor.runtime ? { ...donor.runtime, channelId: sourceChannel, online: false, waiting: false, status: 'offline' } : donor.runtime
      donor.readiness = 'offline'
    }
    const failover = {
      id: `team-handoff:manual:preview`, workspaceId: sourceBinding.workspaceId,
      runId: sourceBinding.runId, slotId: source.slot.id, roleName: source.role.name,
      fromChannelId: sourceChannel, fromAgentSessionId: sourceBinding.agentSessionId,
      toChannelId: replacementChannelId, toAgentSessionId: replacementAgentSessionIdResolved,
      status: 'waiting_for_agent' as const, reason: '用户手动交接', taskIds: [],
      detectedAt: Date.now(), updatedAt: Date.now()
    }
    state.team = {
      ...state.team,
      revision: state.team.revision + 1,
      activeRun: state.team.activeRun ? { ...state.team.activeRun, status: 'attention' } : undefined,
      standbyChannels: standby ? state.team.standbyChannels.filter((channel) => channel.agentSessionId !== replacementAgentSessionId) : state.team.standbyChannels,
      failovers: [failover, ...state.team.failovers]
    }
    pushTeam()
    return {
      handoff: {
        mode: 'role_rebind',
        failover,
        messageId: 'preview-handoff-message', vacatedSlotId: donor?.slot.id
      },
      team: structuredClone(state.team)
    }
  },
  setWindowChromeColorMode: async () => true,
  onSnapshot: (listener) => {
    desktopListeners.add(listener)
    return () => desktopListeners.delete(listener)
  },
  // 用量预览：每个已绑定 Composer 都有独立累计，便于走查工作台顶部统计。
  // ?stats=1 换用带逐回合账本的整套快照（统计页时间序列走查）。
  getCursorUsageSnapshot: async () => statsPreviewMode ? previewStatsUsage() : Object.fromEntries(state.desktop.sessions.flatMap((session, index) => (
    session.composerId ? [[session.composerId, {
      composerId: session.composerId,
      turns: index + 2,
      inputTokens: 12_168 * (index + 1),
      outputTokens: previewParameters.has('usageEstimate') ? 0 : 42 * (index + 1),
      cacheReadTokens: 3_968 * (index + 1),
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.0421 * (index + 1),
      ...(previewParameters.has('usageEstimate') ? estimateUsageFromReference(278_120, 'claude-fable-5-1', priceForModel('claude-fable-5-1')) : {}),
      quality: previewParameters.has('usageEstimate') ? 'estimated' as const : 'exact' as const,
      pricedModel: previewParameters.has('usageEstimate') ? 'Claude Fable 5.1' : session.executionProfile?.displayName ?? 'Claude Sonnet',
      lastTurnAt: previewNow
    }]] : []
  ))),
  getWorkspaceReview: async (input) => {
    const scope = input?.scope ?? 'uncommitted'
    const base = {
      scope,
      workspaceName: 'wedge-demo',
      revision: `preview-review-${reviewScene ?? 'ready'}`,
      updatedAt: Date.now(),
      branch: { current: 'feature/inspector', base: 'main' },
      liveUpdates: true
    }
    if (reviewScene === 'clean') {
      return { ...base, state: 'clean', additions: 0, deletions: 0, files: [], headCommit: { short: 'e944fd9', subject: 'Keep the Cursor process hook alive across in-place workbench reloads' } }
    }
    if (reviewScene === 'not_git') {
      return { ...base, state: 'not_git', additions: 0, deletions: 0, files: [], branch: undefined, liveUpdates: false, detail: '该文件夹不在任何 Git 仓库内；初始化仓库后即可在这里审查变更。' }
    }
    if (reviewScene === 'error') {
      return { ...base, state: 'error', additions: 0, deletions: 0, files: [], liveUpdates: false, detail: 'git status 退出码 128：fatal: not a git repository (or any of the parent directories)' }
    }
    if (reviewScene === 'many') {
      const files: WorkspaceReviewSummary['files'] = [
        { path: 'src/renderer/src/inspector/ReviewPanel.tsx', status: 'modified', staged: false, unstaged: true, additions: 96, deletions: 31 },
        { path: 'src/renderer/src/inspector/InspectorShell.tsx', status: 'modified', staged: true, unstaged: true, additions: 12, deletions: 4 },
        { path: 'src/renderer/src/inspector/activity-view.ts', status: 'added', staged: true, unstaged: false, additions: 215, deletions: 0 },
        { path: 'src/renderer/src/workspace-inspector.css', status: 'modified', staged: false, unstaged: true, additions: 140, deletions: 22 },
        { path: 'src/renderer/src/WorkspaceInspector.tsx', status: 'renamed', previousPath: 'src/renderer/src/WorkspacePanel.tsx', staged: true, unstaged: false, additions: 3, deletions: 3 },
        { path: 'docs/UI-STRUCTURE.md', status: 'deleted', staged: false, unstaged: true, additions: 0, deletions: 30 },
        { path: 'preview-screenshots/review-light.png', status: 'untracked', staged: false, unstaged: true, binary: true },
        { path: 'tests/inspector-shell.test.tsx', status: 'untracked', staged: false, unstaged: true, additions: 123, deletions: 0 },
        { path: 'src/renderer/src/lobby/a-very-long-directory-name/nested/deeper/still-going/components/IndependentSessionPage.tsx', status: 'modified', staged: false, unstaged: true, additions: 8, deletions: 8 }
      ]
      return {
        ...base, state: 'ready',
        additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
        files
      }
    }
    return {
      ...base,
      state: 'ready',
      additions: 21,
      deletions: 8,
      files: [
        { path: 'src/renderer/src/SessionWorkspace.tsx', status: 'modified', staged: false, unstaged: true, additions: 14, deletions: 5 },
        { path: 'src/renderer/src/styles.css', status: 'modified', staged: true, unstaged: false, additions: 7, deletions: 3 }
      ]
    }
  },
  applyWorkspaceReviewAction: async ({ action, path }) => ({ ok: true, message: `预览环境：已模拟 ${action} ${path}` }),
  revealWorkspaceFile: async () => true,
  openWorkspaceFile: async () => ({ ok: true, method: 'editor' }),
  onWorkspaceReviewChanged: () => () => {},
  getWorkspaceReviewFile: async ({ path }) => ({
    state: 'ready', path, truncated: false,
    hunks: [{
      header: '@@ -628 +628 @@', skippedBefore: 627,
      lines: [
        { kind: 'context', text: '.session-usage { display: inline-flex; }', oldLine: 628, newLine: 628 },
        { kind: 'deletion', text: '.session-usage__label { font-size: 9px; }', oldLine: 629 },
        { kind: 'addition', text: '.session-usage__label { font-size: 11px; }', newLine: 629 }
      ]
    }]
  }),
  onCursorUsageSnapshot: () => () => {},
  onTaskPoolSnapshot: () => () => {},
  onTeamControlSnapshot: (listener) => {
    teamListeners.add(listener)
    return () => teamListeners.delete(listener)
  },
  onTeamCollaborationSnapshot: () => () => {}
}

window.sgDesktop = api
applyAppearancePreferences(readAppearancePreferences())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
