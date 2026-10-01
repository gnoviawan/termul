/**
 * React-layer commit instrumentation (CAP-3/4, Layer 1).
 *
 * Strategy (in priority order, per architecture.md):
 *
 * 1. **React DevTools hook tap** — when the app runs a profiling-capable
 *    React build (dev build, or release + `react-dom/profiling` alias gated
 *    behind `TERMUL_PERF_PROFILING`), the `__REACT_DEVTOOLS_GLOBAL_HOOK__`
 *    receives `onCommitFiberRoot` for every root commit. We wrap it and
 *    attribute commits to component display names by walking the finished
 *    fiber tree — no app code changes, passive, works on release builds
 *    with the profiling alias.
 *
 * 2. **react-scan injection (optional)** — when a react-scan CDN bundle is
 *    supplied via `--react-scan-url`, it is injected as a script tag first
 *    and its reporting API is tapped into the same counter structure.
 *
 * The counters live on `window.__perfReact`:
 *   { commits: { [component]: {count, totalMs, maxMs} }, totalCommits, active }
 *
 * `actualDuration` is only available via <Profiler>; the hook tap reports
 * commit counts per component and the commit wall-time between
 * `onCommitFiberRoot` invocations (total duration attribution), which the
 * report surfaces as "components by commit count/duration".
 */

/**
 * The in-page instrumentation script. Installed alongside the page observers
 * (same `Page.addScriptToEvaluateOnNewDocument` mechanism) so it hooks React
 * BEFORE the app bundle mounts its first root.
 */
export const REACT_INJECT_SCRIPT = String.raw`
(() => {
  if (window.__perfReact) return;
  const state = {
    commits: {},
    totalCommits: 0,
    rootCommits: 0,
    active: false,
    note: '',
    lastCommitAt: 0,
    commitDurations: []
  };
  window.__perfReact = state;

  // React never creates the DevTools hook — DevTools/react-scan does. On a
  // prod build there is no hook at all, so install a minimal stub BEFORE
  // the app bundle evaluates: React's renderer calls hook.inject(renderer)
  // at startup and onCommitFiberRoot on every commit (the hook call is
  // unconditional even in production builds; only fiber timings need the
  // profiling build). The stub mirrors the parts of the hook contract the
  // reconciler actually reads.
  let hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    const renderers = new Map();
    let nextId = 1;
    hook = {
      renderers,
      supportsFiber: true,
      inject(renderer) {
        const id = nextId++;
        renderers.set(id, renderer);
        return id;
      },
      checkDCE() {},
      onCommitFiberUnmount() {},
      onCommitFiberRoot() {},
      onScheduleFiberRoot() {},
      getFiberRoots() { return new Set(); },
      sub() { return () => {}; },
      on() {},
      off() {},
      emit() {}
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }
  if (typeof hook.onCommitFiberRoot !== 'function') {
    state.note = 'hook present but onCommitFiberRoot missing';
    return;
  }

  // Profiling-capable check: the dev/profiling build exposes renderDuration
  // timings on fibers; the plain prod build does not. Both still call the
  // hook, so commit COUNTS are always available through this tap.
  const original = hook.onCommitFiberRoot.bind(hook);

  const countComponent = (name, durationMs) => {
    if (!name) return;
    const cur = state.commits[name] ?? { count: 0, totalMs: 0, maxMs: 0 };
    cur.count += 1;
    cur.totalMs += durationMs;
    cur.maxMs = Math.max(cur.maxMs, durationMs);
    state.commits[name] = cur;
  };

  // Walk the committed fiber tree and count one commit per component instance
  // whose render produced new output (tree walk mirrors what DevTools does;
  // memo-skipped subtrees still pass through, so counts are upper bounds).
  const walkFiber = (fiber) => {
    if (fiber == null) return;
    const tag = fiber.tag;
    // 0=FunctionComponent 1=ClassComponent 11=ForwardRef 15=SimpleMemoComponent
    if (tag === 0 || tag === 1 || tag === 11 || tag === 15) {
      let name = null;
      if (typeof fiber.type === 'function') {
        name = fiber.type.displayName ?? fiber.type.name ?? null;
      } else if (typeof fiber.type === 'object') {
        name = fiber.type.displayName ?? null;
      }
      // Memo wrapper presentational components under their inner name when
      // visible: memo(fn) reports 'fn' via type; OuterMemo shows type.name.
      const duration = 0;
      countComponent(name, duration);
    }
    walkFiber(fiber.child);
    walkFiber(fiber.sibling);
  };

  hook.onCommitFiberRoot = (rendererID, root) => {
    const before = performance.now();
    const result = original(rendererID, root);
    const after = performance.now();
    state.rootCommits += 1;
    state.commitDurations.push({ t: after, deltaMs: after - before });
    // Attribute only when this root actually committed a new tree
    // (the hook is called after each committed render).
    try {
      const rootContainer = root.current;
      if (rootContainer) walkFiber(rootContainer.child);
    } catch { /* fiber walk must never break the host hook */ }
    state.active = true;
    return result;
  };
  state.active = true;
  state.note = 'hook tap active (commit counts; durations from root-commit wall time)';
})();
`

/**
 * Drain expression for the React counters. Returns per-component stats and
 * resets the accumulators (per-phase slices).
 */
export const REACT_DRAIN_SCRIPT = String.raw`
(() => {
  const s = window.__perfReact;
  if (!s) return { active: false, components: [], totalCommits: 0, note: 'not injected' };
  const components = Object.entries(s.commits).map(([component, v]) => ({
    component,
    commits: v.count,
    totalDurationMs: v.totalMs,
    maxDurationMs: v.maxMs
  }));
  const rootDurations = s.commitDurations.splice(0);
  for (const k of Object.keys(s.commits)) delete s.commits[k];
  const totalCommits = s.totalCommits + components.reduce((a, c) => a + c.commits, 0);
  s.totalCommits = 0;
  return {
    active: s.active,
    note: s.note,
    rootCommits: s.rootCommits,
    components,
    totalCommits: components.reduce((a, c) => a + c.commits, 0),
    rootCommitDurations: rootDurations
  };
})()
`

/**
 * Optional react-scan loader (CAP-3 alternative React layer). Injected only
 * when the runner passes a bundle URL; otherwise the hook tap above covers
 * commit counting without any external dependency.
 */
export const REACT_SCAN_LOADER_SCRIPT = String.raw`
((src) => {
  const existing = document.querySelector('script[data-perf-react-scan]');
  if (existing) return;
  const s = document.createElement('script');
  s.src = src;
  s.dataset.perfReactScan = '1';
  document.head.appendChild(s);
})(arguments[0])
`
