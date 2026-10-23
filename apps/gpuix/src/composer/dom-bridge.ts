/**
 * What the shared composer hosts see of the native editor: the element in
 * `inputRef` and the `KeyboardEvent`s `onBeforeEditorKeyDown` receives.
 */

import type { KeyEvent } from '@gpuix/react'
import { CompatElement } from '../compat/dom-node'
import { domEvent, domKey } from '../compat/events'

/**
 * The textarea as `inputRef` holds it. The composer menus announce themselves
 * on the input: `composer-menu.tsx` sets `aria-controls` while a listbox is
 * open and removes it when the listbox closes. That is the editor's signal to
 * route keys to the menu.
 */
export class ComposerInputElement extends CompatElement {
  private readonly attrs = new Map<string, string>()

  constructor(
    elementId: number,
    private readonly onMenuOpenChange: (open: boolean) => void
  ) {
    super(elementId)
  }

  override getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? super.getAttribute(name)
  }

  override setAttribute(name: string, value = ''): void {
    this.attrs.set(name, String(value))
    if (name === 'aria-controls') this.onMenuOpenChange(true)
  }

  override removeAttribute(name: string): void {
    this.attrs.delete(name)
    if (name === 'aria-controls') this.onMenuOpenChange(false)
  }
}

/** CompatElement is the compat layer's stand-in for a DOM element in every shared ref. */
export function asHostElement(element: ComposerInputElement): HTMLElement {
  return element as unknown as HTMLElement
}

export interface KeyInit {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

export function keyInitFrom(event: KeyEvent): KeyInit | null {
  const key = domKey(event.key, event.keyChar ?? undefined)
  if (!key) return null
  return {
    key,
    shiftKey: event.modifiers?.shift === true,
    ctrlKey: event.modifiers?.ctrl === true,
    altKey: event.modifiers?.alt === true,
    metaKey: event.modifiers?.cmd === true
  }
}

/** A cancelable `keydown` with the fields the composer key handlers read. */
export function composerKeyEvent(init: KeyInit, target: unknown): KeyboardEvent {
  return domEvent('keydown', {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...init,
    repeat: false,
    isComposing: false,
    target
  }) as KeyboardEvent
}
