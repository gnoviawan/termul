import { Component, type ReactNode, type RefObject } from 'react'
import { PICKER_STAR_MOTION } from './selector-tokens'

/**
 * What places a row's star: no Edit, an Edit beside the check (`edit`), an
 * Edit showing the level with the star flush before it (`level`), or the copy
 * a pick leaves fading beside the row (`exiting`).
 */
export type StarPhase = 'none' | 'edit' | 'level' | 'exiting'

/** Drops the star's FLIP styles; touches nothing that has none. */
function rest(star: HTMLElement): void {
  if (star.style.transform) star.style.removeProperty('transform')
  if (star.style.transition) star.style.removeProperty('transition')
}

/**
 * Moves a row's star to its new place when the row's phase changes (a pick),
 * with transform only: the star is put back where it was drawn, then
 * transitions to rest (`PICKER_STAR_MOTION`). Only a row whose phase changed
 * measures: never on the first paint, scrolling, focus moves, or a new level
 * on Edit (there the star stays flush with Edit, whose edge moves at once).
 *
 * A class, as `getSnapshotBeforeUpdate` is React's one place to read the old
 * layout after a render and before the DOM changes; a pick can replace the
 * star's node, so its old place is gone by the layout effects. The read is the
 * drawn rect, in-flight transform included, so a star cut off mid-move
 * restarts from where it is.
 */
export class StarFlip extends Component<{
  /** The star's positioned box. */
  star: RefObject<HTMLElement>
  phase: StarPhase
  reduced: boolean
  children: ReactNode
}> {
  /** Ends the current move: its listener, its fallback timer, its styles. */
  private stop: (() => void) | null = null

  getSnapshotBeforeUpdate(prev: StarFlip['props']): number | null {
    if (prev.phase === this.props.phase || this.props.reduced) return null
    return this.props.star.current?.getBoundingClientRect().left ?? null
  }

  componentDidUpdate(prev: StarFlip['props'], _state: unknown, from: number | null): void {
    if (prev.phase === this.props.phase) return
    this.stop?.()
    const star = this.props.star.current
    if (!star) return
    rest(star)
    if (from === null) return
    const delta = from - star.getBoundingClientRect().left
    if (Math.abs(delta) < 0.5) return
    star.style.transition = 'none'
    star.style.transform = `translateX(${delta}px)`
    // Beside the fading copy it holds; the copy's unmount moves it next.
    if (this.props.phase === 'exiting') return
    const { ms, ease } =
      this.props.phase === 'none' ? PICKER_STAR_MOTION.settle : PICKER_STAR_MOTION.enter
    // Commit the start, or the transition would begin at rest.
    star.getBoundingClientRect()
    star.style.transition = `transform ${ms}ms ${ease}`
    star.style.transform = ''
    // At transitionend (the star's own: its button's fades bubble here too),
    // or a little after, should none fire.
    const end = (event?: Event): void => {
      if (event && event.target !== star) return
      clearTimeout(timer)
      star.removeEventListener('transitionend', end)
      this.stop = null
      rest(star)
    }
    const timer = setTimeout(end, ms + 50)
    star.addEventListener('transitionend', end)
    this.stop = end
  }

  componentWillUnmount(): void {
    this.stop?.()
  }

  render(): ReactNode {
    return this.props.children
  }
}
