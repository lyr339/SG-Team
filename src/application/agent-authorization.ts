export interface AgentAuthorizationIdentity {
  agentSessionId: string
  runId: string
  slotId?: string
  capabilities: string[]
  /** 所在协作组（会话池）；legacy 团队 run 的成员没有。任务 / 消息 / 记忆按它过滤。 */
  groupId?: string
}

export interface AgentRegistration {
  agentSessionId: string
  runtimeId?: string
  workspaceId: string
  channelId: string
  generation: string
  runId: string
  capabilities: string[]
}

export interface AgentRegistrationBatch {
  workspaceId: string
  generation: string
  runId: string
  agents: AgentRegistration[]
}

export interface AgentAuthorizer {
  assertAgentAuthorized(identity: AgentAuthorizationIdentity): void
}

export interface AgentRegistrationStore extends AgentAuthorizer {
  replaceWorkspaceAgentRegistrations(batch: AgentRegistrationBatch): void
}
