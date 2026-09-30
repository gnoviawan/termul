/**
 * In-page observer injection script (CAP-3, Layer 2).
 *
 * Installed via `Page.addScriptToEvaluateOnNewDocument` (primary) so it runs
 * before the app bundle on every navigation; Playwright's `addInitScript`
 * is the fallback. The script is fully self-contained: it registers
 * PerformanceObserver instances for long-animation-frame, longtask, and
 * event entries, a rAF cadence loop, and a performance.memory poller, then
 * buffers the results on `window.__perfCollect` for the collector to drain
 * over `Runtime.evaluate`.
 *
 * Kept as a string (not an imported TS module) because it must serialize
 * across the CDP boundary with zero bundler/runtime dependencies.
 */

export const PAGE_OBSERVER_SCRIPT = String.raw`
(() => {
  if (window.__perfCollect) return; // idempotent on re-injection
  const t0 = performance.now();
  const state = {
    loaf: [],
    longtasks: [],
    interactions: [],
    frames: [],
    heapUsed: [],
    heapTotal: [],
    eventKinds: [],
    startedAtWall: Date.now()
  };
  window.__perfCollect = state;
  window.__perfPhase = { name: 'boot', t0: performance.now() };

  // --- Long Animation Frames (CAP-4 attribution source) -------------------
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const loaf = {
          t: entry.startTime - t0,
          duration: entry.duration,
          blockingDuration: entry.blockingDuration ?? 0,
          scripts: []
        };
        // LoAF script attribution: entry.scripts[] (Timing-Of-Next-Frame-ish)
        const scripts = entry.scripts ?? [];
        for (const s of scripts) {
          loaf.scripts.push({
            name: s.name ?? s.invoker ?? 'script',
            duration: s.duration,
            sourceUrl: s.sourceURL || s.sourceUrl,
            sourceFunctionName: s.functionName,
            sourceLine: s.sourceLine != null ? String(s.sourceLine) : s.lineNumber,
            invoker: s.invoker
          });
        }
        state.loaf.push(loaf);
        if (state.loaf.length > 5000) state.loaf.splice(0, 1000);
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* LoAF unsupported — longtasks below carry attribution */ }

  // --- Long tasks (fallback jank signal) ----------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longtasks.push({
          t: entry.startTime - t0,
          duration: entry.duration,
          name: entry.name || 'task'
        });
        if (state.longtasks.length > 5000) state.longtasks.splice(0, 1000);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* longtask unsupported */ }

  // --- Interaction latency (INP-style, ps/ss per metrics-catalog) ---------
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = Math.max(0, entry.duration);
        state.interactions.push({
          t: entry.startTime - t0,
          duration: dur,
          name: entry.name || entry.entryType,
          startDelay: entry.processingStart != null
            ? entry.processingStart - entry.startTime
            : undefined
        });
        if (state.interactions.length > 5000) state.interactions.splice(0, 1000);
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch { /* event timing unsupported */ }

  // --- rAF cadence / dropped frames ----------------------------------------
  let lastFrame = performance.now();
  const rafLoop = (now) => {
    const delta = now - lastFrame;
    if (delta > 0) {
      state.frames.push({ t: now - t0, deltaMs: delta });
      if (state.frames.length > 20000) state.frames.splice(0, 4000);
    }
    lastFrame = now;
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);

  // --- Heap sampling --------------------------------------------------------
  const sampleHeap = () => {
    const mem = performance.memory;
    if (mem) {
      const t = performance.now() - t0;
      state.heapUsed.push({ t, value: mem.usedJSHeapSize });
      state.heapTotal.push({ t, value: mem.totalJSHeapSize });
    }
  };
  sampleHeap();
  setInterval(sampleHeap, 1000);

  // --- sessionUpdate event-kind tap (acp event listeners on window) --------
  // The app emits Tauri events through the event plugin; the kinds we care
  // about are captured by the collector via Runtime.evaluate on the store,
  // so this tap only records what global listeners see (best effort).
  const origDispatch = window.dispatchEvent.bind(window);
  window.dispatchEvent = (event) => {
    if (event && typeof event.type === 'string' && event.type.startsWith('acp:')) {
      state.eventKinds.push(event.type);
      if (state.eventKinds.length > 20000) state.eventKinds.splice(0, 4000);
    }
    return origDispatch(event);
  };
})();
`

/**
 * Marker helpers the runner evaluates in-page to delimit phases. Phases are
 * recorded as { name, t0, t1 } on `window.__perfPhases` so each phase's
 * metrics can be sliced by time window post-hoc.
 */
export const PHASE_START_SCRIPT = String.raw`
((name) => {
  window.__perfPhase = { name, t0: performance.now() };
  if (!window.__perfPhases) window.__perfPhases = [];
})(arguments[0])
`

export const PHASE_END_SCRIPT = String.raw`
((name) => {
  const cur = window.__perfPhase;
  if (!cur || cur.name !== name) return;
  if (!window.__perfPhases) window.__perfPhases = [];
  window.__perfPhases.push({ name: cur.name, t0: cur.t0, t1: performance.now() });
})(arguments[0])
`

/** Snapshot drain expression — returns the buffered observer state. */
export const DRAIN_SCRIPT = String.raw`
(() => {
  const s = window.__perfCollect;
  if (!s) return null;
  const snapshot = {
    loaf: s.loaf,
    longtasks: s.longtasks,
    interactions: s.interactions,
    frames: s.frames,
    heapUsed: s.heapUsed,
    heapTotal: s.heapTotal,
    eventKinds: s.eventKinds ? s.eventKinds.slice(-200) : [],
    phases: window.__perfPhases ?? []
  };
  // Reset the accumulation buffers (series continue from zero each phase).
  s.loaf = [];
  s.longtasks = [];
  s.interactions = [];
  s.frames = [];
  s.eventKinds = [];
  return snapshot;
})()
`
