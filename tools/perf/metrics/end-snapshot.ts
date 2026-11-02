/**
 * End-of-run memory snapshot, taken after the scenario finishes and before
 * teardown. Phase series mix uncollected garbage with retained memory; this
 * forces a full GC first so the heap number is what the app actually keeps,
 * then splits private bytes by process role so a renderer leak, GPU growth
 * and an unrequested child process read as different numbers.
 *
 * It also records the two counts every keep-or-revert decision needs: how
 * much work the fake agents emitted, and how many errors the app logged.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from 'playwright'
import type { EndSnapshot, ProcessRole } from '../types.ts'

const execFileAsync = promisify(execFile)

const DEV_IDENTIFIER = 'com.termul-manager.app.dev'

interface TreeProcess {
  pid: number
  name: string
  commandLine: string
  privateBytes: number
}

async function sampleTreeWithCommandLines(rootPid: number): Promise<TreeProcess[]> {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine',
    `$seen = @{}; $seen[${rootPid}] = $true; $changed = $true`,
    'while ($changed) { $changed = $false; foreach ($p in $all) { if ($seen.ContainsKey([int]$p.ParentProcessId) -and -not $seen.ContainsKey([int]$p.ProcessId)) { $seen[[int]$p.ProcessId] = $true; $changed = $true } } }',
    '$out = @()',
    'foreach ($p in $all) { if ($seen.ContainsKey([int]$p.ProcessId)) { $gp = Get-Process -Id $p.ProcessId; if ($gp) { $out += [pscustomobject]@{ pid = $p.ProcessId; name = $p.Name; commandLine = [string]$p.CommandLine; privateBytes = $gp.PrivateMemorySize64 } } } }',
    'ConvertTo-Json -InputObject @($out) -Compress'
  ].join('\n')
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  )
  const parsed: unknown = JSON.parse(stdout.trim() || '[]')
  if (!Array.isArray(parsed)) return []
  return parsed.map((p: Record<string, unknown>) => ({
    pid: Number(p.pid),
    name: String(p.name ?? ''),
    commandLine: String(p.commandLine ?? ''),
    privateBytes: Number(p.privateBytes ?? 0)
  }))
}

export function classifyProcess(name: string, commandLine: string): ProcessRole {
  if (/msedgewebview2/i.test(name)) {
    if (/--type=renderer/.test(commandLine)) return 'renderer'
    if (/--type=gpu-process/.test(commandLine)) return 'gpu'
    return 'webviewOther'
  }
  if (/termul-manager/i.test(name)) return 'host'
  if (/fake-agent[\\/]fake-agent\.ts/.test(commandLine)) return 'fakeAgent'
  return 'otherChild'
}

function countAppLogErrors(): number | null {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return null
  const logFile = path.join(localAppData, DEV_IDENTIFIER, 'logs', 'termul.log')
  if (!existsSync(logFile)) return null
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => /\]\[ERROR\]|Handler errored/.test(line)).length
}

function sumAgentStats(statsDir: string): { updates: number; textChars: number } | null {
  if (!existsSync(statsDir)) return null
  let updates = 0
  let textChars = 0
  for (const file of readdirSync(statsDir)) {
    try {
      const stats = JSON.parse(readFileSync(path.join(statsDir, file), 'utf8')) as {
        emittedUpdates?: number
        emittedTextChars?: number
      }
      updates += stats.emittedUpdates ?? 0
      textChars += stats.emittedTextChars ?? 0
    } catch {
      // A file caught mid-write is read again on the next run; skip it here.
    }
  }
  return { updates, textChars }
}

export async function captureEndSnapshot(
  page: Page,
  rootPid: number,
  agentStatsDir: string
): Promise<EndSnapshot> {
  const gaps: string[] = []
  const snapshot: EndSnapshot = {
    heapUsedAfterGcBytes: null,
    heapTotalAfterGcBytes: null,
    domNodes: null,
    domDocuments: null,
    jsEventListeners: null,
    privateBytesByRole: {
      renderer: 0,
      gpu: 0,
      webviewOther: 0,
      host: 0,
      fakeAgent: 0,
      otherChild: 0
    },
    appPrivateBytes: 0,
    otherChildren: [],
    appLogErrorLines: null,
    agentUpdatesEmitted: null,
    agentTextCharsEmitted: null,
    gaps
  }

  try {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.collectGarbage')
    const heap = await cdp.send('Runtime.getHeapUsage')
    snapshot.heapUsedAfterGcBytes = heap.usedSize
    snapshot.heapTotalAfterGcBytes = heap.totalSize
    const dom = await cdp.send('Memory.getDOMCounters')
    snapshot.domNodes = dom.nodes
    snapshot.domDocuments = dom.documents
    snapshot.jsEventListeners = dom.jsEventListeners
    await cdp.detach()
  } catch (err) {
    gaps.push(`heap/DOM snapshot failed: ${String(err)}`)
  }

  // Let the OS counters settle after the forced GC returned memory.
  await new Promise((resolve) => setTimeout(resolve, 2000))
  try {
    const tree = await sampleTreeWithCommandLines(rootPid)
    if (tree.length === 0) gaps.push('process tree sample returned nothing')
    for (const proc of tree) {
      const role = classifyProcess(proc.name, proc.commandLine)
      snapshot.privateBytesByRole[role] += proc.privateBytes
      if (role !== 'fakeAgent') snapshot.appPrivateBytes += proc.privateBytes
      if (role === 'otherChild') {
        snapshot.otherChildren.push({
          name: proc.name,
          privateBytes: proc.privateBytes,
          commandLine: proc.commandLine.slice(0, 200)
        })
      }
    }
  } catch (err) {
    gaps.push(`process tree sample failed: ${String(err)}`)
  }

  snapshot.appLogErrorLines = countAppLogErrors()
  if (snapshot.appLogErrorLines === null) gaps.push('app log not found')
  const agentStats = sumAgentStats(agentStatsDir)
  if (agentStats) {
    snapshot.agentUpdatesEmitted = agentStats.updates
    snapshot.agentTextCharsEmitted = agentStats.textChars
  }
  return snapshot
}
