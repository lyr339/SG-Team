interface AppearanceViewTransition {
  ready: Promise<void>
  finished: Promise<void>
  skipTransition(): void
}

interface AppearanceTransitionOwner {
  startViewTransition?(update: () => void): AppearanceViewTransition
}

/** A newer appearance intent supersedes even a still-pending snapshot callback.
 * No timers, retry queue, business operation or global DOM state is owned here. */
export function createAppearanceTransition(): {
  commit(update: () => void, animated: boolean, owner?: AppearanceTransitionOwner): void
  cancel(): void
} {
  let revision = 0, active: AppearanceViewTransition | undefined
  return {
    cancel() {
      revision++
      try { active?.skipTransition() } catch { /* The document may already be retiring. */ }
      active = undefined
    },
    commit(update, animated, owner) {
      const current = ++revision
      try { active?.skipTransition() } catch { /* A retiring browser snapshot cannot block the new intent. */ }
      active = undefined
      let applied = false
      const applyLatest = () => { if (current === revision && !applied) { applied = true; update() } }
      if (!animated || !owner?.startViewTransition) { applyLatest(); return }
      try {
        const transition = owner.startViewTransition(applyLatest)
        active = transition
        // Interrupting a transition rejects ready; this is expected, not an
        // unhandled UI error. finished only retires the matching instance.
        void transition.ready.catch(() => {})
        void transition.finished.then(() => { if (active === transition) active = undefined }).catch(() => { if (active === transition) active = undefined })
      } catch { applyLatest() }
    }
  }
}
