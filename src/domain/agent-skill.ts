export type AgentSkillScope = 'builtin' | 'project' | 'user'

export interface AssignedAgentSkill {
  id: string
  name: string
  description: string
  scope: AgentSkillScope
}
