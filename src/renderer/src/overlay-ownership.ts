/** Portals are visually inside an overlay even though their DOM parent is body.
 * Only an exact owner scope may participate; unrelated menus stay outside. */
export function overlayOwnsTarget(
  root: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  if (!root || !(target instanceof Node)) return false
  if (root.contains(target)) return true
  const element = target instanceof Element ? target : target.parentElement
  const owner = element?.closest<HTMLElement>('[data-overlay-owner]')?.dataset
    .overlayOwner
  return !!owner && owner === root.dataset.overlayScope
}
