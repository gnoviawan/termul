/**
 * Desktop-local `acp:*` events: the few events the host emits as plain Tauri
 * events because they never travel the `/ws` relay (they belong to a desktop
 * command, not to an ACP session or agent).
 *
 * Today that is `acp:worktree_progress` (`commands/worktree.rs` streams git
 * output while a `worktree_create` invoke is in flight). Every other `acp:*`
 * name is a relay event delivered by the desktop transport's Channel.
 *
 * One native `listen` per name fans out to its subscribers and is released
 * when the last subscriber leaves.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { logFrontendError } from '@/lib/log-api'

/** `acp:*` names delivered as plain Tauri events instead of relay frames. */
const DESKTOP_LOCAL_EVENTS: Record<string, true> = { 'acp:worktree_progress': true }

type LocalListener = (payload: unknown) => void

interface LocalSubscription {
  listeners: Set<LocalListener>
  /** The native unlisten, once `listen` resolved; `'released'` when every subscriber left first. */
  unlisten: UnlistenFn | 'pending' | 'released'
}

const subscriptions = new Map<string, LocalSubscription>()

export function isDesktopLocalEvent(eventName: string): boolean {
  return Object.hasOwn(DESKTOP_LOCAL_EVENTS, eventName)
}

function fanOut(eventName: string, payload: unknown): void {
  const subscription = subscriptions.get(eventName)
  if (!subscription) return
  for (const listener of subscription.listeners) {
    try {
      listener(payload)
    } catch (err) {
      void logFrontendError({
        level: 'error',
        source: 'desktop-local-events',
        message: `listener for ${eventName} threw: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }
}

function attach(eventName: string, subscription: LocalSubscription): void {
  listen<unknown>(eventName, (event) => fanOut(eventName, event.payload)).then(
    (unlisten) => {
      if (subscription.unlisten === 'released') {
        unlisten()
        return
      }
      subscription.unlisten = unlisten
    },
    (err) => {
      subscriptions.delete(eventName)
      void logFrontendError({
        level: 'error',
        source: 'desktop-local-events',
        message: `listen(${eventName}) failed: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  )
}

/** Subscribe to a desktop-local event; returns the unsubscribe function. */
export function onDesktopLocalEvent<T>(
  eventName: string,
  callback: (payload: T) => void
): () => void {
  let subscription = subscriptions.get(eventName)
  if (!subscription) {
    subscription = { listeners: new Set(), unlisten: 'pending' }
    subscriptions.set(eventName, subscription)
    attach(eventName, subscription)
  }
  const listener = callback as LocalListener
  subscription.listeners.add(listener)
  const current = subscription
  return () => {
    current.listeners.delete(listener)
    if (current.listeners.size > 0 || subscriptions.get(eventName) !== current) return
    subscriptions.delete(eventName)
    if (typeof current.unlisten === 'function') current.unlisten()
    current.unlisten = 'released'
  }
}

/** @internal test helper — drop every subscription without touching the native listeners. */
export function _resetDesktopLocalEventsForTests(): void {
  subscriptions.clear()
}
