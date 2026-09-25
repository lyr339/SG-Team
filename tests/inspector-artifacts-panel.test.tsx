// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactsPanel } from '../src/renderer/src/inspector/ArtifactsPanel'
import type { ArtifactItem } from '../src/renderer/src/inspector/artifacts-view'

describe('ArtifactsPanel', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps a moved worktree image visible as a file card, and recovers when its source changes', async () => {
    let probe: { onerror: (() => void) | null } | undefined
    class ImageProbe {
      onerror: (() => void) | null = null
      set src(_value: string) { probe = this }
    }
    vi.stubGlobal('Image', ImageProbe)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const item: ArtifactItem = {
      id: 'image:report', kind: 'image', source: 'worktree', name: 'report.png', relativePath: 'report.png',
      attachment: { id: 'attachment:report', name: 'report.png', mimeType: 'image/png', size: 0, previewUrl: 'sg-image://first' }
    }
    await act(async () => root.render(<ArtifactsPanel view={{ images: [item], files: [] }} />))
    await act(async () => probe?.onerror?.())
    expect(container.querySelector('.artifact-card')).not.toBeNull()
    expect(container.textContent).toContain('预览暂不可用')
    expect(container.querySelector('[aria-label="在编辑器中打开 report.png"]')).not.toBeNull()

    await act(async () => root.render(<ArtifactsPanel view={{ images: [{ ...item, attachment: { ...item.attachment, previewUrl: 'sg-image://second' } }], files: [] }} />))
    expect(container.querySelector('.artifact-card__unavailable')).toBeNull()
    expect(container.querySelector('.artifact-card__image')).not.toBeNull()
    await act(async () => root.unmount())
    container.remove()
  })
})
