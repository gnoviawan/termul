/**
 * Keeps values that grow without bound under the host store's value cap.
 *
 * The host refuses a serialized value above `STORE_VALUE_MAX_BYTES`. A writer
 * whose value holds unbounded OUTPUT (terminal scrollback, transcripts, history
 * lists) calls one of the trimmers here before it writes, and the oldest part
 * goes first. A writer whose value is text the user typed (a draft, an editor
 * buffer) never trims: the facade reports the refusal to the user instead.
 *
 * The cap is the same on every surface: the desktop reaches the host store
 * over the Channel carrier, exactly like a browser does over a WebSocket.
 */

import type { SessionData, TerminalSession } from '@shared/types/ipc.types'
import type {
  PersistedSnapshot,
  PersistedSnapshotList,
  PersistedTerminal,
  PersistedTerminalLayout
} from '@shared/types/persistence.types'

/** Largest serialized value the host accepts (mirrors `STORE_VALUE_MAX_BYTES`). */
export const STORE_VALUE_MAX_BYTES = 256 * 1024

/** Version the facades stamp around every stored value (`{ _version, data }`). */
export const STORED_VALUE_VERSION = 1

/** UTF-8 length of `text` without allocating the encoded copy. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte scalar value.
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** Serialized size of `value` as the host sees it (UTF-8 JSON). */
export function jsonBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value))
}

/** Serialized size of `data` once the facade wraps it as `{ _version, data }`. */
export function storedValueBytes(data: unknown): number {
  return jsonBytes({ _version: STORED_VALUE_VERSION, data })
}

/**
 * Largest `n` in `[0, max)` for which `fits(n)` holds. `fits` must be monotone
 * (true for small `n`) and `max` must be known NOT to fit. Returns 0 when not
 * even `n = 1` fits.
 */
function largestFitting(max: number, fits: (n: number) => boolean): number {
  let lo = 0
  let hi = max
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

export interface TrimmedList<T> {
  items: readonly T[]
  /** How many items were removed. */
  dropped: number
}

/**
 * The longest run of `items` that still fits once `build` turns it into the
 * stored value. `keep: 'head'` keeps the front (lists with the newest entry
 * first), `keep: 'tail'` keeps the end (lists in chronological order). The
 * input array is returned as is when it already fits.
 */
export function trimListToCap<T>(
  items: readonly T[],
  build: (kept: readonly T[]) => unknown,
  keep: 'head' | 'tail',
  cap: number = STORE_VALUE_MAX_BYTES
): TrimmedList<T> {
  if (storedValueBytes(build(items)) <= cap) return { items, dropped: 0 }
  const pick = (n: number): readonly T[] =>
    keep === 'head' ? items.slice(0, n) : items.slice(items.length - n)
  const n = largestFitting(items.length, (count) => storedValueBytes(build(pick(count))) <= cap)
  return { items: pick(n), dropped: items.length - n }
}

const LINE_BREAK = /\r\n|\r|\n/

/** The newest `keep` UTF-16 units of `text`, starting at a clean boundary. */
function tailChars(text: string, keep: number): string {
  if (keep >= text.length) return text
  if (keep <= 0) return ''
  const cut = text.length - keep
  let tail = text.slice(cut)
  // A cut through a surrogate pair would leave a lone surrogate, which the
  // host's JSON parser refuses.
  const first = tail.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1)
  // Start on a whole line, as the in-memory transcript trim does, unless the
  // cut already falls on a line start.
  const before = text[cut - 1]
  if (before === '\n' || before === '\r') return tail
  const lineBreak = LINE_BREAK.exec(tail)
  return lineBreak ? tail.slice(lineBreak.index + lineBreak[0].length) : tail
}

/** Granularity of the output share a trimmed terminal keeps (1/STEPS). */
const KEEP_STEPS = 1024

/** `terminal` with only the newest `step / KEEP_STEPS` of its output kept. */
function shrinkTerminal(terminal: PersistedTerminal, step: number): PersistedTerminal {
  const { scrollback, transcript, ...rest } = terminal
  const ratio = step / KEEP_STEPS
  const next: PersistedTerminal = { ...rest }
  if (scrollback !== undefined) {
    const keep = Math.floor(scrollback.length * ratio)
    if (keep > 0) next.scrollback = scrollback.slice(scrollback.length - keep)
  }
  if (transcript !== undefined) {
    const text = tailChars(transcript, Math.floor(transcript.length * ratio))
    if (text.length > 0) next.transcript = text
  }
  return next
}

/**
 * `terminals/<projectId>`: cut the oldest scrollback lines and transcript of
 * every terminal by the same share until the layout fits. The newest output of
 * each terminal survives. Output is dropped entirely only when the layout
 * cannot fit otherwise (the facade then reports the refusal).
 */
export function trimTerminalLayout(
  layout: PersistedTerminalLayout,
  cap: number = STORE_VALUE_MAX_BYTES
): PersistedTerminalLayout {
  if (storedValueBytes(layout) <= cap) return layout
  const withStep = (step: number): PersistedTerminalLayout => ({
    ...layout,
    terminals: layout.terminals.map((terminal) => shrinkTerminal(terminal, step))
  })
  const step = largestFitting(KEEP_STEPS, (s) => storedValueBytes(withStep(s)) <= cap)
  return withStep(step)
}

export interface TrimmedSnapshotList {
  list: PersistedSnapshotList
  /** Snapshots whose saved terminal output was cut. */
  shrunk: number
  /** Ids of snapshots removed entirely, oldest first. */
  droppedIds: string[]
}

function withTerminalOutput(snapshot: PersistedSnapshot, step: number): PersistedSnapshot {
  return {
    ...snapshot,
    terminals: snapshot.terminals.map((terminal) => shrinkTerminal(terminal, step))
  }
}

/**
 * `snapshots/<projectId>` (newest snapshot first). A snapshot is something the
 * user named, so the output inside it goes first, oldest snapshot first, and a
 * whole snapshot goes only when the list cannot fit without its output. The
 * newest snapshot is never removed.
 */
export function trimSnapshotList(
  list: PersistedSnapshotList,
  cap: number = STORE_VALUE_MAX_BYTES
): TrimmedSnapshotList {
  if (storedValueBytes(list) <= cap) return { list, shrunk: 0, droppedIds: [] }

  const snapshots = [...list.snapshots]
  // The array's JSON is `[` + items joined by `,` + `]`, so sizes add up.
  const base = storedValueBytes({ ...list, snapshots: [] })
  const sizes = snapshots.map((snapshot) => jsonBytes(snapshot))
  const total = (): number =>
    base + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, snapshots.length - 1)

  let shrunk = 0
  // 1. Strip the output of older snapshots, oldest first (never the newest).
  for (let i = snapshots.length - 1; i > 0 && total() > cap; i--) {
    const stripped = withTerminalOutput(snapshots[i], 0)
    const strippedSize = jsonBytes(stripped)
    if (strippedSize < sizes[i]) shrunk++
    snapshots[i] = stripped
    sizes[i] = strippedSize
  }
  // 2. Cut the newest snapshot's output as little as needed.
  if (total() > cap && snapshots.length > 0) {
    const newest = snapshots[0]
    const others = total() - sizes[0]
    const step = largestFitting(
      KEEP_STEPS,
      (s) => others + jsonBytes(withTerminalOutput(newest, s)) <= cap
    )
    snapshots[0] = withTerminalOutput(newest, step)
    const cutSize = jsonBytes(snapshots[0])
    if (cutSize < sizes[0]) shrunk++
    sizes[0] = cutSize
  }
  // 3. Only now remove whole snapshots, oldest first.
  const droppedIds: string[] = []
  while (total() > cap && snapshots.length > 1) {
    const dropped = snapshots.pop()
    sizes.pop()
    if (dropped) droppedIds.push(dropped.id)
  }
  return { list: { ...list, snapshots }, shrunk, droppedIds }
}

/** `terminal` with only the newest `step / KEEP_STEPS` of its history lines kept. */
function shrinkSessionTerminal(terminal: TerminalSession, step: number): TerminalSession {
  const keep = Math.floor(terminal.history.length * (step / KEEP_STEPS))
  return {
    ...terminal,
    history: keep > 0 ? terminal.history.slice(terminal.history.length - keep) : []
  }
}

/**
 * `sessions/auto-save`: cut the oldest history lines of every terminal by the
 * same share until the session fits. The newest lines of each terminal survive.
 */
export function trimSessionData(
  session: SessionData,
  cap: number = STORE_VALUE_MAX_BYTES
): SessionData {
  if (storedValueBytes(session) <= cap) return session
  const withStep = (step: number): SessionData => ({
    ...session,
    terminals: session.terminals.map((t) => shrinkSessionTerminal(t, step)),
    workspaces: session.workspaces.map((w) => ({
      ...w,
      terminals: w.terminals.map((t) => shrinkSessionTerminal(t, step))
    }))
  })
  const step = largestFitting(KEEP_STEPS, (s) => storedValueBytes(withStep(s)) <= cap)
  return withStep(step)
}
