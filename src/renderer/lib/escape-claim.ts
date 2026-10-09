/**
 * One Esc closes one layer, for hand-rolled layers that stack (the DirectoryPicker
 * over the New project modal): the layer that handles an Esc claims that very
 * event, and the layers below leave a claimed Esc alone.
 *
 * `event.defaultPrevented` cannot carry this on its own. A Radix layer that is
 * still animating out (the project sheet the New project modal was swapped in
 * from, for a few hundred milliseconds) prevents the Esc it receives although it
 * sits above nothing, so a prevented Esc cannot say that a layer above took it.
 */
const claimedEscapes = new WeakSet<Event>()

/** Mark `event` as taken by the layer that handles it. */
export function claimEscape(event: Event): void {
  claimedEscapes.add(event)
}

/** True when a layer above, or an earlier handler of this layer, already took this Esc. */
export function isEscapeClaimed(event: Event): boolean {
  return claimedEscapes.has(event)
}
