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
import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs'
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
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate',
    // A child is created after the app root; an older process whose parent
    // PID was recycled onto a PID in this tree is not part of the app.
    `$rootStart = ($all | Where-Object { $_.ProcessId -eq ${rootPid} }).CreationDate`,
    '$all = @($all | Where-Object { $_.CreationDate -ge $rootStart })',
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

/**
 * Chromium memory-infra dump of the renderer: where its private bytes sit
 * (v8, blink_gc, partition_alloc, malloc, cc, skia, ...), per top-level
 * allocator, in bytes. Returns null when tracing is unavailable.
 */
async function rendererAllocatorBreakdown(page: Page): Promise<Record<string, number> | null> {
  const browser = page.context().browser()
  if (!browser) return null
  const session = await browser.newBrowserCDPSession()
  const events: Array<{
    ph?: string
    pid?: number
    args?: {
      dumps?: { allocators?: Record<string, { attrs?: Record<string, { value?: string }> }> }
    }
  }> = []
  session.on('Tracing.dataCollected', (payload: { value: typeof events }) => {
    events.push(...payload.value)
  })
  const complete = new Promise<void>((resolve) =>
    session.once('Tracing.tracingComplete', () => resolve())
  )
  await session.send('Tracing.start', {
    traceConfig: { includedCategories: ['disabled-by-default-memory-infra'] },
    transferMode: 'ReportEvents'
  })
  await session.send('Tracing.requestMemoryDump', {
    deterministic: true,
    levelOfDetail: 'detailed'
  })
  await session.send('Tracing.end')
  await complete
  await session.detach()
  const totals = new Map<number, Record<string, number>>()
  for (const event of events) {
    const allocators = event.ph === 'v' ? event.args?.dumps?.allocators : undefined
    if (!allocators || event.pid === undefined) continue
    const perPid = totals.get(event.pid) ?? {}
    for (const [name, dump] of Object.entries(allocators)) {
      if (name.includes('/')) continue
      const size = dump.attrs?.size?.value
      if (size) perPid[name] = (perPid[name] ?? 0) + Number.parseInt(size, 16)
    }
    totals.set(event.pid, perPid)
  }
  // The renderer is the process whose dump carries blink_gc.
  for (const perPid of totals.values()) if ('blink_gc' in perPid) return perPid
  return null
}

/** Write a V8 heap snapshot of the page to `file` (for retainer analysis). */
export async function writeHeapSnapshot(page: Page, file: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const out = createWriteStream(file)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (payload: { chunk: string }) => {
    out.write(payload.chunk)
  })
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  await new Promise<void>((resolve) => out.end(resolve))
  await cdp.detach()
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

  try {
    snapshot.domCensus = await page.evaluate<Array<{ key: string; count: number }>>(`(() => {
      const counts = new Map()
      const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1)
      for (const el of document.querySelectorAll('*')) {
        bump('tag:' + el.tagName.toLowerCase())
        if (el.hasAttribute('data-sd-animate')) bump('attr:data-sd-animate')
        const tab = el.closest('[data-chat-tab-state]')
        bump(tab ? 'chat-tab:' + tab.getAttribute('data-chat-tab-state') : 'outside-chat-tabs')
      }
      bump('chat-tabs:' + document.querySelectorAll('[data-chat-tab-state]').length)
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([key, count]) => ({ key, count }))
    })()`)
  } catch (err) {
    gaps.push(`DOM census failed: ${String(err)}`)
  }

  try {
    snapshot.pageState = await page.evaluate<Record<string, string | number>>(`(() => {
      const state = { visibility: document.visibilityState, focused: String(document.hasFocus()) }
      for (const el of document.querySelectorAll('[data-row-reveal]')) {
        const key = 'rowReveal:' + el.getAttribute('data-row-reveal')
        state[key] = (state[key] ?? 0) + 1
      }
      const items = document.querySelectorAll('[data-slot="message-scroller-item"]')
      state.scrollerItems = items.length
      state.chatTabs = document.querySelectorAll('[role="tablist"] [role="tab"]').length
      let maxRows = 0
      for (const item of items) {
        maxRows = Math.max(maxRows, item.querySelectorAll('[data-row-reveal]').length)
      }
      state.maxRowsInOneItem = maxRows
      for (const entry of performance.getEntriesByType('resource')) {
        const file = entry.name.split('/').pop() ?? ''
        if (/^(AgentChatPanel|tauri-index)-/.test(file)) state['chunk:' + file] = 1
      }
      for (const animation of document.getAnimations()) {
        const key = 'animation:' + animation.playState
        state[key] = (state[key] ?? 0) + 1
      }
      return state
    })()`)
  } catch (err) {
    gaps.push(`page state failed: ${String(err)}`)
  }

  try {
    snapshot.rendererAllocators = (await rendererAllocatorBreakdown(page)) ?? undefined
    if (!snapshot.rendererAllocators) gaps.push('memory-infra dump had no renderer process')
  } catch (err) {
    gaps.push(`memory-infra dump failed: ${String(err)}`)
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
