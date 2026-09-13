import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import { attachmentNameFor, ComposerWorkbench, filesFromTransfer } from '../src/renderer/src/ComposerWorkbench'

const session: AgentSession = {
  id: 'session-1',
  channelId: '2',
  generation: 1,
  displayName: '架构实现',
  roleName: '实现席',
  status: 'waiting',
  currentTask: '',
  queueDepth: 0,
  connectionPhase: 'keepalive',
  online: true,
  connected: true,
  waiting: true,
  workingFiles: [],
  healthEvidence: [],
  telemetry: { state: 'bound', detail: 'Cursor 已绑定' }
}

describe('ComposerWorkbench', () => {
  it.each([
    ['claude-fable-5.1', 'anthropic'], ['gpt-5.6', 'openai'], ['gemini-pro', 'google'],
    ['grok', 'xai'], ['kimi-k3', 'moonshot'], ['glm', 'zhipu'], ['composer', 'cursor'],
    ['auto', 'auto'], ['custom-model', 'other']
  ])('adds the matching decorative logo for %s without inventing configuration', (modelName, provider) => {
    const html = renderToStaticMarkup(<ComposerWorkbench session={{ ...session, modelName }}
      draft="" canSend notWaiting={false} submitting={false} sendError="" onDraftChange={() => {}} onSubmit={() => {}} />)
    const plaque = html.match(/<div class="composer-model [\s\S]*?<\/div>/)![0]
    expect(plaque).toContain(`data-provider="${provider}"`)
    expect(plaque).toContain('aria-hidden="true"')
    expect(plaque).not.toContain('<button')
    expect(plaque).not.toContain('<i ')
    expect(plaque).not.toContain('composer-model-params')
  })

  it('preserves actual parameter labels and distinguishes reasoning Max from Max Mode', () => {
    const html = renderToStaticMarkup(<ComposerWorkbench session={{ ...session, executionProfile: {
      scope: 'cursor-composer-current', modelId: 'gpt-5.6', displayName: 'GPT-5.6',
      options: ['Max Mode', 'Max', '1M', 'Think', 'Fast'], maxMode: true
    } }} draft="" canSend notWaiting={false} submitting={false} sendError="" onDraftChange={() => {}} onSubmit={() => {}} />)
    expect(html).toContain('class="is-effort">Max</i>')
    expect(html).toContain('class="is-max">Max Mode</i>')
    expect(html).toContain('class="is-context">1M</i>')
    expect(html).toContain('class="is-think">Think</i>')
    expect(html).toContain('class="is-fast">Fast</i>')
  })

  it('renders the focused composer toolbar, duration and attached files', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={session}
        draft="当前草稿"
        canSend
        notWaiting={false}
        submitting={false}
        sendError=""
        onDraftChange={() => {}}
        onSubmit={() => {}}
        attachments={[{
          id: 'att-1',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 2048,
          data: 'IyByZXBvcnQ='
        }]}
        onAttachmentsChange={() => {}}
      />
    )

    expect(html).not.toContain('composer-quick-prompts')
    expect(html).toContain('title="添加图片或文件附件"')
    expect(html).toContain('report.md')
    expect(html).toContain('2.0 KB')
    expect(html).not.toContain('session-usage')
    expect(html).not.toContain('composer-binding-status')
    // 队列呈现已整体移到时间线与输入区之间的待投递托盘（QueuedMessageTray），工作台不再画队列。
    expect(html).not.toContain('composer-queue')
    expect(html).toContain('composer-duration is-running')
    expect(html).toContain('composer-duration__text')
    expect(html).toContain('aria-label="会话运行时间：')
  })

  it('renders send errors as alerts without hiding the draft', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={{ ...session, online: false, connected: false, status: 'offline' }}
        draft="稍后发送"
        canSend={false}
        notWaiting={false}
        submitting={false}
        sendError="Agent 当前离线"
        onDraftChange={() => {}}
        onSubmit={() => {}}
      />
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('Agent 当前离线')
    expect(html).toContain('稍后发送')
    expect(html).toContain('composer-duration is-inactive')
  })

  it('uses the current project name as the composer chip primary label', () => {
    const html = renderToStaticMarkup(
      <ComposerWorkbench
        session={{ ...session, online: false, connected: false, status: 'offline', deliveryMode: 'queued' }}
        currentProjectName="demo-app"
        draft=""
        canSend
        notWaiting={false}
        submitting={false}
        sendError=""
        onDraftChange={() => {}}
        onSubmit={() => {}}
      />
    )

    expect(html).toContain('<strong>demo-app</strong>')
    expect(html).toContain('Agent 离线')
    expect(html).not.toContain('<strong>Agent 离线</strong>')
  })

  it('extracts copied or dropped files from DataTransfer files first', () => {
    const copied = { name: 'copied.png', type: 'image/png', size: 12 } as File
    const item = { name: 'item.png', type: 'image/png', size: 18 } as File
    expect(filesFromTransfer({
      files: [copied],
      items: [{ kind: 'file', getAsFile: () => item }]
    })).toEqual([copied])
  })

  it('falls back to DataTransfer items for clipboard images', () => {
    const image = { name: '', type: 'image/png', size: 32 } as File
    expect(filesFromTransfer({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => image }
      ]
    })).toEqual([image])
    expect(attachmentNameFor(image, 0)).toBe('clipboard-image-1.png')
  })

  it('prefers clipboard file payloads when text/plain is present in the same paste', () => {
    const image = { name: 'shot.png', type: 'image/png', size: 11 } as File
    const fallback = { name: 'fallback.png', type: 'image/png', size: 12 } as File
    expect(filesFromTransfer({
      files: [image],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => fallback }
      ]
    })).toEqual([image])
  })
})
