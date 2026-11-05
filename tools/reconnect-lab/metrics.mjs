// Pure measurement over one scenario's event list. Every event is
// `{ t, src: 'page' | 'proxy' | 'server' | 'lab', type, ... }`; page events
// carry the page's own clock (same host as the lab, so one time base).

const CONTROL_RE = /^control channel state: (\S+) → (\S+)$/

export function controlTransitions(events) {
  const out = []
  for (const e of events) {
    if (e.src !== 'page' || e.type !== 'log' || e.source !== 'connection-status-store') continue
    const m = CONTROL_RE.exec(e.message)
    if (m) out.push({ t: e.t, from: m[1], to: m[2] })
  }
  return out
}

export function controlStateAt(transitions, t) {
  let state = 'connecting'
  for (const tr of transitions) {
    if (tr.t > t) break
    state = tr.to
  }
  return state
}

/** Highest streamed chunk index the DOM showed at or before `t`. */
export function chunkAt(events, t) {
  let max = -1
  for (const e of events) {
    if (e.t > t) break
    if (e.src === 'page' && e.type === 'chunk') max = e.max
  }
  return max
}

/**
 * The chunk index the fake agent had emitted by `t`, extrapolated from the
 * last DOM samples before `faultAt`: the agent emits one chunk per second on a
 * fixed schedule, and a DOM sample lags its emission, so the max over samples
 * is a lower bound off by at most one chunk.
 */
export function liveChunkAt(events, faultAt, t) {
  const samples = events
    .filter((e) => e.src === 'page' && e.type === 'chunk' && e.t <= faultAt && e.max > 0)
    .slice(-10)
  if (samples.length === 0) return null
  return Math.max(...samples.map((s) => s.max + Math.floor((t - s.t) / 1000)))
}

/** Milliseconds `overlay` was not `none` inside [from, to]. */
function overlayMs(events, from, to) {
  let total = 0
  let shownSince = null
  for (const e of events) {
    if (e.src !== 'page' || e.type !== 'overlay') continue
    if (e.t > to) break
    if (e.state !== 'none' && shownSince === null) shownSince = e.t
    if (e.state === 'none' && shownSince !== null) {
      total += Math.max(0, Math.min(e.t, to) - Math.max(shownSince, from))
      shownSince = null
    }
  }
  if (shownSince !== null) total += Math.max(0, to - Math.max(shownSince, from))
  return total
}

/** `acp` or `store` per page socket, from the first request it sent after `authenticate`. */
function socketRoles(events) {
  const roles = new Map()
  for (const e of events) {
    if (e.src !== 'page' || e.type !== 'ws-send' || roles.has(e.sock)) continue
    if (!e.reqType || e.reqType === 'authenticate') continue
    roles.set(e.sock, e.reqType.startsWith('store_') ? 'store' : 'acp')
  }
  return roles
}

/**
 * Recovery after return instant `R`, observed until `end`.
 * - connectedMs: when the control channel last became `connected` and stayed
 *   so through `end` (negative: it had already recovered before `R`; null:
 *   not connected at `end`).
 * - streamMs: first DOM growth of the streamed chunk index past its value at `R`
 *   (may be a stale frame queued before the drop).
 * - liveMs: first chunk emitted after `R` on screen (on a reopened socket when
 *   the old one died): the chat is live again.
 * - overlayMs: "Reconnecting…"/"Host offline" visible inside [R, end].
 */
export function recovery(events, { faultAt, returnAt, end }) {
  const transitions = controlTransitions(events)
  let connectedAt = null
  if (controlStateAt(transitions, end) === 'connected') {
    const intoConnected = transitions.filter((tr) => tr.to === 'connected' && tr.t <= end)
    const last = intoConnected.at(-1)
    connectedAt = last && last.t >= faultAt ? last.t : returnAt
  }
  const baseChunk = chunkAt(events, returnAt)
  const grow = events.find(
    (e) =>
      e.src === 'page' && e.type === 'chunk' && e.t > returnAt && e.t <= end && e.max > baseChunk
  )
  const roles = socketRoles(events)
  const isAcpSocket = (e) => e.src === 'page' && e.path === '/ws' && roles.get(e.sock) !== 'store'
  // Once the ACP socket died, a live chunk can only arrive on a reopened
  // socket; earlier DOM growth is a frame received before the drop.
  const acpClosed = events.find(
    (e) => e.type === 'ws-close' && isAcpSocket(e) && e.t >= faultAt && e.t <= end
  )
  const reopenedAt = acpClosed
    ? (events.find(
        (e) => e.type === 'ws-open' && isAcpSocket(e) && e.t >= faultAt && e.sock !== acpClosed.sock
      )?.t ?? Number.POSITIVE_INFINITY)
    : Number.NEGATIVE_INFINITY
  const live = liveChunkAt(events, faultAt, returnAt)
  const caughtUp =
    live === null
      ? null
      : events.find(
          (e) =>
            e.src === 'page' &&
            e.type === 'chunk' &&
            e.t > returnAt &&
            e.t > reopenedAt &&
            e.t <= end &&
            e.max > live
        )
  const liveAt = caughtUp?.t ?? end
  let mainThreadBusyMs = 0
  for (const e of events) {
    if (e.type !== 'longtask') continue
    const from = Math.max(e.startedAt, returnAt)
    const to = Math.min(e.startedAt + e.ms, liveAt)
    if (to > from) mainThreadBusyMs += to - from
  }
  const lastChunkBeforeFault = events
    .filter((e) => e.src === 'page' && e.type === 'chunk' && e.t <= faultAt)
    .at(-1)
  const opened = events.filter(
    (e) => e.src === 'page' && e.type === 'ws-new' && e.t >= faultAt && e.t <= end
  )
  const byRole = { acp: 0, store: 0, other: 0 }
  for (const e of opened) {
    if (e.path !== '/ws') byRole.other += 1
    else byRole[roles.get(e.sock) ?? 'acp'] += 1
  }
  const proxyUpgrades = events.filter(
    (e) => e.src === 'proxy' && e.type === 'ws-upgrade' && e.t >= faultAt && e.t <= end
  ).length
  return {
    connectedMs: connectedAt === null ? null : connectedAt - returnAt,
    streamMs: grow ? grow.t - returnAt : null,
    liveMs: caughtUp ? caughtUp.t - returnAt : null,
    liveChunkAtReturn: live,
    mainThreadBusyMs,
    streamGapMs: grow && lastChunkBeforeFault ? grow.t - lastChunkBeforeFault.t : null,
    overlayMs: overlayMs(events, returnAt, end),
    overlayTotalMs: overlayMs(events, faultAt, end),
    wsOpened: opened.length,
    wsByRole: byRole,
    proxyUpgrades,
    baseChunk,
    stateAtReturn: controlStateAt(transitions, returnAt)
  }
}

/** True once the channel settled `connected`, the stream grew, and no overlay shows. */
export function isRecovered(events, window) {
  const r = recovery(events, window)
  const overlay = events.filter((e) => e.src === 'page' && e.type === 'overlay').at(-1)
  return r.connectedMs !== null && r.liveMs !== null && (!overlay || overlay.state === 'none')
}

const MILESTONE_TYPES = new Set([
  'lifecycle',
  'log',
  'ws-new',
  'ws-open',
  'ws-close',
  'ws-error',
  'ws-first-event',
  'conn-open',
  'conn-close',
  'conn-refused',
  'ws-upgrade',
  'fault',
  'rst',
  'mark'
])

export function describe(e) {
  switch (e.type) {
    case 'log':
      return `log ${e.level} [${e.source}] ${e.message}`
    case 'console':
      return `console.${e.level} ${e.text}`
    case 'lifecycle':
      return `lifecycle ${e.event} (visibility=${e.visibility})`
    case 'ws-new':
    case 'ws-open':
    case 'ws-error':
      return `${e.type} sock#${e.sock} ${e.path}`
    case 'ws-close':
      return `ws-close sock#${e.sock} ${e.path} code=${e.code} clean=${e.wasClean}`
    case 'ws-send':
      return `ws-send sock#${e.sock} ${e.reqType}`
    case 'ws-reply':
      return `ws-reply sock#${e.sock} ${e.reqType} ok=${e.ok}${e.code ? ` ${e.code}` : ''}`
    case 'ws-first-event':
      return `ws-first-event sock#${e.sock} ${e.frameType}`
    case 'ws-heartbeat':
      return `ws-heartbeat sock#${e.sock}`
    case 'chunk':
      return `dom chunk max=${e.max}`
    case 'overlay':
      return `dom overlay=${e.state}`
    case 'lamp':
      return `dom lamp="${e.label}"`
    case 'conn-open':
      return `proxy conn#${e.conn} open (fault=${e.fault})`
    case 'conn-close':
      return `proxy conn#${e.conn} closed by ${e.by} ${e.path ?? ''} after ${e.lifetimeMs}ms`
    case 'conn-refused':
      return 'proxy refused a connection'
    case 'ws-upgrade':
      return `proxy conn#${e.conn} ws upgrade ${e.path}`
    case 'fault':
      return `proxy fault=${e.fault} (open pairs ${e.open})`
    case 'rst':
      return `proxy reset ${e.reset} pair(s)${e.reason ? ` (${e.reason})` : ''}`
    case 'longtask':
      return `main thread busy ${e.ms}ms (started ${e.startedAt})`
    case 'mark':
      return `lab ${e.label}`
    case 'line':
      return `server ${e.text}`
    default:
      return `${e.type} ${JSON.stringify(e)}`
  }
}

/**
 * The return path from `R` to full recovery as milestones, and the three
 * longest gaps between consecutive milestones: where the time went.
 */
export function slowestSteps(events, { returnAt, until }, count = 3) {
  const ms = events.filter(
    (e) =>
      e.t >= returnAt &&
      e.t <= until &&
      (MILESTONE_TYPES.has(e.type) ||
        (e.type === 'ws-send' && e.reqType !== 'ping') ||
        (e.type === 'ws-reply' && e.reqType !== 'ping') ||
        (e.type === 'chunk' && e.t === until))
  )
  const gaps = []
  let prev = { t: returnAt, label: 'return instant' }
  for (const e of ms) {
    const label = `${e.src}: ${describe(e)}`
    gaps.push({ ms: e.t - prev.t, from: prev, to: { t: e.t, label } })
    prev = { t: e.t, label }
  }
  return gaps.sort((a, b) => b.ms - a.ms).slice(0, count)
}
