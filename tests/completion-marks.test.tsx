// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FeedbackIcon } from '../src/renderer/src/feedback/FeedbackIcon'
import { TodoIndicator, todoTone } from '../src/renderer/src/TodoIndicator'
import { AutomationRunCard } from '../src/renderer/src/settings/AutomationRunCard'

const element = (html: string) => { const host = document.createElement('div'); host.innerHTML = html; return host }
const source = (file: string) => readFileSync(join(process.cwd(), 'src/renderer/src', file), 'utf8')
describe('shared outlined completion mark', () => {
  it('uses exactly the reference circle and tick for completed Todos in both consumers', () => {
    const reference = element(renderToStaticMarkup(<FeedbackIcon tone="success" />))
    const todo = element(renderToStaticMarkup(<TodoIndicator tone="completed" />))
    const svg = todo.querySelector('.feedback-icon.is-success')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 20 20')
    expect(svg.innerHTML).toBe(reference.querySelector('svg')!.innerHTML)
    expect(svg.querySelectorAll('circle')).toHaveLength(1)
    expect(svg.querySelectorAll('path')).toHaveLength(1)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    for (const file of ['inspector/PlanPanel.tsx', 'ProcessTurnCard.tsx']) expect(source(file)).toContain('<TodoIndicator tone={tone}')
  })
  it('never paints pending, cancelled, running or unrecognized Todo states as successful', () => {
    for (const status of ['pending', 'in_progress', 'running', 'cancelled', 'unexpected']) {
      const host = element(renderToStaticMarkup(<TodoIndicator tone={todoTone(status)} />))
      expect(host.querySelector('.is-success')).toBeNull()
    }
  })
  it('marks only genuinely done automation stages, not skipped or unknown downstream work', () => {
    const host = element(renderToStaticMarkup(<AutomationRunCard run={{ phase: 'done', startedAt: 1, finishedAt: 2, postProcessingEnabled: false, message: '仅处理完成' }} />))
    expect(host.querySelectorAll('.automation-run__stage.is-done')).toHaveLength(2)
    expect(host.querySelectorAll('.automation-run__stage.is-done .feedback-icon.is-success')).toHaveLength(2)
    expect(host.querySelectorAll('.automation-run__stage.is-skipped .feedback-icon.is-success')).toHaveLength(0)
    expect(host.querySelectorAll('.automation-run__node.is-done circle')).toHaveLength(2)
  })
  it('keeps success marks readable instead of dimming them with the struck-through task text', () => {
    const styles = source('styles.css'), inspector = source('workspace-inspector.css'), settings = source('settings/settings.css')
    expect(styles).not.toMatch(/\.process-turn-step__todos li\.is-completed\s*\{[^}]*opacity/)
    expect(styles).toContain('.process-turn-step__todos li.is-completed .todo-text')
    expect(inspector).toMatch(/\.inspector-plan__list li\.is-completed \.todo-indicator\s*\{[^}]*opacity:1/)
    expect(settings).not.toMatch(/\.automation-run__node\.is-done\s*\{[^}]*box-shadow/)
    expect(source('team/GroupContextPanel.tsx')).toContain("task.status === 'done' ? <FeedbackIcon tone=\"success\"")
    expect(source('ProcessTurnCard.tsx')).toContain("model.status === 'done' ? <FeedbackIcon tone=\"success\"")
  })
})
