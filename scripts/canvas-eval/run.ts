/**
 * Canvas eval runner (issue #1430). See README.md in this folder.
 *
 *   node scripts/canvas-eval/run.ts run --termul <exe> --figcraft <exe> [--only a,b] [--modes harness,baseline]
 *                                       [--model <id>] [--max-turns 120] [--timeout-min 30] [--out <dir>]
 *   node scripts/canvas-eval/run.ts judge --out <dir> [--model <id>]
 *   node scripts/canvas-eval/run.ts report --out <dir>
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDocument, type InspectedDocument, type Issue } from './checks.ts'
import { type CallRecord, lastSnapshotFailed } from './snapshot.ts'

interface Prompt {
  id: string
  lang: string
  domain: string
  prompt: string
}

interface RunResult {
  id: string
  mode: string
  prompt: string
  exitCode: number | null
  turns?: number
  costUsd?: number
  durationMs?: number
  calls: number
  failedCalls: number
  /** Calls after which the router could not save the document, so design.figcraft may be stale. */
  failedSnapshots: number
  /** The last snapshot failed, so `issues` describe an earlier state of the design. */
  staleIssues: boolean
  issues: Issue[]
  png?: string
}

type Scores = Record<'hierarchy' | 'typography' | 'color' | 'copy' | 'slop', number>

const HERE = dirname(fileURLToPath(import.meta.url))
const JUDGED = ['hierarchy', 'typography', 'color', 'copy', 'slop'] as const
const AGENT = process.env.CANVAS_EVAL_AGENT ?? 'claude'

function option(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`)
  const value = at >= 0 ? process.argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function runOne(prompt: Prompt, mode: string, out: string): RunResult {
  const dir = join(out, prompt.id, mode)
  mkdirSync(dir, { recursive: true })
  const termul = resolve(option('termul'))
  const figcraft = resolve(option('figcraft'))
  const router = join(HERE, 'mcp-router.ts')
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        termul: {
          command: process.execPath,
          args: [router, '--mode', mode, '--termul', termul, '--figcraft', figcraft, '--out', dir]
        }
      }
    })
  )
  const args = [
    '-p',
    prompt.prompt,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    'mcp__termul',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    option('max-turns', '120')
  ]
  const model = process.argv.includes('--model') ? option('model') : undefined
  if (model) args.push('--model', model)
  process.stdout.write(`${prompt.id} / ${mode}: running ${AGENT}\n`)
  const agent = spawnSync(AGENT, args, {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: Number(option('timeout-min', '30')) * 60_000
  })
  writeFileSync(join(dir, 'transcript.jsonl'), agent.stdout ?? '')
  writeFileSync(join(dir, 'agent-stderr.log'), agent.stderr ?? String(agent.error ?? ''))

  const final = lines(join(dir, 'transcript.jsonl'))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .findLast((event) => event.type === 'result')
  const calls = lines(join(dir, 'calls.jsonl')).map((line) => JSON.parse(line) as CallRecord)

  let png: string | undefined
  const design = join(dir, 'design.figcraft')
  if (existsSync(design)) {
    png = join(dir, 'design.png')
    spawnSync(figcraft, ['render', design, '-o', png, '--no-system-fonts'], { encoding: 'utf8' })
    if (!existsSync(png)) png = undefined
  }
  const documentPath = join(dir, 'document.json')
  const issues = existsSync(documentPath)
    ? checkDocument(readJson<InspectedDocument>(documentPath))
    : [{ kind: 'empty-canvas' as const, detail: 'the agent changed nothing' }]

  const result: RunResult = {
    id: prompt.id,
    mode,
    prompt: prompt.prompt,
    exitCode: agent.status,
    turns: final?.num_turns as number | undefined,
    costUsd: final?.total_cost_usd as number | undefined,
    durationMs: final?.duration_ms as number | undefined,
    calls: calls.length,
    failedCalls: calls.filter((call) => call.isError).length,
    failedSnapshots: calls.filter((call) => call.snapshotError).length,
    staleIssues: lastSnapshotFailed(calls),
    issues,
    png
  }
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  process.stdout.write(
    `${prompt.id} / ${mode}: ${calls.length} calls, ${issues.length} integrity issues, ${png ? 'rendered' : 'no image'}${result.failedSnapshots ? `, ${result.failedSnapshots} failed snapshots` : ''}${result.staleIssues ? ' (the last one failed: the integrity issues are from an earlier state)' : ''}\n`
  )
  return result
}

function results(out: string): RunResult[] {
  return readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'judge')
    .flatMap((entry) =>
      readdirSync(join(out, entry.name)).map((mode) => join(out, entry.name, mode, 'result.json'))
    )
    .filter(existsSync)
    .map((path) => readJson<RunResult>(path))
}

function judgePrompt(): string {
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8')
  const match = rubric.match(/## Judge prompt[\s\S]*?```text\n([\s\S]*?)```/)
  if (!match) throw new Error('rubric.md has no judge prompt block')
  return match[1]
}

function judge(out: string) {
  const dir = join(out, 'judge')
  mkdirSync(dir, { recursive: true })
  const runs = results(out).filter((run) => run.png)
  const shuffled = runs
    .map((run) => ({ run, order: Math.random() }))
    .sort((a, b) => a.order - b.order)
  const key: Record<string, { id: string; mode: string }> = {}
  const scores: Record<string, Scores & { notes?: string }> = {}
  const template = judgePrompt()
  shuffled.forEach(({ run }, index) => {
    const blind = `design-${String(index + 1).padStart(2, '0')}`
    const image = join(dir, `${blind}.png`)
    copyFileSync(run.png as string, image)
    key[blind] = { id: run.id, mode: run.mode }
    const text = template.replace('{prompt}', run.prompt).replace('{image}', image)
    const args = [
      '-p',
      text,
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
      '--output-format',
      'json'
    ]
    if (process.argv.includes('--model')) args.push('--model', option('model'))
    const reply = spawnSync(AGENT, args, {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    try {
      const answer = String((JSON.parse(reply.stdout) as { result?: string }).result ?? '')
      scores[blind] = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1))
      process.stdout.write(`${blind}: ${JSON.stringify(scores[blind])}\n`)
    } catch {
      process.stdout.write(`${blind}: the judge gave no scores\n`)
    }
  })
  writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 2))
  writeFileSync(join(dir, 'scores.json'), JSON.stringify(scores, null, 2))
}

function report(out: string) {
  const dir = join(out, 'judge')
  const key = existsSync(join(dir, 'key.json'))
    ? readJson<Record<string, { id: string; mode: string }>>(join(dir, 'key.json'))
    : {}
  const scores = existsSync(join(dir, 'scores.json'))
    ? readJson<Record<string, Partial<Scores>>>(join(dir, 'scores.json'))
    : {}
  const overrides = existsSync(join(dir, 'overrides.json'))
    ? readJson<Record<string, Partial<Scores>>>(join(dir, 'overrides.json'))
    : {}
  const blindOf = (run: RunResult) =>
    Object.keys(key).find((blind) => key[blind].id === run.id && key[blind].mode === run.mode)

  const rows = results(out).map((run) => {
    const blind = blindOf(run)
    const judged = blind ? { ...scores[blind], ...overrides[blind] } : {}
    const integrity = Math.max(1, 5 - run.issues.length)
    const items = JUDGED.map((item) => judged[item]).filter(
      (v): v is number => typeof v === 'number'
    )
    // Integrity read from an earlier snapshot would score a design the agent moved past.
    const score =
      items.length === JUDGED.length && !run.staleIssues ? median([integrity, ...items]) : undefined
    return { run, integrity, score }
  })
  const table = [
    '| Prompt | Mode | Score | Integrity issues | Calls | Turns | Failed snapshots |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows
      .sort((a, b) => a.run.id.localeCompare(b.run.id) || a.run.mode.localeCompare(b.run.mode))
      .map(
        ({ run, score }) =>
          `| ${run.id} | ${run.mode} | ${score ?? (run.staleIssues ? 'stale snapshot' : 'not judged')} | ${run.issues.length} | ${run.calls} | ${run.turns ?? '?'} | ${run.failedSnapshots ?? '?'}${run.staleIssues ? ', last one stale' : ''} |`
      )
  ]
  const summary = [...new Set(rows.map((row) => row.run.mode))].map((mode) => {
    const of = rows.filter((row) => row.run.mode === mode)
    const judged = of.flatMap((row) => (row.score === undefined ? [] : [row.score]))
    const failing = of.filter((row) => row.run.issues.length > 0 && !row.run.staleIssues).length
    const stale = of.filter((row) => row.run.staleIssues).length
    return `- ${mode}: ${of.length} runs, ${judged.length} judged${stale ? ` (${stale} with a stale snapshot left out)` : ''}, median score ${judged.length ? median(judged) : 'n/a'}, ${failing} with integrity issues, median ${median(of.map((row) => row.run.calls))} calls`
  })
  const text = ['# Canvas eval report', '', ...summary, '', ...table, ''].join('\n')
  writeFileSync(join(out, 'report.md'), text)
  process.stdout.write(text)
}

const command = process.argv[2]
const out = resolve(
  option('out', join(HERE, 'out', new Date().toISOString().replace(/[:.]/g, '-')))
)
if (command === 'run') {
  mkdirSync(out, { recursive: true })
  const only = process.argv.includes('--only') ? option('only').split(',') : undefined
  const modes = option('modes', 'harness,baseline').split(',')
  const prompts = readJson<Prompt[]>(join(HERE, 'prompts.json')).filter(
    (prompt) => !only || only.includes(prompt.id)
  )
  for (const prompt of prompts) for (const mode of modes) runOne(prompt, mode, out)
  report(out)
} else if (command === 'judge') {
  judge(out)
  report(out)
} else if (command === 'report') {
  report(out)
} else {
  process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
  process.exit(command ? 2 : 0)
}
