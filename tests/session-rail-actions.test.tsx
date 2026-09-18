// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { SessionSidebar } from '../src/renderer/src/SessionSidebar'
import {
  partitionClearedSessions,
  persistClearedSessions,
  readClearedSessions
} from '../src/renderer/src/session-rail-hidden'

/**
 * 名册行悬停操作层（置顶 / 清除）：置顶复用同状态段重排机制并持久化；
 * 清除是微信式「不显示」（只对离线行，数据不动，复活自愈，可一键恢复）。
 */

const ORDER_KEY = 'shiguang.sessionOrder.v1'
const CLEARED_KEY = 'shiguang.sessionRail.cleared.v1'

interface SeatShape {
  id: string
  online?: boolean
  waiting?: boolean
  status?: string
  connectionPhase?: string
}

function snapshotWith(states: SeatShape[]): DesktopSnapshot {
  return {
    connection: { state: 'connected' },
    sessions: states.map((state, index) => ({
      id: state.id,
      channelId: String(index + 1),
      displayName: `CH-${index + 1}`,
      online: state.online ?? true,
      waiting: state.waiting ?? true,
      connectionPhase: state.connectionPhase ?? 'waiting',
      status: state.status ?? 'waiting'
    }))
  } as unknown as DesktopSnapshot
}

describe('session-rail-hidden 纯函数', () => {
  beforeEach(() => localStorage.clear())

  it('只有仍离线的清除项隐藏；回到线上的行可见且从名单收敛掉', () => {
    const sessions = [
      { id: 'dead', online: false },
      { id: 'alive', online: true },
      { id: 'other', online: true }
    ]
    const { visible, hidden, prunedIds } = partitionClearedSessions(sessions, ['dead', 'alive', 'gone'], {
      idOf: (session) => session.id,
      isOffline: (session) => !session.online
    })
    expect(visible.map((session) => session.id)).toEqual(['alive', 'other'])
    expect(hidden.map((session) => session.id)).toEqual(['dead'])
    // alive 已复活、gone 已离开名册：名单收敛后只剩 dead。
    expect(prunedIds).toEqual(['dead'])
  })

  it('读写防御：坏数据静默忽略，去重限长', () => {
    localStorage.setItem(CLEARED_KEY, '{broken')
    expect(readClearedSessions()).toEqual([])
    persistClearedSessions(['a', 'a', 'b'])
    expect(readClearedSessions()).toEqual(['a', 'b'])
  })
})

describe('SessionSidebar 悬停操作层', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
  })

  const render = (snapshot: DesktopSnapshot, selectedChannelId?: string): void => {
    act(() => {
      root.render(
        <SessionSidebar snapshot={snapshot} selectedChannelId={selectedChannelId} onSelectSession={() => {}} />
      )
    })
  }

  const rowNames = (): string[] => Array.from(container.querySelectorAll('.session-row__name'))
    .map((node) => node.textContent ?? '')

  it('置顶把行移到同状态段最前并持久化；段首行与独占一段的行不出现置顶钮', () => {
    render(snapshotWith([{ id: 'a' }, { id: 'b' }, { id: 'c' }]))
    expect(rowNames()).toEqual(['CH-1', 'CH-2', 'CH-3'])

    // 段首行（CH-1）没有置顶钮；其余行有。
    expect(container.querySelector('[aria-label="置顶 CH-1"]')).toBeNull()
    const pinC = container.querySelector<HTMLButtonElement>('[aria-label="置顶 CH-3"]')
    expect(pinC).not.toBeNull()
    act(() => pinC!.click())
    expect(rowNames()).toEqual(['CH-3', 'CH-1', 'CH-2'])
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]')[0]).toBe('c')

    // 置顶后原行到段首，自己的置顶钮消失，其余行仍可置顶。
    expect(container.querySelector('[aria-label="置顶 CH-3"]')).toBeNull()
    expect(container.querySelector('[aria-label="置顶 CH-1"]')).not.toBeNull()
  })

  it('独占一段的行没有任何重排入口', () => {
    render(snapshotWith([
      { id: 'busy', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'idle' }
    ]))
    // busy 与 idle 各自独占状态段：都没有置顶钮。
    expect(container.querySelector('.session-row-actions__button[aria-label^="置顶"]')).toBeNull()
  })

  it('清除只对离线行开放：行隐藏、可一键恢复；在线行没有清除钮', () => {
    const snapshot = snapshotWith([
      { id: 'alive' },
      { id: 'dead', online: false, waiting: false, status: 'stopped', connectionPhase: 'closed' }
    ])
    render(snapshot)
    expect(container.querySelector('[aria-label="清除 CH-1"]')).toBeNull()
    const clear = container.querySelector<HTMLButtonElement>('[aria-label="清除 CH-2"]')
    expect(clear).not.toBeNull()

    act(() => clear!.click())
    expect(rowNames()).toEqual(['CH-1'])
    expect(readClearedSessions()).toEqual(['dead'])
    const restore = container.querySelector<HTMLButtonElement>('.session-list__restore')
    expect(restore?.textContent).toContain('已清除 1 条离线会话')

    act(() => restore!.click())
    expect(rowNames()).toEqual(['CH-1', 'CH-2'])
    expect(readClearedSessions()).toEqual([])
    expect(container.querySelector('.session-list__restore')).toBeNull()
  })

  it('正在查看的离线行不能清除（按钮禁用并解释）', () => {
    render(snapshotWith([
      { id: 'alive' },
      { id: 'dead', online: false, waiting: false, status: 'stopped', connectionPhase: 'closed' }
    ]), '2')
    const clear = container.querySelector<HTMLButtonElement>('[aria-label="清除 CH-2"]')
    expect(clear?.disabled).toBe(true)
    expect(clear?.title).toContain('先切换到其他会话')
  })

  it('被清除的席位重新上线即自愈可见，名单同步收敛', () => {
    persistClearedSessions(['seat'])
    render(snapshotWith([{ id: 'seat', online: true }]))
    expect(rowNames()).toEqual(['CH-1'])
    expect(container.querySelector('.session-list__restore')).toBeNull()
    expect(readClearedSessions()).toEqual([])
  })
})
