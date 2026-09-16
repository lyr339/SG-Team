import {
  AGENT_AVATAR_IDS,
  createConfiguredTeamBundle,
  TEAM_ROLE_TEMPLATES,
  type WorkspaceTeamBundle
} from '../src/domain/team-control'

/**
 * 测试夹具：一次性团队 run（`software-core-v1`，lead / builder / reviewer / specialist…）。
 *
 * 阶段 2 · 2B 起产品里没有创建团队 run 的入口（组建 / 启动 / 新一轮 / 改团队目标都已退役），但 legacy
 * 团队 run 的读路径（run 级 lead、无组作用域、归档历史）仍在，这些测试用它作为最省事的「lead + 成员」夹具。
 * 与旧 domain 版本的差别：run 直接是 `running`（没有 draft / ready / launching 了），团队目标随 bundle 写入。
 */
export function createDefaultTeamBundle(input: {
  workspaceId: string
  workspacePath: string
  workspaceName: string
  channelIds: string[]
  runKey?: string
  now?: number
  goal?: string
}): WorkspaceTeamBundle {
  // 与旧 domain 版本一致：去重、只留数字通道号、按数值升序分配 lead / builder / reviewer / specialist。
  const channelIds = [...new Set(input.channelIds.map((channelId) => channelId.trim()).filter((channelId) => /^\d+$/.test(channelId)))]
    .sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))
  const bundle = createConfiguredTeamBundle({
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    workspaceName: input.workspaceName,
    members: channelIds.map((channelId, index) => {
      const templateKey = index === 0 ? 'lead' : index === 1 ? 'builder' : index === 2 ? 'reviewer' : 'specialist'
      const template = TEAM_ROLE_TEMPLATES.find((candidate) => candidate.key === templateKey)!
      const avatarId = index < 3
        ? template.avatarId
        : AGENT_AVATAR_IDS[3 + ((index - 3) % (AGENT_AVATAR_IDS.length - 3))]!
      return { channelId, roleTemplateKey: templateKey, avatarId, skills: [] }
    }),
    runKey: input.runKey,
    now: input.now
  })
  bundle.run.status = 'running'
  bundle.run.goal = input.goal?.trim() ?? ''
  return bundle
}
