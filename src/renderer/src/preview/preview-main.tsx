import { reduceGroupEffects } from '../../../domain/group-effects-notification'
import { observedMcpWrite } from '../../../domain/mcp-write-observation'
import { reduceMcpWriteNotifications } from '../../../domain/mcp-write-notification'
import { reduceUsageStorageNotifications } from '../../../domain/usage-storage-notification'
import { reduceModelCatalogNotifications } from '../../../domain/model-catalog-notification'
import { reduceRuntimeUsageNotifications } from '../../../domain/runtime-usage-notification'
import { reduceUsageBindingNotifications } from '../../../domain/usage-binding-notification'
import { reduceGroupTopologyNotifications } from '../../../domain/group-topology-notification'
import type { GroupEffectsFrame } from '../../../domain/group-effects'
import { reduceMemoryIssueNotifications, type MemoryIssueState } from '../../../domain/memory-issue-notification'
import type { MemoryOperatorReviewProof } from '../../../domain/memory-operator-review'
import type { TeamMemoryInspectionRequest } from '../../../domain/team-memory-inspection'
import { reduceCompatibilityNotifications } from '../../../domain/cursor-compatibility-notification'
import { reduceContextThresholdNotifications } from '../../../domain/context-threshold-notification'
/**
 * 设计走查入口：mock 掉 preload API，在纯浏览器里渲染完整应用。
 * 仅供 preview.html 使用，不进入生产构建，不连接任何端口。
 */
import { StrictMode } from 'react'
import { createNotificationPreview } from './notification-preview'
import { reduceOperatorMessages } from '../../../domain/team-message-notification'
import { operatorMessageNativeFields } from '../../../domain/operator-message-read'
import { reduceQueueNotifications } from '../../../domain/queue-notification'
import { pageOperationNotification, pageOperationReference, type PageNotificationOperation, type PageOperationOutcome } from '../../../domain/page-operation-notification'
import { createRoot } from 'react-dom/client'
import type { AccountAutomationRun } from '../../../domain/account-automation'
import { ACCOUNT_AUTOMATION_STEPS } from '../../../domain/account-automation'
import { automationNotification } from '../../../domain/automation-notification'
import { TaskPoolAggregate } from '../../../domain/task-pool'
import { parseCursorAccountCard } from '../../../domain/cursor-account-card'
import { cursorCompatibilityForVersion } from '../../../domain/cursor-compatibility'
import type { ConversationEntry, ProcessBlock } from '../../../domain/conversation-entry'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES, createConfiguredTeamBundle, emptyTeamControlSnapshot } from '../../../domain/team-control'
import type { TeamRunStatus } from '../../../domain/team-control'
import { teamMessageNeedsAgentResponse, type TeamMessage } from '../../../domain/team-collaboration'
import type { LiveProcessState, LiveStatusLineState, SgDesktopApi } from '../../../shared/desktop-api'
import type { WorkspaceReviewSummary } from '../../../domain/workspace-review'
import { estimateTurnCostUsd, estimateUsageFromReference, priceForModel, projectUsage, type CursorUsageSnapshot, type UsageTurn } from '../../../domain/cursor-usage'
import { CURSOR_STORAGE_CATALOG, buildCleanupPlan, type CursorStorageScan } from '../../../domain/cursor-storage-cleanup'
import {
  APP_UPDATE_SNOOZE_MS,
  appUpdateReminderVersion,
  evaluateUpdateGate,
  normalizeAppUpdateSettings,
  type AppUpdateApplyResult,
  type AppUpdateBackupInfo,
  type AppUpdateRelease,
  type AppUpdateSettings,
  type AppUpdateState,
  type AppUpdateStatus
} from '../../../domain/app-update'
import { formatFileSize } from '../../../shared/format-file-size'
import { App } from '../App'
import { applyAppearancePreferences, readAppearancePreferences } from '../appearance-preferences'
import {
  collaborationSnapshot,
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
import '../settings/update.css'
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
// 账号自动化走查场景：?automation=countdown|processing|hardening-countdown|importing|deleting|cleaning|done|failed|cancelled
const automationScene = (['countdown', 'processing', 'hardening-countdown', 'importing', 'deleting', 'cleaning', 'done', 'failed', 'cancelled'] as const)
  .find((phase) => phase === previewParameters.get('automation'))
const previewNow = Date.now()
const collaborationMapScene = (['live', 'flat', 'ended', 'empty', 'many', 'offline', 'long', 'image', 'end', 'switch', 'transfer'] as const)
  .find(scene => scene === previewParameters.get('collaborationMap'))
const processingOnlyScene = previewParameters.get('postProcessing') === 'off'
const automationSceneRunBase: AccountAutomationRun | undefined = automationScene ? ({
  countdown: { phase: 'countdown', message: '将在 6.5s 后自动处理当前账号（可取消）', remainingSec: 6.5, planId: 'preview-plan', startedAt: previewNow - 3_500 },
  processing: {
    phase: 'processing', message: '奥仔：正在提交 Session Token 处理…', planId: 'preview-plan', startedAt: previewNow - 12_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'preparing', message: '票据已就绪，等待退款完成', startedAt: previewNow - 10_000 }
  },
  'hardening-countdown': {
    phase: 'hardening-countdown', message: '奥仔已完成，将在 4s 后加固当前账号（可取消）', remainingSec: 4, planId: 'preview-plan', startedAt: previewNow - 24_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'preparing', message: '票据已就绪，3.5s 后切换', startedAt: previewNow - 10_000 }
  },
  importing: { phase: 'importing', message: '会话已失效，正在刷新浏览器会话获取新 Token…', planId: 'preview-plan', startedAt: previewNow - 26_000 },
  deleting: {
    phase: 'deleting', message: '奥仔已完成，正在刷新浏览器会话并秒级加固账号…', planId: 'preview-plan', startedAt: previewNow - 31_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'switching', message: '等待 Cursor 接收并确认', startedAt: previewNow - 8_000 }
  },
  cleaning: {
    phase: 'cleaning', message: '账号已加固，正在清理浏览器环境并轮换指纹…', planId: 'preview-plan', startedAt: previewNow - 40_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'done', message: 'Cursor 已完成接手', startedAt: previewNow - 12_000, finishedAt: previewNow - 10_000 }
  },
  done: {
    phase: 'done', message: '自动化完成：已处理、账号已加固（浏览器会话内秒级执行）、本地记录已移除', planId: 'preview-plan', startedAt: previewNow - 47_000, finishedAt: previewNow - 5_000,
    handover: { accountId: 'preview-acc-2', label: 'spare@example.com', status: 'done', message: 'Cursor 已完成接手', startedAt: previewNow - 18_000, finishedAt: previewNow - 16_000 }
  },
  failed: { phase: 'failed', message: '奥仔处理失败：卡密余额不足，请先充值或更换卡密（本地账号已保留）', planId: 'preview-plan', startedAt: previewNow - 22_000, finishedAt: previewNow - 8_000 },
  cancelled: { phase: 'cancelled', message: '已取消本次自动化', planId: 'preview-plan', startedAt: previewNow - 9_000, finishedAt: previewNow - 4_000 }
} as const)[automationScene] : undefined
let automationSceneRun = automationSceneRunBase && processingOnlyScene
  ? { ...automationSceneRunBase, postProcessingEnabled: false, handover: undefined,
      ...(automationSceneRunBase.phase === 'done' ? { message: '奥仔处理已完成；后续操作未执行，本地账号记录已保留' } : {}) }
  : automationSceneRunBase
const observedAutomationScene = previewParameters.get('automationOutcome')
if (automationSceneRun && observedAutomationScene) {
  const observations = Object.fromEntries(ACCOUNT_AUTOMATION_STEPS.map(step => [step, { status: step === 'refresh' ? 'skipped' : 'succeeded' }])) as NonNullable<AccountAutomationRun['observations']>
  if (processingOnlyScene) for (const step of ['refresh', 'harden', 'localRecord', 'cleanup', 'handover'] as const) observations[step] = { status: 'skipped' }
  if (observedAutomationScene === 'cleanup-failed') observations.cleanup = { status: 'failed', detail: '原步骤返回清场未完成，已确认的处理和加固结果保留。' }
  if (observedAutomationScene === 'handover-pending') observations.handover = { status: 'unknown', detail: '原等待期限内未取得回执，后台结果尚未确认。' }
  if (observedAutomationScene === 'cancelled-after-process') {
    observations.harden = { status: 'cancelled' }; observations.localRecord = { status: 'not_started' }; observations.cleanup = { status: 'not_started' }; observations.handover = { status: 'cancelled' }
  }
  automationSceneRun = { ...automationSceneRun, operationId: 'preview-observed-automation', revision: 8, processingProvider: 'aozai', observations,
    ...(observedAutomationScene === 'cancelled-after-process' ? { phase: 'cancelled', cancelledStep: 'harden', cancellationReason: 'user' } : {}) }
}
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
// run 只有 running / completed 两态（阶段 2 · 2B）：`?runStatus=completed` 走查已结束的运行。
const previewRunStatus = (['running', 'completed'] as TeamRunStatus[])
  .find((status) => status === requestedRunStatus)
// 右栏「变更」面板走查：?review=clean|not_git|error|many|syntax（缺省为两文件就绪态）。
// not_git 下面板会自动落到「本轮」（Agent 编辑流）；not_git 卡片要手动切回「未提交」才能看到。
const reviewScene = (['clean', 'not_git', 'error', 'many', 'syntax'] as const).find((scene) => scene === previewParameters.get('review'))
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
    blockers: ['团队已经运行']
  }
}
if (previewRunStatus && initialTeam.activeRun) {
  initialTeam.activeRun = { ...initialTeam.activeRun, status: previewRunStatus }
  initialTeam.runs = initialTeam.runs.map((run) => (
    run.id === initialTeam.activeRun?.id ? { ...run, status: previewRunStatus } : run
  ))
  if (previewRunStatus === 'completed') {
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
    blockers: ['Agent MCP 尚未接入全部本轮通道']
  }
}
// 运行页独立批次走查：?independent=live|mixed|spread|ended|groups
//（席位形态：全部待命 / 待命+执行中+离线+待确认（CH-2 单独配置了另一模型）/ 各席配置分叉、没有多数 /
//  已结束 / 会话池里两个协作组 + 一个刚解散的组）。
const independentScene = (['live', 'mixed', 'spread', 'ended', 'groups'] as const).find((scene) => scene === previewParameters.get('independent'))
  ?? (['operator-memory','group-effects','native-content','operator-read'].includes(previewParameters.get('notifications')??'') ? 'groups' : undefined)
const poolLayoutCase = previewParameters.get('poolLayout')
if (independentScene && initialTeam.activeRun) {
  const solo = initialTeam.members.find((member) => member.slot.solo === true)!
  const shapes = poolLayoutCase === 'sixteen'
    ? Array.from({ length: 16 }, () => 'waiting' as const)
    : poolLayoutCase === 'reference'
      ? ['offline', 'offline', 'offline'] as const
      : independentScene === 'live'
    ? ['waiting', 'waiting', 'waiting'] as const
    : independentScene === 'groups'
      ? ['waiting', 'working', 'waiting', 'offline', 'waiting'] as const
      : independentScene === 'spread'
        ? ['waiting', 'waiting', 'working', 'waiting'] as const
        : ['waiting', 'working', 'offline', 'unconfirmed'] as const
  const status = independentScene === 'ended' || previewRunStatus === 'completed' ? 'completed' as const : 'running' as const
  const run = { ...initialTeam.activeRun, name: 'wedge-demo · 独立批次 #3', templateId: 'independent-session-v1', status }
  initialTeam.activeRun = run
  initialTeam.runs = [run]
  // 目录里的 Claude Fable 5（默认参数）：mixed 场景只给 CH-2，spread 场景给 CH-3 / CH-4（2 : 2，没有多数）。
  const fable = desktopSnapshot.cursorModels?.find((model) => model.modelId === 'claude-fable-5')
  const fableSelection = fable ? { modelId: fable.modelId, displayName: fable.displayName, parameters: structuredClone(fable.parameters), maxMode: false } : undefined
  const divergedChannels = independentScene === 'mixed' ? ['2'] : independentScene === 'spread' ? ['3', '4'] : []
  initialTeam.members = shapes.map((shape, index) => {
    const channelId = String(index + 1)
    const base = { channelId, queueDepth: 0, lastSeenAt: previewNow - (index + 1) * 40_000, healthEvidence: [], workingFiles: [] }
    return {
      ...solo,
      slot: {
        ...solo.slot,
        id: `slot:solo-${channelId}`,
        name: `独立席 ${channelId}`,
        channelId,
        ...(divergedChannels.includes(channelId) && fableSelection ? { modelSelection: fableSelection } : {})
      },
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
  if (poolLayoutCase === 'long' || poolLayoutCase === 'reference') {
    const recorded = fableSelection ?? initialTeam.members[0]?.slot.modelSelection
    for (const member of initialTeam.members) {
      if (recorded) member.slot.modelSelection = structuredClone(recorded)
      if (poolLayoutCase === 'long') {
        member.slot.name = '负责客户端协议适配、桌面集成与跨平台稳定性验证的会话'
        if (member.slot.modelSelection) {
          member.slot.modelSelection.modelId = 'recorded-long-model'
          member.slot.modelSelection.displayName += ' · Long Context Thinking Configuration'
        }
      }
    }
  }
  if (poolLayoutCase === 'awaiting' && initialTeam.members[0]?.runtime) initialTeam.members[0].runtime.awaitingUser = true
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
// `?handoff=1`：CH-1 离线、其余待命——run 状态不变（离线只是席位 / 组的事实，run 没有 attention 态）。
if (manualHandoffMode && initialTeam.activeRun) {
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
// End-to-end renderer scenes use the SAME desktop snapshot contract, never the standalone concept DOM.
if (collaborationMapScene && state.team.activeRun) {
  const baseMember = state.team.members[0]!, baseSession = state.desktop.sessions[0]!, run = state.team.activeRun
  run.templateId = 'independent-session-v1'
  run.status = collaborationMapScene === 'ended' ? 'completed' : 'running'
  const count = collaborationMapScene === 'many' ? 16 : 8, groupId = 'team-group:preview-map'
  const roles = [
    ['主控协调', 'lead', 'lead'], ['架构实现', 'builder', 'architect'], ['质量验证', 'reviewer', 'reviewer'], ['前端体验', 'frontend', 'frontend'],
    ['后端开发', 'backend', 'backend'], ['工程运维', 'devops', 'devops'], ['产品规划', 'product', 'product'], ['技术研究', 'researcher', 'researcher']
  ] as const
  state.team.members = Array.from({ length: count }, (_, index) => {
    const channelId = String(index + 1), preset = roles[index % roles.length]!, slotId = `slot:map-${channelId}`
    const offline = collaborationMapScene === 'offline' && index === 2
    const role = { ...baseMember.role, id: `role:map-${channelId}`, groupId, order: index, name: index === 0 && collaborationMapScene === 'flat' ? '协调成员' : preset[0],
      templateKey: index === 0 && collaborationMapScene === 'flat' ? 'builder' : preset[1] }
    return { ...baseMember, role,
      slot: { ...baseMember.slot, id: slotId, runId: run.id, roleId: role.id, channelId, order: index, name: role.name, avatarId: preset[2], groupId, solo: false, groupJoinedAt: previewNow - 60_000 },
      binding: baseMember.binding ? { ...baseMember.binding, id: `binding:map-${channelId}`, runId: run.id, slotId, channelId, agentSessionId: `session:map-${channelId}` } : undefined,
      runtime: { channelId, status: offline ? 'offline' as const : index % 2 ? 'running' as const : 'waiting' as const, online: !offline, waiting: !offline && index % 2 === 0,
        connectionPhase: offline ? 'cursor_stopped' : index % 2 ? 'processing' : 'waiting', runtimeEvidence: offline ? 'stopped' as const : 'active' as const,
        queueDepth: 0, lastSeenAt: previewNow, healthEvidence: [], workingFiles: [] } }
  })
  const leadSlotId = collaborationMapScene === 'flat' ? undefined : state.team.members[0]!.slot.id
  state.team.groups = [{ group: { id: groupId, runId: run.id, name: collaborationMapScene === 'long' ? '跨平台消息隔离与工作区适配 · 深度验收协作组' : '接口重构',
    goal: '保留现有会话与任务逻辑，完善接口边界并独立验证组内隔离。', status: 'active', leadSlotId,
    planPolicy: leadSlotId ? 'lead_only' : 'any_member', createdAt: previewNow - 120_000, updatedAt: previewNow },
    members: state.team.members, effectiveLeadSlotId: leadSlotId, attention: collaborationMapScene === 'offline' }]
  state.team.slots = state.team.members.map(member => member.slot); state.team.roles = state.team.members.map(member => member.role)
  state.team.bindings = state.team.members.flatMap(member => member.binding ? [member.binding] : [])
  state.team.runs = [run]
  state.desktop.sessions = state.team.members.map(member => ({ ...baseSession, id: member.binding?.agentSessionId ?? '', channelId: member.slot.channelId!, displayName: member.role.name,
    roleName: member.role.name, roleTemplateKey: member.role.templateKey, avatarId: member.slot.avatarId,
    status: member.runtime!.status, online: member.runtime!.online, connected: member.runtime!.online, waiting: member.runtime!.waiting, queueDepth: 0,
    connectionPhase: member.runtime!.connectionPhase ?? 'waiting', contextUsage: undefined }))
  state.desktop.conversations = {}
}
// 编辑直播走查独立起一轮，避免通用样例里的已完成回复把运行标记结算为历史。
if (previewParameters.get('editStream') === '1' && state.desktop.liveProcess?.['2']) {
  const edit = state.desktop.liveProcess['2'].blocks.find(block => block.id === 'live-edit-stream')
  state.desktop.liveProcess['2'] = {
    turn: 'preview-edit-stream', startedAt: previewNow - 1_000, updatedAt: previewNow, generating: true,
    blocks: edit ? [{ ...edit, startedAt: previewNow - 1_000 }] : []
  }
  state.desktop.conversations['2'] = []
  state.desktop.sessions = state.desktop.sessions.map(session => session.channelId === '2'
    ? { ...session, status: 'running', online: true, connected: true, waiting: false } : session)
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
// 会话名册走查：?sessions=none（空态）| many（两个组 + 独立段、四种状态齐全、需要滚动、含未绑定的备用通道）。
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
      variant(builder, '4', { displayName: '后端实现 · CH-4', roleName: '后端席', roleTemplateKey: 'backend', avatarId: 'backend', status: 'running', connectionPhase: 'processing', waiting: false, contextUsage: { used: 512_000, limit: 1_000_000, ratio: 0.512 }, changes: { additions: 42, deletions: 3, files: 2 }, modelName: 'GPT-5.6', executionProfile: undefined }),
      variant(lead, '5', { displayName: '质量验证 · CH-5', roleName: '验收席', roleTemplateKey: 'reviewer', avatarId: 'reviewer', isEffectiveLead: false, status: 'review', connectionPhase: 'processing', waiting: false, contextUsage: { used: 880_000, limit: 1_000_000, ratio: 0.88 }, changes: undefined, queueDepth: 1 }),
      variant(lead, '6', { displayName: '前端体验 · CH-6', roleName: '体验席', roleTemplateKey: 'frontend', avatarId: 'frontend', isEffectiveLead: false, status: 'blocked', connectionPhase: 'approval', waiting: false, contextUsage: { used: 210_000, limit: 1_000_000, ratio: 0.21 }, changes: { additions: 9, deletions: 1, files: 1 }, modelName: 'Kimi K3', executionProfile: undefined }),
      variant(lead, '7', { displayName: '研究分析 · CH-7', roleName: '研究席', roleTemplateKey: 'researcher', avatarId: 'researcher', isEffectiveLead: false, status: 'waiting', connectionPhase: 'keepalive', waiting: true, contextUsage: undefined, changes: undefined, modelName: 'Gemini 3.5 Pro', executionProfile: undefined }),
      solo,
      variant(solo, '8', { displayName: 'SG Team CH-8', roleName: '未绑定外置团队', roleTemplateKey: undefined, avatarId: undefined, status: 'offline', online: false, connected: false, waiting: false, contextUsage: undefined, lastSeenAt: previewNow - 3 * 60 * 60_000, queueDepth: 0, modelName: undefined, executionProfile: undefined }),
      // 独立段再放三行（干活 / 待命 / 离线），让第二个组条在 620px 高的窗口里也能被钉住后折叠（滚动锚定走查的前提）。
      variant(solo, '9', { displayName: '独立执行 2 · CH-9', roleName: '独立执行 2', status: 'running', connectionPhase: 'processing', waiting: false, online: true, contextUsage: { used: 96_000, limit: 1_000_000, ratio: 0.096 }, changes: { additions: 17, deletions: 4, files: 3 }, queueDepth: 0, modelName: 'Fable 5', executionProfile: undefined }),
      variant(solo, '10', { displayName: '独立执行 3 · CH-10', roleName: '独立执行 3', status: 'waiting', connectionPhase: 'waiting', waiting: true, online: true, contextUsage: { used: 320_000, limit: 1_000_000, ratio: 0.32 }, changes: undefined, queueDepth: 0, modelName: 'GPT-5.6', executionProfile: undefined }),
      variant(solo, '11', { displayName: '独立执行 4 · CH-11', roleName: '独立执行 4', status: 'offline', online: false, connected: false, waiting: false, contextUsage: undefined, changes: undefined, lastSeenAt: previewNow - 40 * 60_000, queueDepth: 0, modelName: 'Fable 5', executionProfile: undefined })
    ]
  }
  // 名册按组分区（阶段 3 · D4=a）：CH-1 / 2 / 4 成「接口重构」（CH-1 lead），CH-5 / 6 / 8 成「验收」
  //（CH-8 已确认离线 → 组头「成员离线」徽标），CH-3 / 7 / 9 / 10 / 11 未入组落「独立」段。名册只认通道号，
  // 基础快照里没有的席位按 solo 席位的形状补一个即可。
  if (state.team.activeRun) {
    const seatOf = (channelId: string) => state.team.members.find((member) => member.slot.channelId === channelId)
    const template = seatOf('3') ?? state.team.members[0]!
    const memberOf = (channelId: string): typeof template => seatOf(channelId) ?? {
      ...template,
      slot: { ...template.slot, id: `slot:preview-many-${channelId}`, name: `席位 ${channelId}`, channelId },
      binding: template.binding ? { ...template.binding, channelId } : undefined
    }
    const groupBase = {
      runId: state.team.activeRun.id, goal: '', planPolicy: 'lead_only' as const,
      createdAt: previewNow - 3 * 3_600_000, updatedAt: previewNow - 15 * 60_000
    }
    const refactor = ['1', '2', '4'].map(memberOf)
    const review = ['5', '6', '8'].map(memberOf)
    state.team.groups = [
      {
        group: { ...groupBase, id: 'team-group:many:refactor', name: '接口重构', status: 'active', leadSlotId: refactor[0]!.slot.id },
        members: refactor, effectiveLeadSlotId: refactor[0]!.slot.id, attention: false
      },
      {
        group: { ...groupBase, id: 'team-group:many:review', name: '验收', status: 'active', leadSlotId: review[0]!.slot.id },
        members: review, effectiveLeadSlotId: review[0]!.slot.id, attention: true
      }
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
          output: [' RUN  v4.1.11 /Users/lyr/SG', '', ' ✓ tests/process-step-groups.test.ts (17 tests) 41ms', ' · tests/process-blocks.test.tsx running…'].join('\n')
        }
      ]
    }
  }
  state.desktop.liveAgentResponses = undefined
  state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === '2'
    ? { ...session, status: 'running', connectionPhase: 'processing', waiting: false, online: true, deliveryMode: 'queued' }
    : session)
}
// 已结束续作的重启回放：历史块有确切结束时刻，当前席位待命，标题必须静止。
if (previewParameters.get('continuation') === 'archived') {
  const replyAt = previewNow - 2 * 60 * 60_000
  const startedAt = previewNow - 90 * 60_000
  state.desktop.conversations = { ...state.desktop.conversations, '2': [
    { id: 'outbox:archived-cont', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
      timestamp: replyAt - 60_000, deliveredAt: replyAt - 59_000, text: '继续完成上一轮任务。' },
    { id: 'reply:archived-cont', channelId: '2', role: 'assistant', source: 'cursor', status: 'complete',
      timestamp: replyAt, replyToEntryId: 'outbox:archived-cont', text: '已接手，后续工作已完成。',
      continuationBlocks: [{ kind: 'tool', id: 'archived-read', toolName: 'Read', toolKind: 'read',
        summary: 'src/renderer/src/timeline-view.ts', status: 'done', startedAt, completedAt: startedAt + 60_000 }] }
  ] }
  // Cursor 长会话重连会重新给出 generating 帧；席位已经待命，旧续作仍应按完成时刻定格。
  state.desktop.liveProcess = { '2': {
    turn: 'cursor:archived-continuation', startedAt, updatedAt: previewNow, generating: true,
    blocks: [{ kind: 'tool', id: 'late-archived-read', toolName: 'Read', toolKind: 'read',
      summary: 'src/renderer/src/virtual-process-turns.ts', status: 'done',
      startedAt: startedAt + 30_000, completedAt: startedAt + 60_000 }]
  } }
  state.desktop.liveAgentResponses = undefined
  state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === '2'
    ? { ...session, status: 'waiting', waiting: true, connectionPhase: 'waiting', online: true }
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
// 本轮文件栏走查：?turnfiles=1 —— Agent 正在处理一条消息，已经改了三个文件（Git 已看到）、正在写第四个
//（Git 还没看到 → 按过程块估算），另有一个与本轮无关的未提交文件不该出现在栏里。可与 ?queued=1 叠加看两条栏。
// ?turnfiles=previous —— 上一轮的四个编辑已随回复落库，新消息刚被取走、Agent 在想还没动手：栏保住上一轮并标「上一轮」。
const turnFilesScene = (['1', 'previous', 'sole'] as const).find((mode) => mode === previewParameters.get('turnfiles'))
if (turnFilesScene) {
  const askedAt = previewNow - 4 * 60_000
  const previousTurn = turnFilesScene === 'previous'
  // sole：本轮是会话迄今唯一的改动区间——合计与名册行同源（Cursor Composer 累计净值）的走查。
  const soleTurn = turnFilesScene === 'sole'
  const editBlocks = (status: 'done' | 'running'): ProcessBlock[] => [
    { kind: 'tool', id: 'tf-edit-1', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: 'src/domain/team-control.ts', hint: '+18 −20', status: 'done', startedAt: askedAt + 30_000 },
    { kind: 'tool', id: 'tf-edit-2', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: 'src/mcp/index.ts', hint: '+22 −37', status: 'done', startedAt: askedAt + 70_000 },
    { kind: 'tool', id: 'tf-edit-3', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: 'src/application/team-failover-service.ts', hint: '+27 −318', status: 'done', startedAt: askedAt + 120_000 },
    // &deep=1：再加一对同名文件——深路径 + 长文件名（新建，Git 摘要里是 untracked）和它在 tests/ 下的同名兄弟：
    // 同名才把目录摆出来，走查目录列从头截断、扩展名不截断，以及 tsx 的 React 图标。
    ...(previewParameters.get('deep') === '1'
      ? [{
          kind: 'tool' as const, id: 'tf-edit-deep', toolName: 'write_file_v2', toolKind: 'write' as const, toolCase: 'writeToolCall',
          summary: 'src/renderer/src/features/very-long-feature-module-name/components/nested/deeper/TurnFilesBarAccessibilityRegressionHarness.test.tsx',
          hint: '+164 −0', status: 'done' as const, startedAt: askedAt + 150_000
        }, {
          kind: 'tool' as const, id: 'tf-edit-deep-twin', toolName: 'write_file_v2', toolKind: 'write' as const, toolCase: 'writeToolCall',
          summary: 'tests/TurnFilesBarAccessibilityRegressionHarness.test.tsx',
          hint: '+41 −0', status: 'done' as const, startedAt: askedAt + 152_000
        }]
      : []),
    { kind: 'tool', id: 'tf-edit-4', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: 'src/application/team-handoff-service.ts', hint: '+9 −15', status, startedAt: status === 'running' ? previewNow - 9_000 : askedAt + 150_000 }
  ]
  // 过程块按「最近一条已投递用户消息」归属回合：基础夹具里最近 5 分钟的历史（e7–e11，含一条
  // 与本轮提问同一分钟投递的用户消息）会抢走块的锚点，让本轮只剩打字占位。这一场景只保留提问
  // 一分钟之前的历史；?queued=1 追加在提问之后的未投递消息照常保留（它们本就不进时间线）。
  const history = soleTurn ? [] : (state.desktop.conversations['2'] ?? []).filter((entry) => (
    entry.timestamp < askedAt - 60_000 || (entry.role === 'user' && entry.deliveredAt === undefined && entry.timestamp > askedAt)
  ))
  state.desktop.conversations = {
    ...state.desktop.conversations,
    '2': [
      ...history.map((entry) => (
        entry.role === 'user' && entry.deliveredAt === undefined && entry.timestamp < askedAt
          ? { ...entry, deliveredAt: entry.timestamp + 1_000 }
          : entry
      )),
      // 上一轮的收尾编辑：让「更早回合有过改动」成立——一般情形下文件栏合计保持逐笔估算（≈），
      // 不被 Cursor 累计接管；同源接管的专门走查在 ?turnfiles=sole（那里没有任何更早改动）。
      ...(soleTurn ? [] : [{
        id: 'reply:turnfiles-0', channelId: '2', role: 'assistant', source: 'cursor', status: 'complete',
        timestamp: askedAt - 3 * 60_000,
        text: '上一轮已把 relay 的注册路径收口，`register-relay.ts` 少了一个入口分支。',
        processBlocks: [
          { kind: 'tool', id: 'tf-edit-0', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: 'src/main/register-relay.ts', hint: '+6 −2', status: 'done', startedAt: askedAt - 3 * 60_000 }
        ]
      } satisfies ConversationEntry]),
      {
        id: 'outbox:turnfiles-1', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
        timestamp: askedAt, deliveredAt: askedAt + 800,
        text: '把团队 run 的创建 / 启动路径退役掉：failover 不再接管席位，handoff 在会话池里拒绝角色迁移。'
      },
      ...(previousTurn
        ? [
            {
              id: 'reply:turnfiles-1', channelId: '2', role: 'assistant', source: 'cursor', status: 'complete',
              timestamp: askedAt + 170_000, replyToEntryId: 'outbox:turnfiles-1', turn: 'cursor:preview-turnfiles-turn:virtual:outbox:turnfiles-1',
              text: '退役完成：`team-control.ts` 收掉了 run 创建 / 启动的状态分支，`team-failover-service.ts` 不再接管席位，`team-handoff-service.ts` 在池 run 里直接拒绝角色迁移；MCP 入口同步删掉两个死参数。typecheck 与相关测试通过。',
              processBlocks: [
                { kind: 'thinking', id: 'tf-think', text: '先收 domain 的状态枚举，再删 failover 的接管分支，最后让 handoff 在池 run 里直接拒绝。', status: 'done', durationMs: 6_200, startedAt: askedAt + 2_000 },
                ...editBlocks('done')
              ]
            } satisfies ConversationEntry,
            {
              id: 'outbox:turnfiles-2', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
              timestamp: previewNow - 22_000, deliveredAt: previewNow - 20_000,
              text: '继续：给 handoff 的拒绝分支补上测试，顺手把 ARCHITECTURE 的记录写了。'
            } satisfies ConversationEntry
          ]
        : [])
    ]
  }
  state.desktop.liveProcess = {
    ...(state.desktop.liveProcess ?? {}),
    '2': previousTurn
      ? {
          // 新回合刚开始：只有一个还在想的 thinking 块，没有任何编辑 → 文件栏保住上一轮。
          turn: 'cursor:preview-turnfiles-turn',
          startedAt: previewNow - 15_000,
          updatedAt: previewNow - 400,
          generating: true,
          blocks: [
            { kind: 'thinking', id: 'tf-think-2', text: '拒绝分支有两条路径：池 run 内迁移与跨 run 迁移，测试分别覆盖……', status: 'running', startedAt: previewNow - 15_000 }
          ]
        }
      : {
          turn: 'cursor:preview-turnfiles-turn',
          startedAt: askedAt + 2_000,
          updatedAt: previewNow - 600,
          generating: true,
          blocks: [
            { kind: 'thinking', id: 'tf-think', text: '先收 domain 的状态枚举，再删 failover 的接管分支，最后让 handoff 在池 run 里直接拒绝。', status: 'done', durationMs: 6_200, startedAt: askedAt + 2_000 },
            ...editBlocks('running')
          ]
        }
  }
  state.desktop.liveAgentResponses = undefined
  state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === '2'
    ? {
        ...session,
        status: 'running',
        connectionPhase: 'processing',
        waiting: false,
        online: true,
        deliveryMode: 'queued',
        queueDepth: previewParameters.get('queued') === '1' ? 3 : 0,
        // sole：Cursor 统计的累计净值（略小于逐笔求和的 +76 −390——同文件反复编辑不重复计入），
        // 名册行与文件栏合计显示同一个数。
        ...(soleTurn ? { changes: { additions: 74, deletions: 388, files: 4 } } : {})
      }
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
                { content: '恢复上下文：读任务书 DYNAMIC-GROUPS-PHASE3-UI-TODO 与已提交的检查点（PoolPage / GroupCard / ConfirmSheet）', status: 'completed' },
                { content: 'SessionSidebar：多选状态（picked / pickAnchor）+ ⌘/Ctrl 点击、Shift 范围、行首复选框', status: 'in_progress' },
                { content: '底部浮动条：建组（N）/ 加入…（MenuSelect）/ 移出组（M）/ 取消，lead 挡移出要说明', status: 'pending' },
                { content: '移出确认面复用 ConfirmSheet：文案走 removeMembersConsequence，与组卡片同源', status: 'pending' },
                { content: 'GroupComposer add 模式支持 preselectedChannelIds（名册多选预勾）', status: 'pending' },
                { content: 'App.selectionActions：createGroup / addToGroup 进抽屉，removeFromGroups 逐个走 IPC', status: 'pending' },
                { content: 'styles.css：复选框圆盘盖住头像与光环、session-pane 第三行网格、120ms 进场', status: 'pending' },
                { content: '旧版 usage 面板迁移（并入新会话页后不再需要）', status: 'cancelled' },
                { content: 'typecheck / vitest 全量 / knip / build / smoke:channel；ARCHITECTURE-LOG 追加记录', status: 'pending' },
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
// 统计页走查：?stats=1 —— 三个在册席位（CH-1 另有一个重建前的 Composer）+ 两个历史 Composer + 两个组，
// 账本铺满 30 天，小时（今天）与天（7/30 天）两种分桶、四桶构成、多模型分布、
// 席位 / 组 / 池三层与「旧会话」「历史会话」两种归属一次看全。
const statsPreviewMode = previewParameters.has('stats')
/** 统计页走查里「重建前的旧 Composer」带的席位标签 = CH-1 的席位 id（阶段 2 · 2E）。 */
let statsRebuiltSlotId: string | undefined
if (statsPreviewMode) {
  state.desktop.sessions = state.desktop.sessions.map((session) => session.channelId === '3'
    ? { ...session, composerId: 'composer-03' }
    : session)
  // 组层走查：CH-1 + CH-2 成「接口重构」、CH-3 成「验收」——分组卡 = 成员席位之和、条宽 = 占池份额；
  // 两个 hist-* 不属任何席位，池 > 组之和的差额即「历史会话」。
  if (initialTeam.activeRun) {
    const seatOf = (channelId: string): (typeof initialTeam.members)[number] =>
      initialTeam.members.find((member) => member.slot.channelId === channelId)!
    statsRebuiltSlotId = seatOf('1').slot.id
    const groupBase = {
      runId: initialTeam.activeRun.id, goal: '', planPolicy: 'lead_only' as const,
      createdAt: previewNow - 6 * 3_600_000, updatedAt: previewNow - 20 * 60_000
    }
    initialTeam.groups = [
      {
        group: { ...groupBase, id: 'team-group:stats:refactor', name: '接口重构', status: 'active', leadSlotId: seatOf('1').slot.id },
        members: [seatOf('1'), seatOf('2')], effectiveLeadSlotId: seatOf('1').slot.id, attention: false
      },
      {
        group: { ...groupBase, id: 'team-group:stats:acceptance', name: '验收', status: 'active', leadSlotId: seatOf('3').slot.id },
        members: [seatOf('3')], effectiveLeadSlotId: seatOf('3').slot.id, attention: false
      }
    ]
  }
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
  // [composerId, 模型, 回合的「几小时前」序列, 席位标签]：近端密（今天有小时节奏）、远端疏（30 天有形状）。
  const composers: Array<[string, string, number[], string?]> = [
    ['composer-01', 'claude-fable-5', [0.4, 1.3, 2.6, 3.2, 4.7, 6.3, 7.9, 9.4, 25, 29, 49, 74, 97, 121, 168, 240, 380, 520, 700]],
    ['composer-02', 'claude-fable-5', [0.8, 1.9, 3.5, 5.2, 8.3, 24, 48, 72, 120, 170, 238, 312, 430, 560]],
    ['composer-03', 'gpt-5-6-sol', [1.1, 2.3, 6.5, 26, 50, 95, 144, 199, 300]],
    // CH-1 重建前的 Composer：账上带席位标签，归本席位并在明细里标「旧会话」。
    ['composer-01-prev', 'claude-fable-5-1', [12, 15, 34, 58, 210], statsRebuiltSlotId],
    ['hist-4f2a9c1e', 'claude-fable-5-1', [128, 250, 405, 552, 640]],
    ['hist-b83d07aa', 'composer-2-5-fast', [88, 295, 630]]
  ]
  return Object.fromEntries(composers.map(([composerId, modelId, hoursAgo, slotId]) => {
    const turns = Object.fromEntries(hoursAgo.map((back, index) => [
      `gen-${composerId}-${index}`,
      previewStatsTurn(previewNow - Math.round(back * hour), modelId, 0.55 + ((index * 7) % 9) * 0.45)
    ]))
    return [composerId, projectUsage(composerId, { turns }, slotId)]
  }))
}

const previewTasks = structuredClone(taskPoolSnapshot)
const previewCollaboration = structuredClone(collaborationSnapshot)
if (collaborationMapScene && state.team.activeRun) {
  previewCollaboration.runId = state.team.activeRun.id; previewCollaboration.groupId = undefined
  previewCollaboration.messages = {}; previewCollaboration.messageOrder = []; previewCollaboration.threads = []; previewCollaboration.events = []
  previewTasks.runId = state.team.activeRun.id
}
if (previewParameters.has('teamContext')) {
  const group = state.team.groups.find(view => view.group.status === 'active')
  const runId = state.team.activeRun?.id
  if (group && runId) {
    const pool = new TaskPoolAggregate()
    const large = previewParameters.get('teamContext') === 'large'
    const titles = ['统一任务查询入口', '验证组作用域隔离', '审查成员交接边界', '补齐任务失败证据']
    const planned = pool.plan(runId, Array.from({length:large ? 85 : 4},(_,index)=>({key:`context-${index}`,title:titles[index%titles.length]!+(large ? ` · ${index+1}` : ''),acceptance:'旧组消息不串入新组；失败路径保留可定位的证据。',targetSlotId:group.members[index%group.members.length]?.slot.id})),group.group.id)
    const statuses = ['running','review','done','failed'] as const
    Object.assign(previewTasks,pool.snapshot(),{runId,workspaceId:state.team.activeWorkspaceId,scopeRevision:previewTasks.scopeRevision+1})
    for (const [index,task] of planned.entries()) {
      previewTasks.tasks[task.id]!.status=statuses[index%statuses.length]!
      if(previewTasks.tasks[task.id]!.status==='failed') previewTasks.tasks[task.id]!.failureReason='交接前后组归属发生变化，需要重新验证当前成员。'
    }
    previewCollaboration.runId=runId
    previewCollaboration.groupId=group.group.id
    previewCollaboration.threads=previewCollaboration.threads.map(thread=>({...thread,runId,groupId:group.group.id}))
    previewCollaboration.messages=Object.fromEntries(Object.entries(previewCollaboration.messages).map(([id,message])=>[id,{
      ...message,runId,groupId:group.group.id,
      sender:message.sender.type==='agent'?{type:'agent' as const,slotId:group.members[0]!.slot.id}:message.sender,
      recipient:message.recipient.type==='agent'?{type:'agent' as const,slotId:group.members.at(-1)!.slot.id}:message.recipient
    }]))
    if(previewParameters.get('teamContext')==='long') {
      group.group.name='接口重构与消息隔离 · 长名称验收'
      group.group.goal='检查路径 '+ 'src/really_long_unbroken_directory_name/'.repeat(8)+' 和成员切换边界，保留完整验收证据。'
      previewTasks.tasks[planned[0]!.id]!.title='src/'+ 'unbroken_module_name_'.repeat(12)+'index.ts'
      const first=Object.values(previewCollaboration.messages)[0]!
      first.content='## 验收记录\n\n**同组隔离**已完成，请核对以下长路径：\n\n`'+ 'src/unbroken_directory/'.repeat(12)+'`\n\n```ts\nconst stableIdentity = "'+ 'very_long_identifier'.repeat(15)+'"\n```'
    }
    if(large) {
      const sample=Object.values(previewCollaboration.messages)[0]!
      previewCollaboration.messages=Object.fromEntries(Array.from({length:65},(_,index)=>{
        const id=`context-message-${index}`
        return [id,{...sample,id,clientMessageId:id,createdAt:previewNow-(65-index)*60_000,content:`协作记录 ${index+1}：核对组目标、依赖和验收结果。`}]
      }))
      previewCollaboration.messageOrder=Object.keys(previewCollaboration.messages)
    }
  }
}
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
const taskListeners = new Set<Listener<typeof previewTasks>>()
const collaborationListeners = new Set<Listener<typeof previewCollaboration>>()
let mapMessageSequence = 0
function pushMapMessage(from: number, to: number, kind: TeamMessage['kind'] = 'status', ageMs = 0): void {
  const group = state.team.groups[0], sender = group?.members[from], recipient = group?.members[to]
  if (!group || !sender || !recipient || !state.team.activeRun) return
  const id = `map-message-${++mapMessageSequence}`, at = Date.now() - ageMs
  const message: TeamMessage = { id, clientMessageId: id, runId: state.team.activeRun.id, groupId: group.group.id, threadId: 'map-thread',
    sender: { type: 'agent', slotId: sender.slot.id }, recipient: { type: 'agent', slotId: recipient.slot.id }, kind,
    content: collaborationMapScene === 'image' ? `![协作验收图片](data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" rx="12" fill="#f2f5f9"/><path d="M90 250C160 250 190 90 310 90S440 250 550 250" fill="none" stroke="#5891aa" stroke-width="3"/><text x="70" y="310" fill="#3d4655" font-family="sans-serif" font-size="22">Interface boundary verification</text></svg>')})`
      : collaborationMapScene === 'long' ? `请核对 src/${'long_unbroken_module_name/'.repeat(14)}boundary.ts 的验收结论。` : kind === 'response' ? '接口边界验证通过，已返回检查结论。' : '请复核接口边界与组内消息隔离，保留验收证据。', createdAt: at,
    receipt: { notificationState: 'notified', notificationDetail: '', notifiedAt: at, readAt: at, updatedAt: at } }
  if (kind === 'response') {
    const original = [...previewCollaboration.messageOrder].reverse().map(key => previewCollaboration.messages[key]).find(item =>
      item && item.sender.type === 'agent' && item.recipient.type === 'agent' && item.sender.slotId === recipient.slot.id
      && item.recipient.slotId === sender.slot.id && teamMessageNeedsAgentResponse(item) && item.receipt.respondedAt === undefined)
    if (original) { message.replyToMessageId = original.id; original.receipt.respondedAt = at; original.receipt.responseMessageId = id; original.receipt.updatedAt = at }
  }
  previewCollaboration.messages[id] = message; previewCollaboration.messageOrder.push(id)
  previewCollaboration.revision++; previewCollaboration.updatedAt = Date.now()
  for (const listener of collaborationListeners) listener(structuredClone(previewCollaboration))
}
if (collaborationMapScene && collaborationMapScene !== 'empty') {
  pushMapMessage(0, 1, 'directive', 15_000); pushMapMessage(0, 2, 'question', 15_000)
  pushMapMessage(1, 3, 'status', 15_000); pushMapMessage(5, 1, 'response', 15_000)
  if (collaborationMapScene !== 'ended') pushMapMessage(2, 0, 'response')
  const timer = setInterval(() => {
    if (state.team.activeRun?.status !== 'running') return
    const pairs = [[0, 1], [2, 0], [1, 3], [5, 1], [0, 4]] as const
    const pair = pairs[mapMessageSequence % pairs.length]!
    pushMapMessage(pair[0], pair[1], mapMessageSequence % 2 ? 'response' : 'status')
  }, 4_200)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
  if (collaborationMapScene === 'end') setTimeout(() => {
    if (state.team.activeRun) state.team.activeRun.status = 'completed'
    state.team.revision++; pushTeam()
  }, 10_000)
  if (collaborationMapScene === 'switch') setTimeout(() => {
    if (state.team.activeRun) state.team.activeRun = { ...state.team.activeRun, id: `${state.team.activeRun.id}:next`, name: '新批次' }
    state.team.groups = []; state.team.members = []; state.team.revision++; pushTeam()
  }, 10_000)
  if (collaborationMapScene === 'transfer') setTimeout(() => {
    const group = state.team.groups[0]
    if (!group) return
    const member = group.members.find(item => item.slot.channelId === '3')
    if (!member) return
    const replacement = { ...member, slot: { ...member.slot, id: 'slot:map-3:replacement', groupJoinedAt: Date.now() },
      binding: member.binding ? { ...member.binding, slotId: 'slot:map-3:replacement', agentSessionId: 'session:map-3:replacement' } : undefined }
    state.team.members = state.team.members.map(item => item.slot.id === member.slot.id ? replacement : item)
    group.members = state.team.members
    state.team.slots = state.team.members.map(item => item.slot)
    state.team.bindings = state.team.members.flatMap(item => item.binding ? [item.binding] : [])
    state.desktop.sessions = state.desktop.sessions.map(item => item.channelId === '3' ? { ...item, id: 'session:map-3:replacement' } : item)
    state.team.revision++; pushTeam()
    for (const listener of desktopListeners) listener(structuredClone(state.desktop))
  }, 10_000)
}
let previewCursorAccounts: Array<{
  id: string; label: string; maskedToken: string; active: boolean; createdAt: number; updatedAt: number
  pendingMachineAlign?: boolean
  fingerprintProfileId?: string
  email?: string
  hasCredentials?: boolean
}> = [
  // 首个账号预置窗口绑定 + 卡号凭据：预览同时覆盖「已绑定 / 跟随默认」与「可自动登录 / 仅 Token」两种行形态
  { id: 'preview-acc-1', label: 'work@example.com', maskedToken: '••••9f2k', active: true, createdAt: previewNow - 40 * 60_000, updatedAt: previewNow - 5 * 60_000, fingerprintProfileId: 'bit-proxy', email: 'work@example.com', hasCredentials: true },
  { id: 'preview-acc-2', label: 'spare@example.com', maskedToken: '••••41qz', active: false, createdAt: previewNow - 90 * 60_000, updatedAt: previewNow - 30 * 60_000 },
  // 最满的一行：长邮箱 + 已绑窗口 + 热切后待对齐机器码——用来盯身份列的省略与元信息列的宽度预算
  { id: 'preview-acc-3', label: 'karimjebediah4454.workspace@outlook.com', maskedToken: '••••mmcs', active: false, createdAt: previewNow - 6 * 3_600_000, updatedAt: previewNow - 2 * 3_600_000, pendingMachineAlign: true, fingerprintProfileId: 'bit-direct' }
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

/**
 * 软件更新走查：?update=idle（默认）| up_to_date | available | downloading | downloaded | failed | offline | unsupported。
 * `available` 场景会让顶栏出现小提醒与齿轮角标；下载在预览里用假进度跑完。
 */
const previewUpdateScene = previewParameters.get('update') ?? 'idle'
const previewUpdateRelease: AppUpdateRelease = {
  version: '0.3.3',
  releaseDate: new Date(previewNow - 5 * 3_600_000).toISOString(),
  releaseName: '拾光 v0.3.3',
  releaseNotes: '## v0.3.3 更新\n- **软件更新**：设置页新增「软件更新」，Windows 可在应用内下载安装\n- 会话名册分组条改为书签形态\n- 修复用量弹层 Cache Write 行在无该桶模型下消失的问题',
  sizeBytes: 116_467_543,
  releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
}
function previewUpdateInitialState(): AppUpdateState {
  switch (previewUpdateScene) {
    case 'up_to_date': return { phase: 'up_to_date', checkedAt: previewNow - 12 * 60_000 }
    case 'available': return { phase: 'available', release: previewUpdateRelease, checkedAt: previewNow - 2 * 60_000 }
    case 'downloading': return { phase: 'downloading', release: previewUpdateRelease, receivedBytes: 48_300_000, totalBytes: 116_467_543, bytesPerSecond: 3_200_000, startedAt: previewNow - 15_000 }
    case 'downloaded': return { phase: 'downloaded', release: previewUpdateRelease, filePath: 'C:\\Users\\demo\\AppData\\Local\\shiguang-team-updater\\pending\\ShiGuang-Setup-0.3.3.exe', downloadedAt: previewNow - 60_000 }
    case 'failed': return { phase: 'failed', step: 'download', message: 'sha512 checksum mismatch, expected 5f2a… got 91c0…', at: previewNow - 30_000, release: previewUpdateRelease }
    // 网络类检查失败：中性呈现 + 退避重试的说明（真机上直连 GitHub 抽风的常态）。
    case 'offline': return { phase: 'idle', lastCheckedAt: previewNow - 3 * 60_000, lastError: 'net::ERR_CONNECTION_CLOSED', lastErrorKind: 'network' }
    case 'unsupported': return { phase: 'unsupported', reason: '此平台的应用内更新尚未提供：请到发布页下载新版后手动替换。' }
    default: return { phase: 'idle', lastCheckedAt: previewNow - 3 * 3_600_000 }
  }
}
let previewUpdateState: AppUpdateState = previewUpdateInitialState()
/** 经函数读取以躲开 TS 对模块级 let 的控制流收窄（下载循环里状态会被取消按钮改写）。 */
const currentPreviewUpdateState = (): AppUpdateState => previewUpdateState
let previewUpdateSettings: AppUpdateSettings = { autoCheck: true, checkIntervalHours: 6 }
const updateListeners = new Set<Listener<AppUpdateStatus>>()
/**
 * mac 分支的走查参数：?updated=1（Windows `--updated` 提示）| applied | rolled_back | apply_failed（脚本结果横幅）；
 * ?rollback=1 让卡片底部出现「回滚到 0.3.1」。
 */
const previewUpdatedParam = previewParameters.get('updated')
let previewApplyResult: AppUpdateApplyResult | undefined = previewUpdatedParam === 'applied'
  ? { status: 'applied', from: '0.3.1', to: '0.3.2', backupDir: '/Users/demo/Library/Application Support/sg-team/updates/backup/0.3.1-1789560000000' }
  : previewUpdatedParam === 'rolled_back'
    ? { status: 'rolled_back', from: '0.3.2', to: '0.3.1' }
    : previewUpdatedParam === 'apply_failed'
      ? { status: 'apply_failed', from: '0.3.1', to: '0.3.2', reason: 'codesign_failed' }
      : undefined
const previewRollback: AppUpdateBackupInfo | undefined = previewParameters.get('rollback') === '1'
  ? { version: '0.3.1', createdAt: previewNow - 26 * 3_600_000, dir: '/Users/demo/Library/Application Support/sg-team/updates/backup/0.3.1-1789560000000' }
  : undefined
function previewUpdateStatus(): AppUpdateStatus {
  const reminderVersion = appUpdateReminderVersion(previewUpdateState, previewUpdateSettings, Date.now())
  const release = 'release' in previewUpdateState ? previewUpdateState.release : undefined
  return {
    currentVersion: '0.3.2',
    state: previewUpdateState,
    settings: previewUpdateSettings,
    ...(reminderVersion ? { reminderVersion } : {}),
    launchedAfterUpdate: previewUpdatedParam === '1',
    ...(previewApplyResult ? { applyResult: previewApplyResult } : {}),
    ...(previewRollback ? { rollback: previewRollback } : {}),
    releaseUrl: release?.releaseUrl ?? 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.2'
  }
}
function pushUpdate(next: AppUpdateState = previewUpdateState): AppUpdateStatus {
  previewUpdateState = next
  const status = previewUpdateStatus()
  for (const listener of updateListeners) listener(structuredClone(status))
  notificationPreview.observeUpdate(status, true)
  return status
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

function updatePreviewGroup(groupId: string, update: (view: typeof state.team.groups[number]) => void): typeof state.team {
  const view=state.team.groups.find(candidate=>candidate.group.id===groupId&&candidate.group.status==='active')
  if(!view) throw new Error('协作组已不存在')
  update(view);view.group.updatedAt=Date.now();state.team.revision++;pushTeam()
  return structuredClone(state.team)
}

const notificationPreview = createNotificationPreview()
if (previewParameters.get('notifications') === 'native-content' && state.team.activeRun && state.team.groups[0]) {
  const run = state.team.activeRun, view = state.team.groups[0]!, at = Date.now() - 60000, key = 'group-topology:' + '1'.repeat(64)
  const fact = { id: view.group.id, identity: '2'.repeat(64), name: view.group.name, status: view.group.status,
    leadSlotId: view.effectiveLeadSlotId, planning: view.effectiveLeadSlotId ? 'lead' as const : 'members' as const,
    members: view.members.map(member => ({ slotId: member.slot.id, label: `${member.role.name} · CH-${member.slot.channelId}` })) }
  const before = reduceGroupTopologyNotifications(undefined, { key, workspaceId: run.workspaceId, runId: run.id, revision: 5, now: at,
    currentRead: true, readOwner: 'preview-native', readEpoch: 0, readSignature: 'a'.repeat(64), facts: [fact] }, true, 1)
  before.drafts.forEach(notificationPreview.offer)
  const changed = { ...fact, name: '接口联调与兼容复核' }
  view.group.name = changed.name // The original preview source corresponds to the returned current relation.
  reduceGroupTopologyNotifications(before.state, { key, workspaceId: run.workspaceId, runId: run.id, revision: 5, now: at + 1000,
    currentRead: true, readOwner: 'preview-native', readEpoch: 1, readSignature: 'b'.repeat(64), rebaseFrom: 5, rebaseTo: 5, facts: [changed] }, true, 2).drafts.forEach(notificationPreview.offer)
}
if (previewParameters.get('notifications') === 'usage-binding' && state.team.activeRun && state.team.activeWorkspaceId) {
  const key = 'usage-binding-health', scope = '1'.repeat(64), at = Date.now() - 60000
  const scopeRef = { workspaceId: state.team.activeWorkspaceId, runId: state.team.activeRun.id }
  const first = reduceUsageBindingNotifications(undefined, { key, scope, scopeRef, id: 'a'.repeat(64), at,
    fact: { state: 'failed', identity: '1'.repeat(64), channel: '1', reason: 'record' } }, true, 1)
  first.drafts.forEach(notificationPreview.offer)
  const second = reduceUsageBindingNotifications(first.state, { key, scope, scopeRef, id: 'b'.repeat(64), at: at + 1000,
    fact: { state: 'failed', identity: '2'.repeat(64), channel: '2', reason: 'callback' } }, true, 2)
  second.drafts.forEach(notificationPreview.offer)
  const phase = previewParameters.get('bindingReceive')
  if (phase === 'partial' || phase === 'recovered') {
    const partial = reduceUsageBindingNotifications(second.state, { key, scope, scopeRef, id: 'c'.repeat(64), at: at + 2000,
      fact: { state: 'ready', identity: '1'.repeat(64), channel: '1' } }, true, 3)
    partial.drafts.forEach(notificationPreview.offer)
    if (phase === 'recovered') reduceUsageBindingNotifications(partial.state, { key, scope, scopeRef, id: 'd'.repeat(64), at: at + 3000,
      fact: { state: 'ready', identity: '2'.repeat(64), channel: '2' } }, true, 4).drafts.forEach(notificationPreview.offer)
  }
  if (phase === 'changed') reduceUsageBindingNotifications(second.state, { key, scope: '2'.repeat(64), scopeRef, id: 'c'.repeat(64), at: at + 2000,
    fact: { state: 'scope' } }, true, 3).drafts.forEach(notificationPreview.offer)
}
if (previewParameters.get('notifications') === 'context-source') {
  const key = 'composer-context-health', scope = '1'.repeat(64), at = Date.now() - 60000
  const failed = reduceRuntimeUsageNotifications(undefined, { key, scope, id: 'a'.repeat(64), at, result: { state: 'failed', reason: 'record' } }, true, 1, 'context')
  failed.drafts.forEach(notificationPreview.offer)
  const next = previewParameters.get('contextRead')
  if (next === 'recovered' || next === 'changed') reduceRuntimeUsageNotifications(failed.state, { key,
    scope: next === 'changed' ? '2'.repeat(64) : scope, id: 'b'.repeat(64), at: at + 1000,
    result: next === 'changed' ? { state: 'scope' } : { state: 'ready' } }, true, 2, 'context').drafts.forEach(notificationPreview.offer)
}
if (previewParameters.get('notifications') === 'usage-runtime') {
  const key = 'runtime-usage-health', scope = '1'.repeat(64), at = Date.now() - 60000
  const failed = reduceRuntimeUsageNotifications(undefined, { key, scope, id: 'a'.repeat(64), at, result: { state: 'failed', reason: 'read' } }, true, 1)
  failed.drafts.forEach(notificationPreview.offer)
  const next = previewParameters.get('runtimeUsage')
  if (next === 'recovered' || next === 'changed') {
    reduceRuntimeUsageNotifications(failed.state, { key, scope: next === 'changed' ? '2'.repeat(64) : scope,
      id: 'b'.repeat(64), at: at + 1000, result: next === 'changed' ? { state: 'scope' } : { state: 'ready' } }, true, 2).drafts.forEach(notificationPreview.offer)
  }
}
if (previewParameters.get('notifications') === 'model-catalog') {
  const key = 'cursor-model-catalog-health', at = Date.now() - 60000
  const failed = reduceModelCatalogNotifications(undefined, { key, id: 'a'.repeat(64),
    fact: { state: 'failed', reason: 'record', at } }, true, 1)
  failed.drafts.forEach(notificationPreview.offer)
  if (previewParameters.get('modelCatalog') === 'recovered') {
    reduceModelCatalogNotifications(failed.state, { key, id: 'b'.repeat(64), fact: { state: 'ready', at: at + 1000 } }, true, 2).drafts.forEach(notificationPreview.offer)
  }
}
if (previewParameters.get('notifications') === 'usage-store') {
  const key = 'usage-storage-health', at = Date.now()-60000
  const history = reduceUsageStorageNotifications(undefined, { key, id: 'a'.repeat(64), at,
    fact: { kind: 'load', result: 'history-unconfirmed', reason: 'read', backupAvailable: true } }, true, 1)
  history.drafts.forEach(notificationPreview.offer)
  const write = reduceUsageStorageNotifications(history.state, { key, id: 'b'.repeat(64), at: at+1000,
    fact: { kind: 'save', result: 'unconfirmed', reason: 'permission' } }, true, 2)
  write.drafts.forEach(notificationPreview.offer)
  if (previewParameters.get('usageStore') === 'recovered') reduceUsageStorageNotifications(write.state, { key, id: 'c'.repeat(64), at: at+2000,
    fact: { kind: 'save', result: 'confirmed' } }, true, 3).drafts.forEach(notificationPreview.offer)
}
if (['mcp-write','mcp-legacy','source-history'].includes(previewParameters.get('notifications') ?? '') && state.team.activeRun) {
  const member = state.team.members.find(member => member.binding && state.desktop.sessions.some(session => session.channelId === member.binding!.channelId && session.composerId)), binding = member?.binding
  const session = state.desktop.sessions.find(session => session.channelId === binding?.channelId)
  if (member && binding && session) {
    binding.composerId = session.composerId // Explicit mock installation, not a production binding or probe.
    if (previewParameters.get('notifications') === 'mcp-legacy') binding.agentSessionId = `${binding.workspaceId}:ch-${binding.channelId}:${binding.generation}`
    const at = Date.now() - 30000, entryId = 'preview-mcp-write-entry'
    const scope = { workspaceId: binding.workspaceId, runId: binding.runId, slotId: member.slot.id,
      bindingGeneration: binding.generation, sessionId: session.id, channelId: session.channelId, generation: String(session.generation), composerId: session.composerId }
    const examples = [
      { tool: 'team_memory', args: { channel_id: session.channelId, action: 'propose' }, payload: { ok: false, agentSessionId: binding.agentSessionId, code: 'internal_error', sgWriteFailure: { version: 1, reason: 'storage' }, message: '隔离预览：原写入没有返回确认。' } },
      { tool: 'team_task', args: { channel_id: session.channelId, action: 'start', taskId: 'preview-task' }, payload: { ok: true, agentSessionId: binding.agentSessionId, action: 'start', task: { task: { id: 'preview-task' } }, coordinationWarning: '隔离预览：原任务已开始，协作记录未确认。' } }
    ]
    const blocks: ProcessBlock[] = examples.map((example, i) => ({ kind: 'tool', toolKind: 'mcp', id: `preview-mcp-write-${i}`, toolName: `mcp-SG Team-${example.tool}`,
      input: example.args, output: JSON.stringify(example.payload, null, 2), status: 'done', startedAt: at + i }))
    state.desktop.conversations[session.channelId] = [{ id: 'preview-mcp-write-user', channelId: session.channelId, role: 'user', source: 'desktop', status: 'complete', timestamp: at - 1000, text: '检查本轮协作写入的真实结果。' },
      { id: entryId, channelId: session.channelId, role: 'assistant', source: 'cursor', status: 'complete', timestamp: at + 1000,
        text: '原任务已经开始；后续协作记录尚未确认。记忆写入没有返回确认，不能据此认定未执行，也不要重复已成功的操作。', processBlocks: blocks }]
    const facts = examples.map((example, i) => ({ ...observedMcpWrite(`mcp-SG Team-${example.tool}`, example.args, JSON.stringify(example.payload))!,
      identity: String(i + 1).repeat(64), attentionKey: String(i + 1).repeat(64), blockId: blocks[i]!.id, entryId, at: at + i, name: `${session.roleName} · CH-${session.channelId}`, scope }))
    const input = { key: 'preview-mcp-write', facts, signature: 'isolated', now: at, monitorStartedAt: at }
    const projected = reduceMcpWriteNotifications(undefined, input, true, 1)
    if (previewParameters.get('notifications') === 'mcp-legacy') {
      const old = projected.drafts.map(draft => ({ ...draft, target: draft.target?.kind === 'session' ? { ...draft.target, mcpWrite: undefined } : draft.target }))
      old.forEach(notificationPreview.offer)
      reduceMcpWriteNotifications({ version: 1, key: input.key, seen: facts.map(f => f.identity), attentionFamilies: projected.state.attentionFamilies }, input, true, 2, old)
        .drafts.forEach(notificationPreview.offer)
    } else projected.drafts.forEach(notificationPreview.offer)
    if (previewParameters.get('notifications') === 'source-history' && facts[0]) {
      // Two actual native outputs, behind 230 newer unmounted records. A first-page-only observer cannot find them.
      const filler = Array.from({ length: 230 }, (_, index) => ({ ...facts[0]!, identity: (index + 1000).toString(16).padStart(64, '0'), attentionKey: (index + 2000).toString(16).padStart(64, '0'),
        blockId: `preview-unmounted-${index}`, at: at + index + 1 }))
      let previous: ReturnType<typeof reduceMcpWriteNotifications>['state'] | undefined
      for (let start = 0; start < filler.length; start += 100) {
        const value = reduceMcpWriteNotifications(previous, { key: 'preview-mcp-history', now: at, monitorStartedAt: at + 1000, signature: 'history', facts: filler.slice(start, start + 100) }, true, start + 2)
        previous = value.state; value.drafts.forEach(notificationPreview.offer)
      }
    }
  }
}
let previewMemoryIssueState: MemoryIssueState | undefined
let previewOperatorProof: MemoryOperatorReviewProof | undefined
const operatorMemoryScene = previewParameters.get('notifications') === 'operator-memory'
const previewMemoryFacts = () => Object.values(state.memory.items).filter(item => item.id === 'preview-memory-operator').map(item => ({
  identity: '5'.repeat(64), id: item.id, version: item.version, title: item.title, state: item.status === 'proposed' ? undefined : item.status,
  ...(item.status === 'proposed' && previewOperatorProof ? {operatorReview: previewOperatorProof} : {}),
  scope: {workspaceId: item.workspaceId, runId: item.runId, ...(item.groupId ? {groupId: item.groupId} : {})}, ceased: false
}))
if (operatorMemoryScene && state.team.activeRun) {
  const run = state.team.activeRun, exemplar = Object.values(state.memory.items)[0]!, groupId = state.team.groups[0]?.group.id
  const proposal = { ...exemplar, id: 'preview-memory-operator', workspaceId: run.workspaceId, runId: run.id, groupId, version: 2, status: 'proposed' as const,
    title: '发布前的接口兼容约定', supersedesId: undefined, supersededById: undefined, reviewNote: undefined, reviewedBy: undefined,
    content: '新版本继续保留原有字段与调用方式。新增能力只通过明确入口启用，不让普通读取触发业务操作。\n\n审核前请核对原引用；采纳后这项约定可被协作成员引用。' + (previewParameters.get('memoryLong')==='1' ? '\n\n长内容布局验收：'.repeat(80) : ''),
    sources: [{type: 'file' as const, ref: 'src/shared/interface.ts', label: '原接口约定'}, {type: 'file' as const, ref: 'tests/compatibility.test.ts', label: '兼容性回归'}] }
  state.memory.items = {[proposal.id]: proposal}; state.memory.itemOrder = [proposal.id]; state.memory.workspaceId = run.workspaceId; state.memory.runId = run.id; state.memory.revision = 4
  previewOperatorProof = {messageId:'preview-original-review-request',createdAt:Date.now()-120_000,reason:'no-reviewer',live:false}
  const projection = reduceMemoryIssueNotifications(undefined,{key:'preview-operator-memory',scope:{workspaceId:run.workspaceId,runId:run.id},revision:4,now:Date.now(),facts:previewMemoryFacts()},true,1)
  previewMemoryIssueState = projection.state
  projection.drafts.forEach(notificationPreview.offer)
}
const previewMemoryInspection = (request: TeamMemoryInspectionRequest) => {
  const item = state.memory.items[request.memoryId]
  if (!item || state.team.activeRun?.id !== request.runId || state.team.activeWorkspaceId !== request.workspaceId || item.version !== request.version || item.groupId !== request.groupId) throw Error('原记忆范围已变化')
  return structuredClone({item, ...(item.supersedesId && state.memory.items[item.supersedesId] ? {predecessor: state.memory.items[item.supersedesId]} : {}), observedAt:Date.now(),revision:state.memory.revision,
    ...(operatorMemoryScene && item.status === 'proposed' ? {operatorReview:previewOperatorProof,canReview:state.team.activeRun.status==='running'&&(!item.groupId||state.team.groups.some(view=>view.group.id===item.groupId&&view.group.status==='active'))} : {canReview:false})})
}
if (previewParameters.get('notifications') === 'group-effects' && state.team.activeRun && state.team.groups[0]) {
  const run=state.team.activeRun,group=state.team.groups[0].group
  const frame:GroupEffectsFrame={version:1,id:'ab000000-0000-4000-8000-000000000006',owner:'ab000000-0000-4000-8000-000000000007',kind:'goal',scope:{workspaceId:run.workspaceId,runId:run.id,groupId:group.id},name:group.name,primary:'returned',projection:'confirmed',phase:'completed',sequence:4,observedAt:Date.now()-60000,effects:[{kind:'goal-notice',channelId:'1',status:'recorded',count:1},{kind:'goal-notice',channelId:'2',status:'unconfirmed',reason:'storage'}]}
  const projected=reduceGroupEffects(undefined,{kind:'observe',frame},true,1)
  projected.drafts.forEach(notificationPreview.offer)
}
if (['memory','restore'].includes(previewParameters.get('notifications')??'') && state.team.activeRun) {
  const run = state.team.activeRun, groupId = state.team.groups[0]?.group.id, exemplar = Object.values(state.memory.items)[0]!
  const proposed = { ...exemplar, id: 'preview-memory-conflict', workspaceId: run.workspaceId, runId: run.id, groupId, version: 2, status: 'proposed' as const,
    title: '接口重构后的身份校验边界', content: '请求到达原处理入口后，按当前工作区和运行身份核对。\n\n未确认的旧请求不重放；记录阅读不会改变成员侧回执。', supersedesId: 'preview-memory-prior' }
  const prior = { ...proposed, id: 'preview-memory-prior', version: 1, status: 'superseded' as const, supersedesId: undefined, supersededById: 'preview-memory-other',
    title: '旧的身份校验约定', content: '此前只按通道标识对应当前对象。这条前置约定已被另一项修订取代。' }
  state.memory.items = { [proposed.id]: proposed, [prior.id]: prior }; state.memory.itemOrder = [proposed.id, prior.id]
  state.memory.workspaceId = run.workspaceId; state.memory.runId = run.id; state.memory.revision = 4
  const facts = [{ identity: '3'.repeat(64), id: proposed.id, version: proposed.version, title: proposed.title, state: 'conflict' as const,
    scope: { workspaceId: run.workspaceId, runId: run.id, ...(groupId ? { groupId } : {}) }, ceased: false }]
  const normal = { key: 'preview-memory', scope: {workspaceId: run.workspaceId, runId: run.id}, revision: 4, now: Date.now(), facts }
  const priorProjection = reduceMemoryIssueNotifications(undefined, { ...normal, revision: 20 }, true, 1)
  const rejected = reduceMemoryIssueNotifications(priorProjection.state, { ...normal, revision: 21, facts: facts.map(fact => ({ ...fact, state: 'rejected' as const })) }, false, 2)
  const result = previewParameters.get('notifications') === 'restore'
    ? reduceMemoryIssueNotifications(rejected.state, { ...normal, currentRead: true, readOwner: 'preview-current-read', readEpoch: 0 }, true, 3)
    : priorProjection
  result.drafts.forEach(notificationPreview.offer)
}
if (previewParameters.get('notifications') === 'compatibility') {
  const result = reduceCompatibilityNotifications(undefined,{key:'preview-compatibility',now:Date.now(),fact:{installationId:'4'.repeat(64),version:'3.21.12',compatibility:'supported',patch:'unsupported',profileRefreshReady:false}},true,1)
  result.drafts.forEach(notificationPreview.offer)
}

if (previewParameters.get('notifications') === 'context' && state.team.activeRun) {
  const channel = state.desktop.sessions[0]?.channelId, member = state.team.members.find(value => (value.binding?.channelId ?? value.slot.channelId) === channel)
  const session = state.desktop.sessions.find(value => value.channelId === channel)
  if (session && member?.binding) {
    const binding = member.binding, sampledAt = Date.now()
    session.composerId = binding.composerId ?? 'preview-context-composer'
    binding.composerId = session.composerId
    session.contextUsage = { ratio: .96, used: 960_000, limit: 1_000_000 }
    session.contextUsageSource = 'bound'; session.contextUsageComposerId = session.composerId; session.contextUsageModelId = 'preview-native-model'
    session.telemetry = { state: 'bound', detail: 'isolated preview native fact' }
    state.desktop.contextUsageSampledAt = sampledAt
    const scope = { workspaceId: state.team.activeWorkspaceId, runId: state.team.activeRun.id, slotId: member.slot.id, bindingGeneration: binding.generation,
      channelId: session.channelId, sessionId: session.id, composerId: session.composerId, generation: String(session.generation) }
    const projection = reduceContextThresholdNotifications(undefined,{key:'preview-context',completed:false,now:sampledAt,facts:[{
      identity:'1'.repeat(64),scope,name:session.roleName,domain:JSON.stringify(['preview-native-model',1_000_000]),domainKey:'2'.repeat(64),zone:'critical',ended:false
    }]},true,1)
    projection.drafts.forEach(notificationPreview.offer)
  }
}

function previewPageResult(kind: PageNotificationOperation, id: string | undefined, outcome: PageOperationOutcome) {
  const actualId = id ?? crypto.randomUUID()
  notificationPreview.offer(pageOperationNotification({ kind, id: actualId }, outcome, Date.now()))
  return pageOperationReference(kind, actualId)
}
if (['human','operator-read'].includes(previewParameters.get('notifications') ?? '') && state.team.activeRun && state.team.groups[0]) {
  const run = state.team.activeRun, group = state.team.groups[0], sender = group.members[0]!
  const message: TeamMessage = { id: 'preview:operator-message', runId: run.id, groupId: group.group.id, threadId: 'preview:operator-thread', clientMessageId: 'preview:operator-message',
    sender: { type: 'agent', slotId: sender.slot.id }, recipient: { type: 'operator' }, kind: 'question', createdAt: previewNow - 12_000,
    content: '接口边界检查已经完成。请确认下一步优先处理 Windows 兼容，还是继续梳理旧版本的恢复路径？\n\n此消息只发给你，阅读不会改写成员间的消息回执。',
    receipt: { notificationState: 'not_required', notificationDetail: '', updatedAt: previewNow - 12_000 } }
  previewCollaboration.messages[message.id] = message; previewCollaboration.messageOrder.push(message.id)
  const unrelated = { ...message, id: 'preview:operator-latest', clientMessageId: 'preview:operator-latest', kind: 'status' as const, createdAt: previewNow,
    content: '这是一条晚到的普通状态记录，不应该替换你正在看的原消息。' }
  previewCollaboration.messages[unrelated.id] = unrelated; previewCollaboration.messageOrder.push(unrelated.id)
  const subject = '确认后续方向'
  const project = (digest?: string) => {
    const projected = reduceOperatorMessages(digest ? { version: 2, key: 'preview:operator-source', seen: [], rebases: 7 } : undefined, { key: 'preview:operator-source', now: previewNow, facts: [{ id: message.id, kind: message.kind, at: message.createdAt,
      sender: sender.role.name, subject, scope: { workspaceId: run.workspaceId, runId: run.id, groupId: group.group.id }, ...(digest ? { digest } : {}) }] }, true, 1)
    projected.drafts.forEach(notificationPreview.offer)
  }
  if (previewParameters.get('notifications') === 'operator-read') {
    previewCollaboration.threads.push({ id: message.threadId, runId: run.id, groupId: group.group.id, subject, createdAt: message.createdAt, updatedAt: message.createdAt })
    // Same native metadata as production. Browser-only fixture; no account,
    // model, Agent receipt, notification read or business request is simulated.
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(operatorMessageNativeFields(message, subject))))
      .then(result => project([...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('')))
  } else project() // Keep the old fixed-event legacy scene for explicit-center reading checks.
}
notificationPreview.observeUpdate(previewUpdateStatus())
if (automationSceneRun?.operationId) {
  const draft = automationNotification(automationSceneRun, false, previewNow)
  if (draft) notificationPreview.offer(draft)
}
const api: SgDesktopApi = {
  ...notificationPreview.api,
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
  saveCursorAccountCard: async ({ card, notificationId }) => {
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
      const notification = previewPageResult('import-card', notificationId, { state: 'success', scope: { accountId: existing.id }, facts: ['隔离预览账号已更新。没有实际登录或切换。'] })
      return { accounts: structuredClone(previewCursorAccounts), outcome: 'updated' as const, accountId: existing.id, label: existing.label, notification }
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
    const partial = previewParameters.get('pageOutcome') === 'partial'
    const notification = previewPageResult('import-card', notificationId, { state: partial ? 'partial' : 'success', scope: { accountId: created.id }, facts: partial
      ? ['隔离预览：账号已保存，但登录未确认。此场景不执行任何真实登录。'] : ['隔离预览账号已保存，当前 Cursor 未被切换。'] })
    return { accounts: structuredClone(previewCursorAccounts), outcome: 'created' as const, accountId: created.id, label: created.label, notification,
      ...(partial ? { loginError: '隔离预览：原窗口登录结果待核对' } : {}) }
  },
  loginCursorAccount: async (accountId, reference) => {
    const at = Date.now()
    previewCursorAccounts = previewCursorAccounts.map((account) => (
      account.id === accountId ? { ...account, maskedToken: '••••rfrsh', updatedAt: at } : account
    ))
    const notification = previewPageResult('account-login', reference?.notificationId, { state: 'success', scope: { accountId }, facts: ['隔离预览网页登录完成；不涉及实际浏览器或账号。'] })
    return { accounts: structuredClone(previewCursorAccounts), outcome: 'logged_in' as const, notification }
  },
  // 预览停在提交前闸门（verified）：预览环境绝不模拟「已提交待付款」。
  startCursorProUpgrade: async (accountId, reference) => {
    const waiting = previewParameters.get('pageOutcome') === 'waiting'
    const notification = previewPageResult('checkout', reference?.notificationId, { state: waiting ? 'waiting' : 'success', verifiedOnly: !waiting, scope: { accountId }, facts: [waiting
      ? '隔离假数据结账入口已准备，未确认支付。没有实际账单或付款。' : '隔离预览仅复核表单，不提交付款。'] })
    return { outcome: waiting ? 'awaiting_payment' : 'verified', detail: waiting ? '隔离预览：请回原窗口核对，尚未确认付款（无真实支付）' : '账单资料已填写并复核通过；按测试闸门停在提交前（未生成付款二维码）', notification }
  },
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
  getCursorSwitchPumpStatus: async () => {
    if(previewParameters.get('notifications')==='compatibility')return{kind:'unsupported',installationId:'4'.repeat(64),compatibility:cursorCompatibilityForVersion('3.21.12'),profileRefreshReady:false,message:'当前安装的补丁运行体尚未通过检查；通知不会自动覆盖。'}
    const compatibility = cursorCompatibilityForVersion(previewParameters.get('cursorVersion') ?? '3.21.12')
    if (compatibility.state !== 'supported') return { kind: 'unsupported', message: compatibility.detail, compatibility }
    const status = pumpScene === 'external'
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
        })
    return { ...status, compatibility, profileRefreshReady: pumpScene !== 'profile-missing' }
  },
  ensureCursorSwitchPump: async reference => {
    const partial = previewParameters.get('pageOutcome') === 'partial', notification = previewPageResult('patch-install', reference?.notificationId,
      { state: partial ? 'partial' : 'success', unchanged: !partial, facts: [partial ? '隔离预览补丁文件已变化，但签名状态未确认。' : '隔离预览补丁无需改动。'] })
    return { ok: true, changed: partial, message: partial ? '隔离预览：补丁文件已变化' : '切号补丁已是当前配置', ...(partial ? { warning: '签名状态未确认' } : {}), notification }
  },
  removeCursorSwitchPump: async reference => ({ ok: true, changed: true, message: '切号补丁已卸载，重启 Cursor 生效。', notification: previewPageResult('patch-remove', reference?.notificationId, { state: 'success', facts: ['隔离预览仅模拟原结果，未改变 Cursor 文件。'] }) }),
  refreshCursorMembership: async () => ({ state: 'ok' as const, profile: { tier: 'pro' as const, raw: 'pro', trialEligible: false, isTeamMember: false, lastPaymentFailed: false, fetchedAt: Date.now() } }),
  refreshCursorAccountMemberships: async (accountIds) => Object.fromEntries(
    previewCursorAccounts
      .filter((account) => !accountIds || accountIds.includes(account.id))
      .map((account, index) => [account.id, {
        state: 'ok' as const,
        profile: { tier: index === 0 ? 'free' as const : 'pro' as const, raw: index === 0 ? 'free' : 'pro', fetchedAt: Date.now() }
      }])
  ),
  getProcessingProviderStatuses: async () => automationSceneRun || processingOnlyScene ? [
    { providerId: 'aozai' as const, label: '奥仔', saved: true, maskedCode: '••••6l8Q', unit: 'points' as const, remaining: 87, capacity: 100, costPerOperation: 3 },
    { providerId: 'henxin' as const, label: '痕心', saved: true, maskedCode: '••••CA23', unit: 'uses' as const, remaining: 5, capacity: 5, costPerOperation: 1 }
  ] : [
    { providerId: 'aozai' as const, label: '奥仔', unit: 'points' as const, saved: false },
    { providerId: 'henxin' as const, label: '痕心', unit: 'uses' as const, saved: false }
  ],
  saveProcessingCredential: async ({ providerId }) => providerId === 'henxin'
    ? { providerId, label: '痕心', saved: true, maskedCode: '••••CA23', unit: 'uses' as const, remaining: 5, capacity: 5, costPerOperation: 1 }
    : { providerId, label: '奥仔', saved: true, maskedCode: '••••6l8Q', unit: 'points' as const, remaining: 87, capacity: 100, costPerOperation: 3 },
  clearProcessingCredential: async (providerId) => ({ providerId, label: providerId === 'henxin' ? '痕心' : '奥仔', unit: providerId === 'henxin' ? 'uses' as const : 'points' as const, saved: false }),
  refreshProcessingBalance: async (providerId) => providerId === 'henxin'
    ? { providerId, label: '痕心', saved: true, maskedCode: '••••CA23', unit: 'uses' as const, remaining: 5, capacity: 5, costPerOperation: 1 }
    : { providerId, label: '奥仔', saved: true, maskedCode: '••••6l8Q', unit: 'points' as const, remaining: 87, capacity: 100, costPerOperation: 3 },
  processAccount: async ({ providerId }) => ({ providerId, ok: true, message: '处理成功', balance: { unit: providerId === 'henxin' ? 'uses' as const : 'points' as const, remaining: providerId === 'henxin' ? 4 : 84 } }),
  processToken: async ({ providerId }) => ({ providerId, ok: true, message: '处理成功', balance: { unit: providerId === 'henxin' ? 'uses' as const : 'points' as const, remaining: providerId === 'henxin' ? 4 : 84 } }),
  onProcessingProgress: () => () => {},
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
  getAppUpdateStatus: async () => previewUpdateStatus(),
  checkAppUpdate: async () => {
    if (previewUpdateState.phase === 'unsupported') return previewUpdateStatus()
    const release = 'release' in previewUpdateState ? previewUpdateState.release : undefined
    pushUpdate({ phase: 'checking', startedAt: Date.now(), ...(release ? { release } : {}) })
    await new Promise((resolve) => setTimeout(resolve, 700))
    return pushUpdate(previewUpdateScene === 'idle' || previewUpdateScene === 'up_to_date'
      ? { phase: 'up_to_date', checkedAt: Date.now() }
      : { phase: 'available', release: previewUpdateRelease, checkedAt: Date.now() })
  },
  downloadAppUpdate: async () => {
    if (previewUpdateState.phase !== 'available') return previewUpdateStatus()
    const release = previewUpdateState.release
    const total = release.sizeBytes ?? 100_000_000
    pushUpdate({ phase: 'downloading', release, receivedBytes: 0, totalBytes: total, startedAt: Date.now() })
    for (let step = 1; step <= 20; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      const live = currentPreviewUpdateState()
      if (live.phase !== 'downloading') return previewUpdateStatus()
      pushUpdate({ ...live, receivedBytes: Math.round(total * step / 20), bytesPerSecond: 4_800_000 })
    }
    return pushUpdate({ phase: 'downloaded', release, filePath: 'C:\\Users\\demo\\AppData\\Local\\shiguang-team-updater\\pending\\ShiGuang-Setup-0.3.3.exe', downloadedAt: Date.now() })
  },
  cancelAppUpdateDownload: async () => previewUpdateState.phase === 'downloading'
    ? pushUpdate({ phase: 'available', release: previewUpdateState.release, checkedAt: Date.now() })
    : previewUpdateStatus(),
  installAppUpdate: async ({ confirmed }) => {
    if (previewUpdateState.phase !== 'downloaded') return { gate: { verdict: 'allow' as const }, status: previewUpdateStatus() }
    const gate = evaluateUpdateGate({ onlineSeats: state.desktop.sessions.filter((session) => session.online).length, sessionLaunchRunning: false })
    if (gate.verdict === 'block' || (gate.verdict === 'confirm' && !confirmed)) return { gate, status: previewUpdateStatus() }
    return { gate, status: pushUpdate({ phase: 'installing', release: previewUpdateState.release, startedAt: Date.now() }) }
  },
  rollbackAppUpdate: async ({ confirmed }) => {
    if (!previewRollback) return { gate: { verdict: 'allow' as const }, status: previewUpdateStatus() }
    const gate = evaluateUpdateGate({ onlineSeats: state.desktop.sessions.filter((session) => session.online).length, sessionLaunchRunning: false })
    if (gate.verdict === 'block' || !confirmed) return { gate, status: previewUpdateStatus() }
    return { gate, status: pushUpdate({ phase: 'rolling_back', targetVersion: previewRollback.version, startedAt: Date.now() }) }
  },
  dismissAppUpdateApplyResult: async () => {
    previewApplyResult = undefined
    return pushUpdate()
  },
  skipAppUpdate: async () => {
    const release = 'release' in previewUpdateState ? previewUpdateState.release : undefined
    if (release) previewUpdateSettings = { ...previewUpdateSettings, skippedVersion: release.version }
    return pushUpdate()
  },
  unskipAppUpdate: async () => {
    const { skippedVersion: _skipped, ...rest } = previewUpdateSettings
    previewUpdateSettings = rest
    return pushUpdate()
  },
  snoozeAppUpdate: async (input) => {
    if (input?.expectedVersion && (!('release' in previewUpdateState) || previewUpdateState.release?.version !== input.expectedVersion)) throw new Error('更新状态已变化')
    previewUpdateSettings = { ...previewUpdateSettings, snoozedUntil: Date.now() + APP_UPDATE_SNOOZE_MS }
    return pushUpdate()
  },
  dismissAppUpdateFailure: async () => previewUpdateState.phase === 'failed'
    ? pushUpdate(previewUpdateState.release
        ? { phase: 'available', release: previewUpdateState.release, checkedAt: Date.now() }
        : { phase: 'idle', lastCheckedAt: Date.now() })
    : previewUpdateStatus(),
  saveAppUpdateSettings: async (settings) => {
    previewUpdateSettings = normalizeAppUpdateSettings(settings)
    return pushUpdate()
  },
  openAppUpdateReleasePage: async () => true,
  onAppUpdateStatus: (listener) => {
    updateListeners.add(listener)
    return () => { updateListeners.delete(listener) }
  },
  getAccountAutomationSettings: async () => ({ enabled: Boolean(automationSceneRun) || processingOnlyScene, delaySec: 10,
    postProcessDelaySec: 10, processingProvider: 'aozai' as const, ...(processingOnlyScene ? { postProcessingEnabled: false } : {}) }),
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
      // These legacy mock rows were already delivered in the non-queue fixture.
      // Production uses real delivered_at and never infers it from complete.
      [targetChannelId]: [...(state.desktop.conversations[targetChannelId] ?? []).map(value => value.role === 'user' && value.status === 'complete' && !value.heldForNextSession
        ? { ...value, deliveredAt: value.deliveredAt ?? value.timestamp } : value), entry]
    }
    state.desktop.sessions = state.desktop.sessions.map(value => value.channelId === targetChannelId ? { ...value, deliveryMode: 'queued', queueDepth: value.queueDepth + 1 } : value)
    pushDesktop()
    const id = Date.now().toString(16).padStart(32, '0'), session = state.desktop.sessions.find(value => value.channelId === targetChannelId)!
    const binding = state.team.members.find(value => value.binding?.channelId === targetChannelId)?.binding
    const scope = { sessionId: session.id, channelId: targetChannelId, composerId: session.composerId, generation: String(session.generation), bindingGeneration: binding?.generation,
      runId: state.team.activeRun?.id, workspaceId: state.team.activeWorkspaceId }
    const projected = reduceQueueNotifications(undefined, { key: 'preview:handoff', runId: state.team.activeRun?.id, workspaceId: state.team.activeWorkspaceId, now: entry.timestamp,
      facts: [{ id, entryId: entry.id, channelId: targetChannelId, phase: held ? 'held' : 'queued', at: entry.timestamp, scope }],
      annotations: [{ id, entryId: entry.id, channelId: targetChannelId, sourceChannelId, issuedAt: entry.timestamp, scope, transcript: 'older', recordWritten: true }] }, false, 1)
    projected.drafts.forEach(notificationPreview.offer)
    return {
      targetChannelId,
      held,
      transcriptPath: '/Users/preview/.cursor/projects/Users-preview-workspace/agent-transcripts/preview/preview.jsonl',
      recordPath: '/Users/preview/Library/Application Support/sg-team/handoff/CH-1-preview-20260904-200000.md',
      commandId: `preview-accepted-${entry.timestamp}`,
      issuedAt: entry.timestamp, entryId: entry.id, transcriptState: 'older',
      notification: { key: projected.drafts[0]!.key, eventId: projected.drafts[0]!.eventId }
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
      generation: 'g1', installedAt: Date.now(),
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
      preflight: { bridgeConnected: true, workspaceBound: true, mcpInstalled: true, blockers: [] },
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
  setTeamGroupLead: async ({groupId,slotId}) => updatePreviewGroup(groupId,view=>{
    if(slotId && !view.members.some(member=>member.slot.id===slotId)) throw new Error('所选主控不在组内')
    view.group.leadSlotId=slotId??undefined;view.group.actingLeadSlotId=undefined;view.effectiveLeadSlotId=slotId??undefined
  }),
  updateTeamGroupGoal: async ({groupId,goal}) => updatePreviewGroup(groupId,view=>{view.group.goal=goal}),
  setTeamGroupPlanPolicy: async ({groupId,planPolicy}) => updatePreviewGroup(groupId,view=>{view.group.planPolicy=planPolicy}),
  dissolveTeamGroup: async () => structuredClone(state.team),
  planTeamGroupTasks: async ({groupId,tasks}) => {
    const group=state.team.groups.find(view=>view.group.id===groupId&&view.group.status==='active')
    if(!group||state.team.activeRun?.status!=='running') throw new Error('当前协作组已不可规划')
    const pool=new TaskPoolAggregate(previewTasks)
    const planned=pool.plan(group.group.runId,tasks,groupId)
    Object.assign(previewTasks,pool.snapshot())
    for(const listener of taskListeners) listener(structuredClone(previewTasks))
    return structuredClone(planned)
  },
  getTeamCollaborationSnapshot: async () => structuredClone(previewCollaboration),
  getTeamMemoryInspection: async request => previewMemoryInspection(request),
  reviewTeamMemory: async request => {
    const original=previewMemoryInspection(request)
    if(!operatorMemoryScene||!original.canReview||request.confirmed!==true||!['accept','reject'].includes(request.decision))throw Error('preview only accepts its explicit fixture review')
    await new Promise(resolve=>setTimeout(resolve, previewParameters.get('memoryReview')==='slow'?1800:220))
    if(previewParameters.get('memoryReview')==='fail')throw Error('isolated preview unknown result')
    const item={...original.item,status:request.decision==='accept'?'accepted' as const:'rejected' as const,reviewedBy:{type:'operator' as const},reviewNote:request.note}
    state.memory.items[item.id]=item;state.memory.revision++
    const projection=reduceMemoryIssueNotifications(previewMemoryIssueState,{key:'preview-operator-memory',scope:{workspaceId:item.workspaceId,runId:item.runId},revision:state.memory.revision,now:Date.now(),facts:previewMemoryFacts()},false,state.memory.revision)
    previewMemoryIssueState=projection.state;projection.drafts.forEach(notificationPreview.offer)
    const partial=previewParameters.get('memoryReview')==='partial'
    const notification=previewPageResult(request.decision==='accept'?'memory-accept':'memory-reject',request.notificationId,{state:partial?'partial':'success',facts:[partial?'原结论已确认，展示刷新待核对；不重做审核。':'原结论已确认。附言和正文只保留在原条目。']})
    return{inspection:previewMemoryInspection(request),conclusion:item.status,...(partial?{inspectionPending:true}:{}),notification}
  },
  getMembershipTransferOptions: async (slotId) => {
    const view = state.team.groups.find((candidate) => (
      candidate.group.status === 'active' && candidate.members.some((member) => member.slot.id === slotId)
    ))
    const source = view?.members.find((member) => member.slot.id === slotId)
    if (!view || !source) throw new Error('该席位不在任何协作组内')
    return {
      runId: state.team.activeRun!.id,
      groupId: view.group.id,
      groupName: view.group.name,
      sourceSlotId: source.slot.id,
      sourceRoleName: source.role.name,
      sourceChannelId: source.binding?.channelId ?? source.slot.channelId,
      transfersLead: view.effectiveLeadSlotId === source.slot.id,
      candidates: state.team.members
        .filter((member) => member.slot.solo === true)
        .map((member) => {
          const online = member.runtime?.online === true
          return {
            slotId: member.slot.id,
            channelId: member.binding?.channelId ?? member.slot.channelId,
            roleName: member.role.name,
            avatarId: member.slot.avatarId,
            online,
            impact: online
              ? '在线独立席位：入组通知随它的下一次轮询到达'
              : '当前离线：通知与上下文会在其通道排队，等新会话上线后生效'
          }
        })
    }
  },
  // 预览版成员身份迁移：A 恢复独立、B 顶上 A 的组角色（lead 随迁）；绑定 / 令牌不动。
  transferMembership: async ({ groupId, fromSlotId, toSlotId }) => {
    const view = state.team.groups.find((candidate) => candidate.group.id === groupId)!
    const source = view.members.find((member) => member.slot.id === fromSlotId)!
    const target = state.team.members.find((member) => member.slot.id === toSlotId)!
    const transferredLead = view.effectiveLeadSlotId === fromSlotId
    const groupRole = { ...source.role }
    const restoredSource = {
      ...source,
      role: target.role,
      slot: { ...source.slot, solo: true, groupId: undefined, roleId: target.role.id, homeRoleId: undefined, groupJoinedAt: undefined }
    }
    const joinedTarget = {
      ...target,
      role: groupRole,
      slot: { ...target.slot, solo: false, groupId, roleId: groupRole.id, homeRoleId: target.slot.roleId, groupJoinedAt: Date.now() }
    }
    const failover = {
      id: 'team-handoff:membership:preview',
      workspaceId: source.binding?.workspaceId ?? 'preview',
      runId: state.team.activeRun!.id,
      slotId: source.slot.id,
      roleName: groupRole.name,
      fromChannelId: source.binding?.channelId ?? source.slot.channelId ?? '?',
      fromAgentSessionId: source.binding?.agentSessionId ?? '',
      toChannelId: target.binding?.channelId ?? target.slot.channelId,
      toAgentSessionId: target.binding?.agentSessionId,
      status: 'completed' as const,
      reason: 'manual_membership_transfer',
      taskIds: [],
      detectedAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now()
    }
    state.team = {
      ...state.team,
      revision: state.team.revision + 1,
      members: state.team.members.map((member) => (
        member.slot.id === fromSlotId ? restoredSource : member.slot.id === toSlotId ? joinedTarget : member
      )),
      groups: state.team.groups.map((candidate) => candidate.group.id === groupId
        ? {
            ...candidate,
            group: {
              ...candidate.group,
              leadSlotId: transferredLead ? toSlotId : candidate.group.leadSlotId,
              actingLeadSlotId: candidate.group.actingLeadSlotId === fromSlotId ? toSlotId : candidate.group.actingLeadSlotId
            },
            members: [...candidate.members.filter((member) => member.slot.id !== fromSlotId), joinedTarget],
            effectiveLeadSlotId: transferredLead ? toSlotId : candidate.effectiveLeadSlotId
          }
        : candidate),
      failovers: [failover, ...state.team.failovers]
    }
    pushTeam()
    return {
      transfer: {
        groupId,
        fromSlotId,
        toSlotId,
        toChannelId: failover.toChannelId,
        roleName: groupRole.name,
        transferredLead,
        failover,
        releasedTaskIds: []
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
    if (reviewScene === 'syntax') {
      return { ...base, state: 'ready', additions: 1, deletions: 1,
        files: [{ path: 'scripts/preview-shots.mjs', status: 'modified', staged: false, unstaged: true, additions: 1, deletions: 1 }] }
    }
    if (turnFilesScene) {
      // 前三个是本轮改过且 Git 已看到的；App.tsx 是与本轮无关的未提交改动（栏里不该出现）；
      // 正在写的 team-handoff-service.ts 故意不在这里 → 栏上那一行回退到过程块估算。
      const files: WorkspaceReviewSummary['files'] = [
        { path: 'src/domain/team-control.ts', status: 'modified', staged: false, unstaged: true, additions: 18, deletions: 20 },
        { path: 'src/mcp/index.ts', status: 'modified', staged: false, unstaged: true, additions: 22, deletions: 37 },
        { path: 'src/application/team-failover-service.ts', status: 'modified', staged: false, unstaged: true, additions: 27, deletions: 318 },
        ...(previewParameters.get('deep') === '1'
          ? [{ path: 'src/renderer/src/features/very-long-feature-module-name/components/nested/deeper/TurnFilesBarAccessibilityRegressionHarness.test.tsx', status: 'untracked' as const, staged: false, unstaged: true, additions: 164, deletions: 0 }]
          : []),
        { path: 'src/renderer/src/App.tsx', status: 'modified', staged: false, unstaged: true, additions: 3, deletions: 1 }
      ]
      return {
        ...base, state: 'ready',
        additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
        files
      }
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
  getWorkspaceReviewFile: async ({ path }) => reviewScene === 'syntax' ? ({
    state: 'ready', path, truncated: false,
    hunks: [{ header: '@@ -870,3 +870,3 @@', skippedBefore: 869, lines: [
      { kind: 'context', text: '  storage: railStorage({ colorMode: \'dark\' }),', oldLine: 870, newLine: 870 },
      { kind: 'deletion', text: "  name: 'session-continuation-archived-dark',", oldLine: 871 },
      { kind: 'addition', text: "  name: 'session-continuation-archived-light',", newLine: 871 },
      { kind: 'context', text: '  actions: [{ wait: 1_500 }]', oldLine: 872, newLine: 872 }
    ] }]
  }) : ({
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
  onTaskPoolSnapshot: (listener) => {taskListeners.add(listener);return()=>{taskListeners.delete(listener)}},
  onTeamControlSnapshot: (listener) => {
    teamListeners.add(listener)
    return () => teamListeners.delete(listener)
  },
  onTeamCollaborationSnapshot: listener => { collaborationListeners.add(listener); return () => collaborationListeners.delete(listener) }
}

window.sgDesktop = api
applyAppearancePreferences(readAppearancePreferences())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
