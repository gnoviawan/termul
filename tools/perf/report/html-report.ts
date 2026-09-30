/**
 * Result JSON → self-contained HTML report (CAP-6).
 *
 * Zero external dependencies: no CDN scripts, no fonts, no fetches. The
 * chart series are inlined as data and drawn with inline SVG (polyline
 * paths) — the report opens from the filesystem with the network off.
 *
 * Per-phase sections; each shows the headline numbers, the top LoAF
 * scripts by total blockingDuration (CAP-4), the top components by commit
 * count/duration, the heap series with its linear-regression slope, and
 * explicit gap lines for anything a collector failed to capture.
 */

import type { ComponentStat, LoafRecord, MetricSample, PerfRunResult, PhaseResult } from '../types'
import { slopeBytesPerSec } from '../types'

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function fmtBytes(v: number): string {
  if (v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = v
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtMs(v: number): string {
  return `${Math.round(v)} ms`
}

/** SVG sparkline for a value series (normalized 0..max). */
function sparkline(samples: MetricSample[], width = 480, height = 48): string {
  if (samples.length < 2) return ''
  const maxT = samples[samples.length - 1].t || 1
  let minV = Infinity
  let maxV = -Infinity
  for (const s of samples) {
    if (s.value < minV) minV = s.value
    if (s.value > maxV) maxV = s.value
  }
  if (maxV <= minV) maxV = minV + 1
  const pts = samples
    .map((s) => {
      const x = (s.t / maxT) * width
      const y = height - ((s.value - minV) / (maxV - minV)) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="series chart"><polyline points="${pts}" fill="none" stroke="#3b82f6" stroke-width="1.5"/></svg>`
}

/** Top LoAF scripts by total blockingDuration across a phase. */
function topLoafScripts(loaf: LoafRecord[], limit = 12): Array<{ name: string; totalMs: number }> {
  const byScript = new Map<string, number>()
  for (const frame of loaf) {
    for (const script of frame.scripts) {
      const key = script.sourceFunctionName
        ? `${script.sourceFunctionName} (${script.sourceUrl ?? 'unknown'})`
        : (script.name ?? 'script')
      byScript.set(key, (byScript.get(key) ?? 0) + script.duration)
    }
  }
  return [...byScript.entries()]
    .map(([name, totalMs]) => ({ name, totalMs }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
}

function phaseSection(phase: PhaseResult): string {
  const page = phase.page
  const react = phase.react
  const proc = phase.process
  const rows: string[] = []

  const stat = (label: string, value: string): string =>
    `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div></div>`

  if (page) {
    const loafBlocking = page.loaf.reduce((a, l) => a + l.blockingDuration, 0)
    rows.push(stat('LoAF count', String(page.loaf.length)))
    rows.push(stat('LoAF blocking total', fmtMs(loafBlocking)))
    rows.push(stat('Long tasks', String(page.longtasks.length)))
    rows.push(stat('Interactions', String(page.interactions.length)))
    const slowest = page.interactions.reduce((m, i) => Math.max(m, i.duration), 0)
    rows.push(stat('Slowest interaction', fmtMs(slowest)))
    if (page.heapUsed.length > 0) {
      const slope = slopeBytesPerSec(page.heapUsed)
      const end = page.heapUsed[page.heapUsed.length - 1].value
      rows.push(stat('JS heap end', fmtBytes(end)))
      rows.push(stat('Heap slope', `${fmtBytes(Math.abs(slope))}/s ${slope > 0 ? '↑' : '↓'}`))
    }
    for (const snap of page.cdp) {
      rows.push(stat('CDP Nodes', String(Math.round(snap.metrics.Nodes ?? 0))))
      rows.push(stat('CDP LayoutCount', String(Math.round(snap.metrics.LayoutCount ?? 0))))
      break // first snapshot of the phase is representative
    }
  } else {
    rows.push('<div class="stat gap">page metrics: absent</div>')
  }
  if (proc) {
    if (proc.privateBytes.length > 0) {
      const slope = slopeBytesPerSec(proc.privateBytes)
      const end = proc.privateBytes[proc.privateBytes.length - 1].value
      rows.push(stat('Renderer private bytes end', fmtBytes(end)))
      rows.push(
        stat('Private bytes slope', `${fmtBytes(Math.abs(slope))}/s ${slope > 0 ? '↑' : '↓'}`)
      )
    }
    if (proc.cpuPercent.length > 0) {
      const maxCpu = proc.cpuPercent.reduce((m, c) => Math.max(m, c.value), 0)
      rows.push(stat('Renderer CPU max', `${maxCpu.toFixed(1)}%`))
    }
  } else {
    rows.push('<div class="stat gap">process metrics: absent</div>')
  }
  if (react) {
    rows.push(stat('Commits', String(react.totalCommits)))
    rows.push(
      stat(
        'Profiling',
        react.profilingActive ? 'active' : `inactive (${react.profilingNote ?? 'unknown'})`
      )
    )
  } else {
    rows.push('<div class="stat gap">react metrics: absent</div>')
  }

  // Top components table (CAP-4)
  let componentTable = ''
  if (react && react.components.length > 0) {
    const top: ComponentStat[] = [...react.components]
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 15)
    componentTable = `
      <h3>Top components by commit count</h3>
      <table>
        <thead><tr><th>Component</th><th>Commits</th><th>Total ms</th><th>Max ms</th></tr></thead>
        <tbody>
          ${top
            .map(
              (c) =>
                `<tr><td>${esc(c.component)}</td><td>${c.commits}</td><td>${c.totalDurationMs.toFixed(1)}</td><td>${c.maxDurationMs.toFixed(1)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>`
  }

  // Top LoAF scripts table (CAP-4)
  let loafTable = ''
  if (page && page.loaf.length > 0) {
    const top = topLoafScripts(page.loaf)
    if (top.length > 0) {
      loafTable = `
      <h3>Top LoAF scripts by blocking duration</h3>
      <table>
        <thead><tr><th>Script</th><th>Total duration (ms)</th></tr></thead>
        <tbody>
          ${top.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.totalMs.toFixed(1)}</td></tr>`).join('')}
        </tbody>
      </table>`
    }
  }

  // Series charts
  let charts = ''
  if (page && page.heapUsed.length > 1) {
    charts += `<h3>JS heap</h3>${sparkline(page.heapUsed)}`
  }
  if (proc && proc.privateBytes.length > 1) {
    charts += `<h3>Renderer private bytes</h3>${sparkline(proc.privateBytes)}`
  }
  if (proc && proc.cpuPercent.length > 1) {
    charts += `<h3>Renderer CPU %</h3>${sparkline(proc.cpuPercent)}`
  }

  const gaps =
    phase.gaps.length > 0
      ? `<h3>Gaps</h3><ul class="gaps">${phase.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`
      : ''

  return `
  <section class="phase">
    <h2>${esc(phase.name)} <span class="muted">${fmtMs(phase.durationMs)}</span></h2>
    <div class="stats">${rows.join('')}</div>
    ${componentTable}
    ${loafTable}
    ${charts}
    ${gaps}
  </section>`
}

export function renderReport(result: PerfRunResult): string {
  const meta = result.meta
  const status = meta.status === 'ok' ? 'ok' : 'FAILED'
  const paramList = Object.entries(meta.params)
    .map(([k, v]) => `<span class="param">${esc(k)}=<b>${esc(String(v))}</b></span>`)
    .join(' ')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Termul perf — ${esc(meta.scenario)} ${esc(meta.runId)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0b0e14; color: #d7dde8; margin: 0; padding: 2rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 0; }
  h3 { font-size: .9rem; margin: 1.2rem 0 .4rem; color: #9fb2cc; text-transform: uppercase; letter-spacing: .04em; }
  .muted { color: #7d8ba3; font-weight: 400; font-size: .9em; }
  .header { border-bottom: 1px solid #1c2433; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .badges { display: flex; gap: .5rem; margin: .5rem 0; }
  .badge { padding: .15rem .6rem; border-radius: 999px; font-size: .75rem; border: 1px solid #2a3548; }
  .badge.ok { border-color: #22c55e; color: #4ade80; }
  .badge.failed { border-color: #ef4444; color: #f87171; }
  .params { display: flex; flex-wrap: wrap; gap: .75rem; margin: .5rem 0; }
  .param { font-size: .8rem; color: #9fb2cc; }
  .param b { color: #d7dde8; font-weight: 600; }
  .phase { background: #11151f; border: 1px solid #1c2433; border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: .5rem; margin-top: .75rem; }
  .stat { background: #0b0e14; border-radius: 8px; padding: .5rem .75rem; }
  .stat-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #7d8ba3; }
  .stat-value { font-size: 1.05rem; font-weight: 600; color: #e8edf5; margin-top: .1rem; }
  .gap { color: #f0b429; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .25rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #1c2433; }
  th { color: #9fb2cc; font-weight: 600; }
  td:nth-child(n+2) { text-align: right; font-variant-numeric: tabular-nums; }
  ul.gaps { margin: .25rem 0 0 1.25rem; padding: 0; font-size: .85rem; }
  svg { max-width: 100%; height: auto; background: #0b0e14; border-radius: 8px; margin-top: .25rem; }
  .summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: .5rem; }
</style>
</head>
<body>
<div class="header">
  <h1>${esc(meta.scenario)} — <span class="muted">${esc(meta.runId)}</span></h1>
  <div class="badges">
    <span class="badge ${status}">${status}</span>
    <span class="badge">${esc(meta.lane)} lane</span>
    <span class="badge">seed ${meta.seed}</span>
    ${meta.reactProfiling ? '<span class="badge">react-dom/profiling</span>' : ''}
  </div>
  <div class="muted">${esc(meta.startedAt)} · ${esc(meta.appTarget)}${meta.gitCommit ? ` · ${esc(meta.gitCommit.slice(0, 10))}` : ''}${meta.machine ? ` · ${esc(meta.machine)}` : ''}</div>
  <div class="params">${paramList}</div>
  ${meta.failure ? `<div class="gap">failure: ${esc(meta.failure)}</div>` : ''}
  <h3>Summary</h3>
  <div class="summary">
    ${Object.entries(result.summary)
      .map(
        ([k, v]) =>
          `<div class="stat"><div class="stat-label">${esc(k)}</div><div class="stat-value">${esc(
            k.includes('Bytes') || k.includes('Heap')
              ? fmtBytes(v)
              : String(Math.round(v * 100) / 100)
          )}</div></div>`
      )
      .join('')}
  </div>
</div>
${result.phases.map(phaseSection).join('')}
</body>
</html>`
}
