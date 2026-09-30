/**
 * OS process counters (CAP-3, Layer 3) — Windows only, as specced.
 *
 * Samples the `msedgewebview2` renderer children of the PID tree the runner
 * spawned (root exe → children, recursively) via PowerShell `Get-Process` +
 * `Get-CimInstance Win32_Process` for parentage. Only processes under the
 * spawned root are ever counted, so other WebView2 apps on the machine
 * never contaminate the numbers (spec Isolation requirement).
 *
 * Private bytes come from `Get-Process` (`PrivateMemorySize64`), CPU % from
 * delta of `TotalProcessorTime` between samples (normalized by wall time
 * and logical core count — matches Task Manager's per-core accounting).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MetricSample, ProcessMetrics } from '../types.ts'

const execFileAsync = promisify(execFile)

export interface ProcessSample {
  t: number
  pid: number
  name: string
  parentPid: number | null
  privateBytes: number
  workingSet: number
  cpuSeconds: number
}

/** PowerShell snippet that walks the child tree of a root PID and samples. */
function buildQueryScript(rootPid: number): string {
  // Build the descendant set via BFS over Win32_Process ParentProcessId,
  // then join Get-Process for the counters. Output as JSON lines.
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name',
    '$byParent = @{}',
    'foreach ($p in $all) { $key = [int]$p.ParentProcessId; if (-not $byParent.ContainsKey($key)) { $byParent[$key] = @() }; $byParent[$key] += $p }',
    `$seen = New-Object System.Collections.Generic.HashSet[int]`,
    `$queue = New-Object System.Collections.Generic.Queue[int]`,
    `$queue.Enqueue(${rootPid})`,
    `[void]$seen.Add(${rootPid})`,
    'while ($queue.Count -gt 0) {',
    '  $cur = $queue.Dequeue()',
    '  if ($byParent.ContainsKey($cur)) {',
    '    foreach ($child in $byParent[$cur]) {',
    '      $cpid = [int]$child.ProcessId',
    '      if (-not $seen.Contains($cpid)) { [void]$seen.Add($cpid); $queue.Enqueue($cpid) }',
    '    }',
    '  }',
    '}',
    '$procs = @($all | Where-Object { $seen.Contains([int]$_.ProcessId) })',
    '$out = @()',
    'foreach ($p in $procs) {',
    '  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue',
    '  if ($gp) {',
    '    $out += [pscustomobject]@{',
    '      pid = $p.ProcessId',
    '      name = $p.Name',
    '      parentPid = $p.ParentProcessId',
    '      privateBytes = $gp.PrivateMemorySize64',
    '      workingSet = $gp.WorkingSet64',
    '      cpuSeconds = $gp.TotalProcessorTime.TotalSeconds',
    '    }',
    '  }',
    '}',
    '$out | ConvertTo-Json -Compress'
  ].join('\n')
}

/** One sampling invocation. Returns the samples plus wall ms for cadence. */
export async function sampleProcessTree(
  rootPid: number
): Promise<{ samples: ProcessSample[]; tookMs: number }> {
  const started = Date.now()
  const script = buildQueryScript(rootPid)
  const { stdout: text } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  )
  const tookMs = Date.now() - started
  let samples: ProcessSample[] = []
  try {
    const parsed: unknown = JSON.parse(text.trim() || '[]')
    if (Array.isArray(parsed)) {
      samples = parsed
        .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
        .map((p) => ({
          t: 0,
          pid: Number(p.pid),
          name: String(p.name ?? ''),
          parentPid: p.parentPid != null ? Number(p.parentPid) : null,
          privateBytes: Number(p.privateBytes ?? 0),
          workingSet: Number(p.workingSet ?? 0),
          cpuSeconds: Number(p.cpuSeconds ?? 0)
        }))
    } else if (parsed !== null && typeof parsed === 'object') {
      // Single-process result: PowerShell emits a bare object, not an array.
      const p = parsed as Record<string, unknown>
      samples = [
        {
          t: 0,
          pid: Number(p.pid),
          name: String(p.name ?? ''),
          parentPid: p.parentPid != null ? Number(p.parentPid) : null,
          privateBytes: Number(p.privateBytes ?? 0),
          workingSet: Number(p.workingSet ?? 0),
          cpuSeconds: Number(p.cpuSeconds ?? 0)
        }
      ]
    }
  } catch {
    // PowerShell failed or emitted nothing — surface an empty sample; the
    // collector records the gap explicitly (never silently).
    samples = []
  }
  return { samples, tookMs }
}

/** Logical processor count for CPU% normalization. */
export function logicalCoreCount(): number {
  return (
    (typeof navigator !== 'undefined' && Number(navigator.hardwareConcurrency) > 0
      ? Number(navigator.hardwareConcurrency)
      : 0) ||
    Number(process.env.NUMBER_OF_PROCESSORS) ||
    8
  )
}

export interface ProcessCollector {
  /** Start sampling at the given cadence (ms). */
  start(rootPid: number, cadenceMs: number): void
  /** Stop sampling; return the collected series. */
  stop(): ProcessMetrics
  /** Sampling errors recorded as explicit gaps. */
  errors: string[]
}

/**
 * Fixed-cadence sampler. Each tick samples the whole spawned tree; renderer
 * processes (name `msedgewebview2`) are split out from the root app process
 * so renderer private bytes is its own series (the incident metric).
 */
export function createProcessCollector(): ProcessCollector {
  let timer: ReturnType<typeof setInterval> | null = null
  const startedAt = Date.now()
  const privateSamples: MetricSample[] = []
  const workingSetSamples: MetricSample[] = []
  const cpuSamples: MetricSample[] = []
  const processes: Array<{ pid: number; name: string; parentPid: number | null }> = []
  const errors: string[] = []
  let lastCpuSeconds = 0
  let lastWall = startedAt
  let lastRootPid = -1

  const tick = async (rootPid: number): Promise<void> => {
    const { samples, tookMs } = await sampleProcessTree(rootPid)
    if (samples.length === 0) {
      if (errors.length < 20) errors.push(`sample at +${Date.now() - startedAt}ms returned nothing`)
      return
    }
    const now = Date.now()
    const t = now - startedAt
    // Renderer processes: msedgewebview2 children (the WebView2 hosts). The
    // network/GPU/renderer split means several processes — aggregate the
    // memory series as the SUM over renderer processes (footprint of the
    // webview layer) and CPU as the sum of deltas.
    let privateSum = 0
    let workingSum = 0
    let cpuSum = 0
    let sawRenderer = false
    for (const s of samples) {
      const known = processes.some((p) => p.pid === s.pid)
      if (!known) processes.push({ pid: s.pid, name: s.name, parentPid: s.parentPid })
      if (/msedgewebview2/i.test(s.name)) {
        sawRenderer = true
        privateSum += s.privateBytes
        workingSum += s.workingSet
        cpuSum += s.cpuSeconds
      }
    }
    if (!sawRenderer) {
      // The webview children may not exist yet during app boot; only record
      // a gap once the app has had time to create them.
      if (t > 10_000 && errors.length < 20) {
        errors.push(`no msedgewebview2 child in tree at +${t}ms`)
      }
      return
    }
    privateSamples.push({ t, value: privateSum })
    workingSetSamples.push({ t, value: workingSum })
    const dCpu = cpuSum - lastCpuSeconds
    const dWall = now - lastWall
    if (dWall > 0) {
      const cores = logicalCoreCount()
      const cpuPercent = Math.max(0, (dCpu / (dWall / 1000)) * (100 / cores))
      cpuSamples.push({ t, value: Math.round(cpuPercent * 10) / 10 })
    }
    lastCpuSeconds = cpuSum
    lastWall = now
    void tookMs
  }

  return {
    errors,
    start(rootPid: number, cadenceMs: number): void {
      lastRootPid = rootPid
      const runTick = () => {
        void tick(rootPid).catch((err: unknown) => {
          if (errors.length < 20) errors.push(`tick failed: ${String(err)}`)
        })
      }
      runTick()
      timer = setInterval(runTick, cadenceMs)
    },
    stop(): ProcessMetrics {
      if (timer) clearInterval(timer)
      timer = null
      void lastRootPid
      return {
        privateBytes: privateSamples,
        workingSet: workingSetSamples,
        cpuPercent: cpuSamples,
        processes
      }
    }
  }
}
