// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES } from '../src/domain/team-control'
import { AgentAvatar } from '../src/renderer/src/AgentAvatar'
import { BrandMark } from '../src/renderer/src/BrandMark'

describe('AgentAvatar', () => {
  it('ships eight distinct cartoon portraits and maps backend/product to their own identities', () => {
    expect(AGENT_AVATAR_IDS).toHaveLength(8)
    expect(AGENT_AVATAR_IDS[5]).toBe('researcher')
    for (const id of AGENT_AVATAR_IDS) expect(existsSync(resolve('src/renderer/public/avatars', `${id}.png`))).toBe(true)
    expect(TEAM_ROLE_TEMPLATES.find((role) => role.key === 'backend')?.avatarId).toBe('backend')
    expect(TEAM_ROLE_TEMPLATES.find((role) => role.key === 'product')?.avatarId).toBe('product')
  })
  it('uses a relative asset URL so packaged file:// pages can load generated portraits', () => {
    const markup = renderToStaticMarkup(
      <AgentAvatar avatarId="lead" name="主控协调" crowned />
    )

    expect(markup).toContain('src="./avatars/lead.png"')
    expect(markup).not.toContain('src="/avatars/lead.png"')
  })

  it('recovers when a different avatar follows one failed image load', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<AgentAvatar avatarId="lead" name="主控" />))
      await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
      expect(container.querySelector('img')).toBeNull()
      await act(async () => root.render(<AgentAvatar avatarId="backend" name="后端" />))
      expect(container.querySelector('img')?.getAttribute('src')).toBe('./avatars/backend.png')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('uses the same packaged-safe brand asset inside the application', () => {
    expect(renderToStaticMarkup(<BrandMark />)).toContain('src="./brand-shiguang.png"')
  })
})
