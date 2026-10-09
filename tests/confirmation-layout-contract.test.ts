import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = (name: string) => readFileSync(join(process.cwd(), 'src/renderer/src', name), 'utf8')
const rule = (source: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // An exact standalone selector matters: a dangling comma before .is-danger
  // must not count as owning the base confirmation frame.
  return source.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''
}

describe('inline confirmation frames own their layout and adapt without clipping', () => {
  it('keeps cleanup confirmation independent of results, with real insets and a neutral base', () => {
    const source = css('settings/settings.css')
    const base = rule(source, '.storage-cleanup__confirm')
    for (const declaration of ['min-width: 0', 'display: grid', 'gap: 12px', 'margin: 0 16px 12px',
      'padding: 12px 14px', 'border: 1px solid', 'border-radius: 10px', 'overflow-wrap: anywhere', '--readable-surface']) {
      expect(base).toContain(declaration)
    }
    expect(base).not.toContain('--red')
    expect(source).not.toMatch(/\.storage-cleanup__confirm,\s*\.storage-cleanup__confirm\.is-danger/)
    const danger = rule(source, '.storage-cleanup__confirm.is-danger')
    expect(danger).toContain('--red-border')
    expect(danger).toContain('--red-soft')
    // The result frame is still intact after decoupling the confirmation frame.
    expect(rule(source, '.storage-cleanup__result')).toContain('grid-template-columns:18px minmax(0,1fr) 30px')
  })

  it('allows cleanup text and actions to wrap while keeping size values aligned and readable', () => {
    const source = css('settings/settings.css')
    expect(rule(source, '.storage-cleanup__confirm-list li')).toContain('minmax(0, 1fr) auto')
    expect(rule(source, '.storage-cleanup__confirm-list li strong')).toContain('overflow-wrap: anywhere')
    expect(rule(source, '.storage-cleanup__confirm-list li span')).toContain('white-space: nowrap')
    for (const selector of ['.storage-cleanup__confirm-actions', '.storage-cleanup__actions']) {
      expect(rule(source, selector)).toContain('flex-wrap: wrap')
    }
    const button = rule(source, '.storage-cleanup__button')
    expect(button).toContain('max-width: 100%')
    expect(button).toContain('white-space: normal')
    expect(button).toContain('justify-content: center')
  })

  it('protects run and file-revert confirmations in narrow panes, rather than hiding their overflow', () => {
    const run = css('run/run.css'), inspector = css('workspace-inspector.css')
    expect(rule(run, '.run-sheet__body')).toContain('overflow-wrap: anywhere')
    expect(rule(run, '.run-sheet__actions')).toContain('flex-wrap: wrap')
    expect(rule(run, '.run-sheet__actions > button')).toContain('max-width: 100%')
    expect(rule(inspector, '.inspector-confirm div')).toContain('flex-wrap: wrap')
    const button = rule(inspector, '.inspector-confirm button')
    expect(button).toContain('max-width: 100%')
    expect(button).toContain('min-height: 28px')
    expect(button).not.toMatch(/(?:^|;)\s*height:/)
  })

  it('lets update and rollback reasons and action labels wrap inside their confirmation frame', () => {
    const source = css('settings/update.css')
    expect(rule(source, '.app-update__confirm')).toContain('overflow-wrap: anywhere')
    expect(rule(source, '.app-update__confirm .app-update__button')).toContain('white-space: normal')
    expect(rule(source, '.app-update__confirm .app-update__button')).toContain('max-width: 100%')
    expect(rule(source, '.app-update__actions')).toContain('flex-wrap: wrap')
  })

  it('stacks browser connection fields before their combined minimum columns, gap and insets can overflow', () => {
    const source = css('lobby/lobby.css'), row = rule(source, '.account-browser__connection-row')
    const columns = [...row.matchAll(/minmax\((\d+)px,/g)].map(match => Number(match[1]))
    expect(columns).toHaveLength(2)
    const gap = Number(row.match(/gap:\s*(\d+)px/)![1])
    const sidePadding = Number(row.match(/padding:\s*\d+px (\d+)px/)![1])
    const border = Number(row.match(/border:\s*(\d+)px/)![1])
    const breakpoint = Number(source.match(/@container account-browser-config \(max-width: (\d+)px\)/)![1])
    expect(breakpoint).toBeGreaterThanOrEqual(columns.reduce((sum, column) => sum + column, 0) + gap + 2 * sidePadding + 2 * border)
    expect(source).toMatch(/@container account-browser-config \(max-width: \d+px\)\s*\{\s*\.account-browser__connection-row\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/)
  })
})
