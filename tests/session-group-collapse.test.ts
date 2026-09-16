import { describe, expect, it } from 'vitest'
import { COLLAPSIBLE_TRANSITION_MS } from '../src/renderer/src/inspector/Collapsible'
import {
  SESSION_GROUP_COLLAPSE_MS,
  collapseEasing,
  collapseScrollTarget
} from '../src/renderer/src/session-group-collapse'

describe('collapseScrollTarget：折叠一组后滚动容器该停在哪', () => {
  const base = { scrollHeight: 1000, clientHeight: 600, sectionTop: 250, listHeight: 210 }

  it('没滚动、或折叠后仍有足够内容且组条没被钉住：不动（undefined）', () => {
    expect(collapseScrollTarget({ ...base, scrollTop: 0 })).toBeUndefined()
    // 最大 scrollTop 从 400 降到 190；当前 100 ≤ 190 且 100 < sectionTop 250 → 不会被夹、也没钉住
    expect(collapseScrollTarget({ ...base, scrollTop: 100 })).toBeUndefined()
    // 内容远多于视口：怎么折都夹不到
    expect(collapseScrollTarget({ ...base, scrollHeight: 5000, scrollTop: 100 })).toBeUndefined()
  })

  it('会被夹断：缓动到新的最大 scrollTop', () => {
    // 当前 240 < sectionTop 250（未钉住），但 240 > 新最大值 190
    expect(collapseScrollTarget({ ...base, scrollTop: 240 })).toBe(190)
    // 折叠后内容比视口还矮：回到 0
    expect(collapseScrollTarget({ ...base, scrollHeight: 700, scrollTop: 90 })).toBe(0)
  })

  it('组条被钉住：回到 section 顶（与夹断取更小者）', () => {
    // 内容很多，不会夹断；但 300 > sectionTop 250 → 组条吸顶中 → 回到 250
    expect(collapseScrollTarget({ ...base, scrollHeight: 5000, scrollTop: 300 })).toBe(250)
    // 既钉住又会夹断：取 min(250, 190)
    expect(collapseScrollTarget({ ...base, scrollTop: 300 })).toBe(190)
    // sectionTop 为 0 的首组被钉住：回到 0
    expect(collapseScrollTarget({ ...base, scrollHeight: 5000, sectionTop: 0, scrollTop: 120 })).toBe(0)
  })

  it('时长与 Collapsible 的过渡一致', () => {
    expect(SESSION_GROUP_COLLAPSE_MS).toBe(COLLAPSIBLE_TRANSITION_MS)
  })
})

describe('collapseEasing：cubic-bezier(0.2, 0.8, 0.2, 1)', () => {
  it('端点精确，中段单调递增且为 ease-out（一半时间已走完约 95%）', () => {
    expect(collapseEasing(0)).toBe(0)
    expect(collapseEasing(1)).toBe(1)
    expect(collapseEasing(-0.5)).toBe(0)
    expect(collapseEasing(2)).toBe(1)
    let previous = 0
    for (let i = 1; i <= 100; i += 1) {
      const value = collapseEasing(i / 100)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
    // 手算：x(t) = 0.5 ⇒ t ≈ 0.7245 ⇒ y ≈ 0.946
    expect(collapseEasing(0.5)).toBeCloseTo(0.946, 2)
    expect(collapseEasing(0.1)).toBeGreaterThan(0.3)
    expect(collapseEasing(0.9)).toBeGreaterThan(0.995)
  })
})
