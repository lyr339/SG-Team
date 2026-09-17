// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { SessionSidebar } from '../src/renderer/src/SessionSidebar'
import type { RailGroupSource } from '../src/renderer/src/session-rail-view'
import {
  applySessionOrder,
  moveSessionToBoundary,
  moveSessionWithinGroup,
  persistSessionOrder,
  readSessionOrder
} from '../src/renderer/src/session-order'

const sessions = (ids: string[]) => ids.map((id, index) => ({
  id,
  channelId: String(index + 1),
  displayName: `CH-${index + 1}`,
  online: true,
  waiting: true,
  connectionPhase: 'waiting',
  status: 'waiting' as const
}))

function snapshotOf(ids: string[]): DesktopSnapshot {
  return {
    sessions: sessions(ids) as DesktopSnapshot['sessions'],
    connection: { state: 'connected' }
  } as unknown as DesktopSnapshot
}

function snapshotWith(states: Array<{ id: string } & Partial<DesktopSnapshot['sessions'][number]>>): DesktopSnapshot {
  const snapshot = snapshotOf(states.map((state) => state.id))
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session, index) => ({ ...session, ...states[index] }))
  }
}

describe('session-order 纯函数', () => {
  it('手动顺序优先，未知会话（新席位）按快照原序排在已知之后', () => {
    const ordered = applySessionOrder(
      sessions(['a', 'b', 'new-1', 'c', 'new-2']),
      ['c', 'b', 'a'],
      (session) => session.id
    )
    expect(ordered.map((session) => session.id)).toEqual(['c', 'b', 'a', 'new-1', 'new-2'])
  })

  it('无持久化顺序时原样返回副本', () => {
    const input = sessions(['a', 'b'])
    const ordered = applySessionOrder(input, undefined, (session) => session.id)
    expect(ordered.map((session) => session.id)).toEqual(['a', 'b'])
    expect(ordered).not.toBe(input)
  })

  it('坏数据静默忽略，去重并限长', () => {
    localStorage.setItem('shiguang.sessionOrder.v1', '{not-json')
    expect(readSessionOrder()).toBeUndefined()
    localStorage.setItem('shiguang.sessionOrder.v1', JSON.stringify(['a', 'a', null, 42, 'b']))
    expect(readSessionOrder()).toEqual(['a', 'b'])
    persistSessionOrder(['x', 'x', 'y'])
    expect(readSessionOrder()).toEqual(['x', 'y'])
    localStorage.clear()
  })

  it('按 N + 1 个边界移动，并校正源卡片移除后的索引', () => {
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c'])
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a'])
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c'])
  })

  it('组内重排只替换该组占据的全局槽位', () => {
    expect(moveSessionWithinGroup(['a', 'x', 'b', 'y'], ['a', 'b'], 'b', 0)).toEqual(['b', 'x', 'a', 'y'])
  })
})

/** jsdom 不实现原生 DnD：合成 dataTransfer 存根的 drag 事件。 */
function dragEvent(type: string, clientY = 0, clientX = 100): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const store = new Map<string, string>()
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY }
  })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (format: string, value: string) => store.set(format, value),
      getData: (format: string) => store.get(format) ?? ''
    }
  })
  return event
}

function rect(top: number, bottom: number, left = 0, right = 300): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({})
  }
}

function mockSessionListGeometry(container: HTMLElement): {
  list: HTMLElement
  slots: HTMLElement[]
} {
  const scroller = container.querySelector<HTMLElement>('.session-list')!
  const list = container.querySelector<HTMLElement>('.session-group__list')!
  const slots = Array.from(container.querySelectorAll<HTMLElement>('.session-list__slot'))
  Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 500) })
  Object.defineProperty(list, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 500) })
  slots.forEach((slot, index) => {
    const top = 10 + index * 100
    Object.defineProperty(slot, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(top, top + 80)
    })
  })
  return { list, slots }
}

describe('SessionSidebar 拖拽重排', () => {
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

  async function render(ids = ['a', 'b', 'c']): Promise<void> {
    await renderSnapshot(snapshotOf(ids))
  }

  async function renderSnapshot(snapshot: DesktopSnapshot, groups?: readonly RailGroupSource[]): Promise<void> {
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={snapshot}
          selectedChannelId="1"
          onSelectSession={() => {}}
          groups={groups}
        />
      )
    })
  }

  const section = (id: string): HTMLElement => container.querySelector<HTMLElement>(`.session-group[data-section="${id}"]`)!
  const headerOf = (id: string): HTMLButtonElement => section(id).querySelector<HTMLButtonElement>('.session-group__header')!
  const rowNames = (): Array<string | null | undefined> => Array.from(container.querySelectorAll('.session-row'))
    .map((row) => row.querySelector('.session-row__name')?.textContent)

  it('逐通道传递实时活动与 Cursor 侧事实；更新不串席位，离线行常驻为 Completed 且不影响卡片选择', async () => {
    const snapshot = snapshotWith([
      { id: 'a', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'b', status: 'running', waiting: false, connectionPhase: 'processing' }
    ])
    snapshot.liveProcess = {
      '1': { turn: 't1', generating: true, startedAt: 1, updatedAt: 2,
        blocks: [{ kind: 'tool', id: 'a-read', toolName: 'read_file_v2', toolKind: 'read', summary: 'only-a.ts', status: 'running' }] },
      '2': { turn: 't2', generating: true, startedAt: 1, updatedAt: 2,
        blocks: [{ kind: 'thinking', id: 'b-think', text: 'B 的思考', status: 'running' }] }
    }
    await renderSnapshot(snapshot)
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>('.session-row')]
    const a = rows().find((row) => row.textContent?.includes('only-a.ts'))!
    const b = rows().find((row) => row.textContent?.includes('Thinking'))!
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(b.textContent).not.toContain('only-a.ts')
    await renderSnapshot({ ...snapshot, liveProcess: {
      ...snapshot.liveProcess,
      '1': { ...snapshot.liveProcess['1']!, updatedAt: 3,
        blocks: [{ kind: 'tool', id: 'a-read', toolName: 'read_file_v2', toolKind: 'read', summary: 'next-a.ts', status: 'running' }] }
    } })
    expect(rows().find((row) => row.textContent?.includes('next-a.ts'))).toBe(a)
    expect(rows().find((row) => row.textContent?.includes('Thinking'))).toBe(b)
    expect(a.getAttribute('aria-current')).toBe('true')
    // Cursor 侧事实（hook v32）优先于过程块：席位 1 的副标题换成正文片段，席位 2 不受影响。
    await renderSnapshot({ ...snapshot, liveStatusLine: {
      '1': { composerId: 'c-a', generating: true, composerStatus: 'generating', statusLine: { kind: 'text', label: 'Reply snippet for A' }, updatedAt: 4 }
    } })
    expect(a.textContent).toContain('Reply snippet for A')
    expect(a.textContent).not.toContain('next-a.ts')
    expect(b.textContent).toContain('Thinking')
    // 离线：状态行常驻、灰化为 Completed（离线行换组，按文本重新定位），选择不变。
    await renderSnapshot({ ...snapshot, sessions: snapshot.sessions.map((s) => s.channelId === '1' ? { ...s, online: false } : s) })
    expect(container.querySelectorAll('.session-row__activity')).toHaveLength(2)
    const offlineRow = rows().find((row) => row.classList.contains('is-offline'))!
    expect(offlineRow).toBeDefined()
    expect(offlineRow.querySelector('.session-row__activity')?.textContent).toContain('Completed')
    expect(offlineRow.querySelector('.session-row__activity')?.classList.contains('is-muted')).toBe(true)
    expect(offlineRow.getAttribute('aria-current')).toBe('true')
    expect(rows().find((row) => row.textContent?.includes('Thinking'))?.classList.contains('is-offline')).toBe(false)
  })

  it('名册按协作组分区，独立段殿后；组头书签带成员数与「成员离线」徽标，脊色取组内最紧要一行；头部摘要报组 / 会话 / 需关注 / 排队', async () => {
    localStorage.setItem('shiguang.sessionGroups.collapsed.v1', JSON.stringify(['waiting']))
    await renderSnapshot(snapshotWith([
      { id: 'run', displayName: '运行席', status: 'running', waiting: false, connectionPhase: 'processing', queueDepth: 1 },
      { id: 'attention', displayName: '关注席', status: 'blocked', waiting: false, connectionPhase: 'approval' },
      { id: 'waiting', displayName: '待命席', status: 'idle', waiting: false, connectionPhase: 'keepalive' },
      { id: 'offline', displayName: '离线席', online: false, status: 'reviving', waiting: false, connectionPhase: 'reviving', queueDepth: 2 }
    ]), [
      { id: 'g-refactor', name: '接口重构', channelIds: ['3', '1'], leadChannelId: '1', attention: false },
      { id: 'g-review', name: '验收', channelIds: ['4'], attention: true },
      { id: 'g-empty', name: '空组', channelIds: ['9'], attention: false }
    ])
    const headers = Array.from(container.querySelectorAll('.session-group__header'))
    // 组按来源顺序成段（空组不出段），未入组的关注席落「独立」段；组内执行中排在待命之前。
    expect(headers.map((header) => header.textContent?.replace(/\s/g, ''))).toEqual(['接口重构2', '验收1成员离线', '独立1'])
    expect(rowNames()).toEqual(['运行席', '待命席', '离线席', '关注席'])
    expect(headers.every((header) => header.getAttribute('aria-expanded') === 'true')).toBe(true)
    expect(Array.from(container.querySelectorAll('.session-group')).map((node) => node.className)).toEqual([
      'session-group is-group is-active', 'session-group is-group is-offline', 'session-group is-independent is-attention'
    ])
    // 头部：标题 + 摘要 + 总数。
    const header = container.querySelector('.session-pane > .inspector-section__header')!
    expect(header.querySelector('strong')?.textContent).toBe('会话')
    expect(header.querySelector('span')?.textContent).toBe('2 组 · 4 会话 · 1 需关注 · 排队 3')
    expect(header.querySelector('.session-pane__count')?.textContent).toBe('4')

    // 组条是一枚书签：组名 + 计数在旗上，旗尾一条 hairline 横到右缘，chevron 落在线末；徽标带文字与 aria-label。
    const refactorHeader = headerOf('g-refactor')
    expect(refactorHeader.querySelector('.session-group__tab > span')?.textContent).toBe('接口重构')
    expect(refactorHeader.querySelector('.session-group__tab > b')?.textContent).toBe('2')
    expect(refactorHeader.querySelector('.session-group__tab + .session-group__rule + svg.session-group__chevron')).not.toBeNull()
    expect(refactorHeader.querySelector('.session-group__attention')).toBeNull()
    expect(refactorHeader.getAttribute('title')).toBe('协作组「接口重构」· 2 名成员')
    const badge = headerOf('g-review').querySelector('.session-group__tab + .session-group__attention + .session-group__rule')
    expect(badge).not.toBeNull()
    expect(headerOf('g-review').querySelector('.session-group__attention')?.getAttribute('aria-label')).toContain('已确认离线')
    expect(headerOf('g-review').getAttribute('title')).toBe('协作组「验收」· 1 名成员，有成员已确认离线')
    expect(headerOf('independent').getAttribute('title')).toBe('未入组的独立会话')
    expect(section('g-refactor').querySelector('.session-group__list')?.getAttribute('aria-label')).toBe('接口重构组会话')
    expect(section('independent').querySelector('.session-group__list')?.getAttribute('aria-label')).toBe('独立会话')
    // v1（状态分区）的折叠键不再被读取，并在首次读取时清掉。
    expect(localStorage.getItem('shiguang.sessionGroups.collapsed.v1')).toBeNull()
  })

  it('折叠状态按组 id 持久化（v2 键），折叠内容 inert 但常驻（不卸载重建），徽标在折叠后仍可见', async () => {
    await renderSnapshot(snapshotWith([
      { id: 'run', displayName: '运行席', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'waiting', displayName: '待命席' },
      { id: 'offline', displayName: '离线席', online: false, status: 'offline', waiting: false, connectionPhase: '' }
    ]), [{ id: 'g-review', name: '验收', channelIds: ['2', '3'], attention: true }])
    const reviewHeader = headerOf('g-review')
    const reviewRow = section('g-review').querySelector<HTMLElement>('.session-row')!
    await act(async () => reviewHeader.click())
    const collapsible = section('g-review').querySelector('.inspector-collapsible')!
    expect(reviewHeader.getAttribute('aria-expanded')).toBe('false')
    expect(collapsible.classList.contains('is-open')).toBe(false)
    expect(collapsible.hasAttribute('inert')).toBe(true)
    expect(JSON.parse(localStorage.getItem('shiguang.sessionGroups.collapsed.v2')!)).toEqual(['g-review'])
    expect(reviewHeader.querySelector('.session-group__attention')?.closest('[inert]')).toBeNull()
    await act(async () => { await new Promise((done) => setTimeout(done, 260)) })
    // 折叠只是 inert + 裁切：行留在 DOM 里，同一个节点；展开时第一帧就有内容，头像 / 状态行不重建。
    expect(section('g-review').querySelector('.session-group__list')).not.toBeNull()
    expect(section('g-review').querySelector('.session-row')).toBe(reviewRow)
    expect(reviewRow.closest('[inert]')).toBe(collapsible)
    await act(async () => reviewHeader.click())
    expect(collapsible.hasAttribute('inert')).toBe(false)
    expect(section('g-review').querySelector('.session-row')).toBe(reviewRow)
    expect(JSON.parse(localStorage.getItem('shiguang.sessionGroups.collapsed.v2')!)).toEqual([])
    // 其余段不受影响。
    expect(section('independent').querySelector('.session-group__list')).not.toBeNull()
  })

  const anchoredRoster = async (): Promise<void> => {
    await renderSnapshot(snapshotWith([
      { id: 'run', displayName: '运行席', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'waiting', displayName: '待命席' },
      { id: 'offline', displayName: '离线席', online: false, status: 'offline', waiting: false, connectionPhase: '' }
    ]), [{ id: 'g-b', name: 'B', channelIds: ['2'], attention: false }])
  }

  it('折叠会被夹断或被钉住的组时，scrollTop 用与列表同一时长 / 曲线缓动到终态，而不是让浏览器在某一帧硬夹', async () => {
    await anchoredRoster()
    const list = container.querySelector<HTMLElement>('.session-list')!
    const section = container.querySelector<HTMLElement>('.session-group[data-section="g-b"]')!
    const body = section.querySelector<HTMLElement>('.inspector-collapsible')!
    // 几何：内容 1000、视口 600、滚到 300；待命组从 250 起、列表 210 高 → 组条已被钉住（300 > 250），
    // 折叠后最大 scrollTop = 1000 − 210 − 600 = 190 → 终态取 min(300, 190, 250) = 190。
    let scrollTop = 300
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value } })
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(section, 'offsetTop', { configurable: true, value: 250 })
    Object.defineProperty(body, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 210) })
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(10_000)
    try {
      await act(async () => section.querySelector<HTMLButtonElement>('.session-group__header')!.click())
      expect(frames).toHaveLength(1)
      // 中途：单调向终态靠近，且贴着 ease-out 曲线（一半时间已走完约 95%）。
      frames[0]!(10_100)
      expect(scrollTop).toBeLessThan(300)
      expect(scrollTop).toBeGreaterThan(190)
      expect(scrollTop).toBeCloseTo(300 - 110 * 0.946, 0)
      expect(frames).toHaveLength(2)
      frames[1]!(10_200)
      expect(scrollTop).toBe(190)
      expect(frames).toHaveLength(2)
    } finally {
      raf.mockRestore()
      clock.mockRestore()
    }
  })

  it('折叠不会被夹断、组条也没被钉住时不动 scrollTop（保持不动就是最平滑的）', async () => {
    await anchoredRoster()
    const list = container.querySelector<HTMLElement>('.session-list')!
    const section = container.querySelector<HTMLElement>('.session-group[data-section="g-b"]')!
    const body = section.querySelector<HTMLElement>('.inspector-collapsible')!
    let scrollTop = 40
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value } })
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(section, 'offsetTop', { configurable: true, value: 250 })
    Object.defineProperty(body, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 210) })
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    try {
      await act(async () => section.querySelector<HTMLButtonElement>('.session-group__header')!.click())
      expect(raf).not.toHaveBeenCalled()
      expect(scrollTop).toBe(40)
    } finally {
      raf.mockRestore()
    }
  })

  it('方向键在可见行之间漫游，Home / End 跳到首尾；折叠段内的行不在候选里；只有选中行进入 Tab 序列', async () => {
    // A、B、X 成一组（组内按状态排：执行中 X → 待命 A、B），O 独立殿后。
    await renderSnapshot(snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'o', displayName: '离线 O', online: false, status: 'offline', waiting: false, connectionPhase: '' }
    ]), [{ id: 'g', name: '组', channelIds: ['1', '2', '3'], attention: false }])
    const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.session-row'))
    const nameOf = (row: Element | null | undefined) => row?.querySelector('.session-row__name')?.textContent
    // 组内顺序：执行中 X → 待命 A（选中，channel 1）、B；独立段：离线 O。
    expect(rows().map(nameOf)).toEqual(['执行 X', '待命 A', '待命 B', '离线 O'])
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1, -1])

    const press = async (key: string): Promise<void> => {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }
    await act(async () => rows()[1]!.focus())
    await press('ArrowDown')
    expect(nameOf(document.activeElement)).toBe('待命 B')
    await press('ArrowDown')
    expect(nameOf(document.activeElement)).toBe('离线 O')
    await press('ArrowDown')
    expect(nameOf(document.activeElement)).toBe('离线 O')
    await press('Home')
    expect(nameOf(document.activeElement)).toBe('执行 X')
    await press('End')
    expect(nameOf(document.activeElement)).toBe('离线 O')

    // 折叠「独立」段后，End 落在最后一个可见行。
    await act(async () => headerOf('independent').click())
    await act(async () => rows()[0]!.focus())
    await press('End')
    expect(nameOf(document.activeElement)).toBe('待命 B')
  })

  it('没有会话时显示可行动的空态；连接中显示加载态', async () => {
    await renderSnapshot({ ...snapshotOf([]), connection: { state: 'connected' } } as unknown as DesktopSnapshot)
    expect(container.querySelector('.session-group')).toBeNull()
    expect(container.querySelector('.inspector-state')?.textContent).toContain('还没有会话')
    expect(container.querySelector('.inspector-state .inspector-link')).toBeNull()

    let opened = 0
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={{ ...snapshotOf([]), connection: { state: 'connected' } } as unknown as DesktopSnapshot}
          onSelectSession={() => {}}
          onOpenRun={() => { opened += 1 }}
        />
      )
    })
    const link = container.querySelector<HTMLButtonElement>('.inspector-state .inspector-link')!
    expect(link.textContent).toBe('前往运行页')
    await act(async () => link.click())
    expect(opened).toBe(1)

    await renderSnapshot({ ...snapshotOf([]), connection: { state: 'reconnecting' } } as unknown as DesktopSnapshot)
    expect(container.querySelector('.inspector-state.is-loading')).not.toBeNull()
    expect(container.querySelector('.session-pane > .inspector-section__header span')?.textContent).toBe('正在连接通道…')
  })

  it('跨段拖放不改排序（改组不靠拖拽）；被拖行自身换段会安全取消，只是状态变化则手势继续', async () => {
    const initial = snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ])
    const grouped: RailGroupSource[] = [{ id: 'g', name: '组', channelIds: ['1', '2'], attention: false }]
    await renderSnapshot(initial, grouped)
    const groupedCard = section('g').querySelector<HTMLButtonElement>('.session-row')!
    const independentList = section('independent').querySelector<HTMLElement>('.session-group__list')!
    await act(async () => groupedCard.dispatchEvent(dragEvent('dragstart')))
    await act(async () => independentList.dispatchEvent(dragEvent('drop', 0)))
    expect(localStorage.getItem('shiguang.sessionOrder.v1')).toBeNull()

    // 被拖行的状态变了但仍在同一段：手势不中断（分区不再随状态变）。
    await act(async () => groupedCard.dispatchEvent(dragEvent('dragstart')))
    await renderSnapshot(snapshotWith([
      { id: 'a', displayName: '待命 A', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ]), grouped)
    expect(container.querySelector('.session-list__slot.is-dragging')).not.toBeNull()
    // 被拖行被移出组（组来源变化）：手势中止，什么都不写。
    await renderSnapshot(initial, [{ id: 'g', name: '组', channelIds: ['2'], attention: false }])
    expect(container.querySelector('.session-list__slot.is-dragging')).toBeNull()
    expect(localStorage.getItem('shiguang.sessionOrder.v1')).toBeNull()
  })

  it('指示线与落点都夹在同状态段里：待命行拖到执行中行之上，仍落在待命段的开头', async () => {
    // 独立段：执行中 X 在前，待命 A、B、C 在后（A 选中）。
    await renderSnapshot(snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'c', displayName: '待命 C' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ]))
    expect(rowNames()).toEqual(['执行 X', '待命 A', '待命 B', '待命 C'])
    const { list, slots } = mockSessionListGeometry(container)
    // 拖 C，指到列表最顶端（X 之上）：指示线画在待命段第一行（A）之前，而不是 X 之前。
    await act(async () => slots[3]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart')))
    await act(async () => list.dispatchEvent(dragEvent('dragover', 0)))
    expect(slots[0]!.classList.contains('is-drop-before')).toBe(false)
    expect(slots[1]!.classList.contains('is-drop-before')).toBe(true)
    await act(async () => list.dispatchEvent(dragEvent('drop', 0)))
    // 落点 = 待命段开头；X 的槽位不动。
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['c', 'a', 'b', 'x'])
    expect(rowNames()).toEqual(['执行 X', '待命 C', '待命 A', '待命 B'])
  })

  it('卡片上半区显示前置边界，最终顺序与指示线一致', async () => {
    await render()
    const { list, slots } = mockSessionListGeometry(container)
    await act(async () => {
      slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      list.dispatchEvent(dragEvent('dragover', 220))
    })
    expect(slots[2]!.classList.contains('is-drop-before')).toBe(true)
    await act(async () => {
      list.dispatchEvent(dragEvent('drop', 220))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['b', 'a', 'c'])
  })

  it('列表底部空白区对应末尾边界，支持直接松手落位', async () => {
    await render()
    const { list, slots } = mockSessionListGeometry(container)
    await act(async () => {
      slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      list.dispatchEvent(dragEvent('dragover', 400))
    })
    expect(slots[2]!.classList.contains('is-drop-after')).toBe(true)
    await act(async () => {
      list.dispatchEvent(dragEvent('drop', 400))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['b', 'c', 'a'])
  })

  it('列表顶部空白区能直接映射为首个插入边界', async () => {
    await render()
    const geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[2]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 0))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['c', 'a', 'b'])
  })

  it('卡片间隙映射为相邻插入边界', async () => {
    await render()
    const geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[2]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 100))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['a', 'c', 'b'])
  })

  it('同一会话集合的实时快照更新不会中止正在进行的拖拽', async () => {
    await render()
    let geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await render()
    geometry = mockSessionListGeometry(container)
    expect(geometry.slots[0]!.classList.contains('is-dragging')).toBe(true)
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 400))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['b', 'c', 'a'])
  })

  it('席位集合变化会中止拖拽，避免旧来源落入新列表', async () => {
    await render()
    let geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await render(['a', 'b', 'c', 'd'])
    geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 450))
    })
    expect(localStorage.getItem('shiguang.sessionOrder.v1')).toBeNull()
  })

  it('只有同一段里同状态不止一行时才可拖拽；独占一段状态的行没有可重排的余地', async () => {
    const roster = snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ])
    const draggables = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.session-row'))
      .map((row) => [row.querySelector('.session-row__name')?.textContent, row.draggable])
    await renderSnapshot(roster)
    expect(draggables()).toEqual([['执行 X', false], ['待命 A', true], ['待命 B', true]])
    // 同一组里 A 与 X 状态不同，各自独占一段：都不可拖；独立段只剩 B 一行，也不可拖。
    await renderSnapshot(roster, [{ id: 'g', name: '组', channelIds: ['1', '3'], attention: false }])
    expect(draggables()).toEqual([['执行 X', false], ['待命 A', false], ['待命 B', false]])
  })

  it('点击行打开对应通道；选中行带 aria-current', async () => {
    let opened: string | undefined
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={snapshotOf(['a', 'b'])}
          selectedChannelId="2"
          onSelectSession={(channelId) => { opened = channelId }}
        />
      )
    })
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.session-row'))
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true'])
    await act(async () => rows[0]!.click())
    expect(opened).toBe('1')
  })
})
