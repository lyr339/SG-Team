import { describe, expect, it, vi } from 'vitest'
import { createAppearanceTransition } from '../src/renderer/src/appearance-transition'

function transitionOwner() {
  const callbacks: Array<() => void> = []
  const transitions: Array<{ ready: Promise<void>; finished: Promise<void>; skipTransition: ReturnType<typeof vi.fn>; finish: () => void }> = []
  return {
    callbacks, transitions,
    startViewTransition: vi.fn((update: () => void) => {
      callbacks.push(update)
      let finish!: () => void
      const result = { ready: Promise.resolve(), finished: new Promise<void>(resolve => { finish = resolve }), skipTransition: vi.fn(), finish: () => finish() }
      transitions.push(result)
      return result
    })
  }
}

describe('appearance transitions preserve the latest complete intent', () => {
  it('applies immediately without animation or browser support', () => {
    const controller = createAppearanceTransition(), commit = vi.fn()
    controller.commit(commit, false, transitionOwner())
    controller.commit(commit, true)
    expect(commit).toHaveBeenCalledTimes(2)
  })
  it('never lets a delayed old theme callback overwrite a newer one', () => {
    const controller = createAppearanceTransition(), owner = transitionOwner()
    const first = vi.fn(), second = vi.fn()
    controller.commit(first, true, owner)
    controller.commit(second, true, owner)
    owner.callbacks[1]!()
    owner.callbacks[0]!()
    expect(owner.transitions[0]!.skipTransition).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })
  it('opacity/reduced-motion updates supersede a pending animated callback', () => {
    const controller = createAppearanceTransition(), owner = transitionOwner()
    const theme = vi.fn(), opacity = vi.fn()
    controller.commit(theme, true, owner)
    controller.commit(opacity, false, owner)
    owner.callbacks[0]!()
    expect(opacity).toHaveBeenCalledOnce()
    expect(theme).not.toHaveBeenCalled()
  })
  it('retiring the old transition never discards a newer in-flight transition', async () => {
    const controller = createAppearanceTransition(), owner = transitionOwner()
    controller.commit(() => {}, true, owner)
    controller.commit(() => {}, true, owner)
    owner.transitions[0]!.finish()
    await Promise.resolve()
    controller.commit(() => {}, true, owner)
    expect(owner.transitions[1]!.skipTransition).toHaveBeenCalledOnce()
  })
  it('falls back to the same commit if native snapshot creation throws', () => {
    const commit = vi.fn()
    createAppearanceTransition().commit(commit, true, { startViewTransition: () => { throw Error('unsupported snapshot') } })
    expect(commit).toHaveBeenCalledOnce()
  })
  it('does not double-commit if a browser calls the update and then fails snapshot creation', () => {
    const commit = vi.fn()
    createAppearanceTransition().commit(commit, true, { startViewTransition: update => { update(); throw Error('snapshot lost') } })
    expect(commit).toHaveBeenCalledOnce()
  })
  it('retires callbacks with the owner instead of repainting a replacement app after unmount', () => {
    const controller = createAppearanceTransition(), owner = transitionOwner(), commit = vi.fn()
    controller.commit(commit, true, owner)
    controller.cancel()
    owner.callbacks[0]!()
    expect(owner.transitions[0]!.skipTransition).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })
})
