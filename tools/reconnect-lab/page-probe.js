// Injected into the page before the app boots (Playwright addInitScript).
// Every observation is pushed to the lab through the `__labEmit` binding with
// the page's own Date.now(), so a frozen page simply emits nothing and the
// timeline keeps client-side timestamps. `__labConfig` is prepended by run.mjs.
;(() => {
  const config = window.__labConfig
  if (location.origin !== config.origin) return
  localStorage.setItem('termul.webAuthToken', config.token)
  localStorage.setItem('termul.deviceId', config.deviceId)

  const emit = (type, detail) => {
    try {
      window.__labEmit({ t: Date.now(), src: 'page', type, ...detail })
    } catch {
      // binding not installed yet; drop
    }
  }

  // Visibility override: headless Chromium never hides a page on its own, so
  // the lab flips this flag and dispatches `visibilitychange` itself.
  window.__labHidden = false
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (window.__labHidden ? 'hidden' : 'visible')
  })
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => window.__labHidden
  })
  window.__labSetHidden = (hidden) => {
    window.__labHidden = hidden
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event(hidden ? 'blur' : 'focus'))
  }

  for (const [target, name] of [
    [document, 'visibilitychange'],
    [document, 'freeze'],
    [document, 'resume'],
    [window, 'pageshow'],
    [window, 'pagehide'],
    [window, 'focus'],
    [window, 'blur'],
    [window, 'online'],
    [window, 'offline']
  ]) {
    target.addEventListener(
      name,
      () => emit('lifecycle', { event: name, visibility: document.visibilityState }),
      true
    )
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      emit('console', {
        level,
        text: args
          .map((a) => {
            if (typeof a === 'string') return a
            if (a instanceof Error) return `${a.name}: ${a.message}`
            try {
              return JSON.stringify(a)
            } catch {
              return String(a)
            }
          })
          .join(' ')
          .slice(0, 600)
      })
      original(...args)
    }
  }

  const originalFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/log/frontend-error') && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        emit('log', {
          level: body.level,
          source: body.source,
          message: String(body.message).slice(0, 600)
        })
      } catch {
        emit('log', { level: '?', source: '?', message: 'unparsed log body' })
      }
    }
    return originalFetch(input, init)
  }

  // Socket census: every socket the client opens, its lifecycle, the request
  // types it sends (never payloads) and the replies to them.
  let socketSeq = 0
  const OriginalWebSocket = window.WebSocket
  class LabWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols)
      const sock = ++socketSeq
      const path = new URL(String(url), location.href).pathname
      const sentTypes = new Map()
      let firstEvent = true
      this.__lab = { sock, path, sentTypes }
      emit('ws-new', { sock, path })
      this.addEventListener('open', () => emit('ws-open', { sock, path }))
      this.addEventListener('error', () => emit('ws-error', { sock, path }))
      this.addEventListener('close', (ev) =>
        emit('ws-close', { sock, path, code: ev.code, wasClean: ev.wasClean })
      )
      this.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return
        let frame
        try {
          frame = JSON.parse(ev.data)
        } catch {
          return
        }
        if (typeof frame.id === 'string' && typeof frame.ok === 'boolean') {
          const type = sentTypes.get(frame.id)
          sentTypes.delete(frame.id)
          emit('ws-reply', {
            sock,
            path,
            reqType: type ?? null,
            ok: frame.ok,
            code: frame.err?.code
          })
          return
        }
        if (frame.type === 'heartbeat') {
          emit('ws-heartbeat', { sock, path })
          return
        }
        if (firstEvent) {
          firstEvent = false
          emit('ws-first-event', { sock, path, frameType: frame.type ?? null })
        }
      })
    }

    send(data) {
      if (typeof data === 'string') {
        try {
          const frame = JSON.parse(data)
          if (typeof frame.id === 'string') this.__lab.sentTypes.set(frame.id, frame.type)
          emit('ws-send', {
            sock: this.__lab.sock,
            path: this.__lab.path,
            reqType: frame.type ?? null
          })
        } catch {
          // not JSON
        }
      }
      return super.send(data)
    }
  }
  window.WebSocket = LabWebSocket

  // Main-thread stalls: long tasks (>50 ms) as the browser reports them.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 200) continue
        emit('longtask', {
          startedAt: Math.round(performance.timeOrigin + entry.startTime),
          ms: Math.round(entry.duration)
        })
      }
    }).observe({ type: 'longtask', buffered: false })
  } catch {
    // longtask entries unsupported
  }

  // DOM sampler: highest streamed `chunk-N` in the transcript, the chat's
  // "Reconnecting…" overlay, and the status-bar lamp label. Emits on change.
  let lastChunk = -1
  let lastOverlay = null
  let lastLamp = null
  setInterval(() => {
    const main = document.querySelector('main')
    if (main) {
      let max = -1
      for (const m of (main.textContent ?? '').matchAll(/\bchunk-(\d+)\b/g)) {
        const n = Number(m[1])
        if (n > max) max = n
      }
      if (max !== lastChunk) {
        lastChunk = max
        emit('chunk', { max })
      }
    }
    let overlay = 'none'
    let lamp = null
    for (const el of document.querySelectorAll('[role="status"]')) {
      const text = el.textContent ?? ''
      if (text.includes('Reconnecting…')) overlay = 'reconnecting'
      else if (text.includes('Host offline') && overlay === 'none') overlay = 'host-offline'
      const label = el.getAttribute('aria-label')
      if (label && (label.startsWith('Connected') || label.includes('channel:'))) lamp = label
    }
    if (overlay !== lastOverlay) {
      lastOverlay = overlay
      emit('overlay', { state: overlay })
    }
    if (lamp !== lastLamp) {
      lastLamp = lamp
      emit('lamp', { label: lamp })
    }
  }, 100)
})()
