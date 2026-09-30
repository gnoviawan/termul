/**
 * pty-flood terminal output script (CAP-2, pty-flood vehicle).
 *
 * Spawned as a REAL terminal program through the app's PTY path
 * (`TerminalSpawnOptions.program: 'bun', args: [<this file>]` —
 * `resolve_program_path` accepts PE images, and `bun` resolves on PATH).
 *
 * Output is 100% canned/seeded (no Math.random, no network, no disk beyond
 * this file) so runs are reproducible. Payload styles mirror the generators
 * in scripts/benchmark-terminal-performance.ts (ANSI-heavy lines, wide
 * lines, big blocks) plus sustained-rate pacing and resize-churn via CSI
 * sequences.
 *
 * Knobs (env or CLI flags):
 *   PERF_FLOOD_LINES_PER_SEC — sustained line rate (default 200)
 *   PERF_FLOOD_DURATION       — seconds, 0 = forever (default 0)
 *   PERF_FLOOD_MODE           — ansi | wide | block | mixed (default mixed)
 *   PERF_FLOOD_SEED           — PRNG seed for content (default 42)
 *   PERF_FLOOD_RESIZE_EVERY   — emit a resize-ish CSI burst every N lines (0=off)
 */

const WORDS = [
  'build',
  'step',
  'compiled',
  'warn',
  'info',
  'trace',
  'module',
  'chunk',
  'asset',
  'entry',
  'hash',
  'tree',
  'shaken',
  'bundled',
  'minified',
  'sourcemap'
]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function generateLine(mode: string, i: number, rng: () => number): string {
  const word = WORDS[Math.floor(rng() * WORDS.length)]
  if (mode === 'ansi') {
    return `\u001b[32m[${String(i).padStart(6, '0')}]\u001b[0m ${word} ${'='.repeat(48)} ${rng()
      .toString(36)
      .slice(2, 10)}`
  }
  if (mode === 'wide') {
    return `Resize-churn line ${i}: ${'x'.repeat(100)}`
  }
  if (mode === 'block') {
    return `${word} ${'='.repeat(200)}`
  }
  // mixed: rotate flavors by line index
  const flavor = i % 3
  if (flavor === 0) return generateLine('ansi', i, rng)
  if (flavor === 1) return generateLine('wide', i, rng)
  return generateLine('block', i, rng)
}

function main(): void {
  const linesPerSec = Math.max(1, parseIntEnv('PERF_FLOOD_LINES_PER_SEC', 200))
  const durationSec = parseIntEnv('PERF_FLOOD_DURATION', 0)
  const mode = Bun.env.PERF_FLOOD_MODE ?? 'mixed'
  const seed = parseIntEnv('PERF_FLOOD_SEED', 42)
  const resizeEvery = parseIntEnv('PERF_FLOOD_RESIZE_EVERY', 0)
  const rng = mulberry32(seed)

  let intervalMs = Math.max(1, Math.round(1000 / linesPerSec))
  let i = 0
  const startedAt = Date.now()

  const tick = (): void => {
    if (durationSec > 0 && (Date.now() - startedAt) / 1000 >= durationSec) {
      process.stdout.write(`\u001b[0m\n[perf-flood] done after ${i} lines\n`)
      process.exit(0)
    }
    const line = generateLine(mode, i, rng)
    process.stdout.write(`${line}\r\n`)
    if (resizeEvery > 0 && i > 0 && i % resizeEvery === 0) {
      // Resize-churn burst: query + set cursor position sequences that force
      // xterm reflow work (what ConPTY resize events trigger downstream).
      process.stdout.write('\u001b[s\u001b[999;999H\u001b[6n\u001b[u')
    }
    i++
  }

  // CLI args override env when present (--lines-per-sec, --duration, ...)
  const argv = process.argv.slice(2)
  for (let a = 0; a < argv.length; a++) {
    if (argv[a] === '--lines-per-sec' && argv[a + 1]) {
      const v = Number(argv[a + 1])
      if (Number.isFinite(v) && v > 0) {
        intervalMs = Math.max(1, Math.round(1000 / v))
      }
    }
  }

  process.stdout.write(`[perf-flood] start mode=${mode} rate=${linesPerSec}/s seed=${seed}\r\n`)
  setInterval(tick, intervalMs)
}

// `main` runs only when executed directly (never on import for self-test).
if (import.meta.main) {
  main()
}

export { generateLine, mulberry32 }
