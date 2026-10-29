// One-shot PR reviewer for GitHub Actions. Uses the @cursor/sdk local runtime:
// the agent loop runs on the runner, reads the checked-out PR head, and the
// model call bills to the CURSOR_API_KEY owner. Read-only tools, no shell.
//
// Env:
//   CURSOR_API_KEY   Cursor user API key (secret).
//   GITHUB_TOKEN     Token with pull-requests: write (only needed to post).
//   REPO             owner/name.
//   PR_NUMBER        Pull request number.
//   HEAD_SHA         PR head commit (the checkout).
//   BASE_SHA         PR base commit. With full history in WORKSPACE, the diff is
//                    built locally with 15 lines of context; else from the API.
//   WORKSPACE        Checkout path. Default: cwd.
//   DRY_RUN=1        Print the review instead of posting it.
//   MODEL_FAST=0     Use the non-fast model. Default is fast (non-fast missed 20 min on a 2k-line PR).
//   REVIEW_TIMEOUT_MS  Hard cap for the whole review. Default 1_500_000 (25 min).
//   PROMPT_ONLY=1    Print the run section and prompt size, then exit.
//   TOOL_BUDGET      Exploration tool calls before a forced wrap-up. 0 = no budget (default).
//
// Exploration stops at TOOL_BUDGET tool calls or at 70% of the timeout, then
// a follow-up turn on the same agent asks for post_findings with what it has.
import { execFileSync } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from '@cursor/sdk'
import { hasBotReview, REVIEWS_PER_PAGE } from './reviews.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_DIFF_CHARS = 300_000
const SEVERITIES = new Set(['high', 'medium', 'low'])

const env = (name, fallback) => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`missing env ${name}`)
  }
  return value
}

const apiKey = env('CURSOR_API_KEY')
const repo = env('REPO')
const prNumber = Number(env('PR_NUMBER'))
const headSha = env('HEAD_SHA')
const baseSha = process.env.BASE_SHA ?? ''
const workspace = env('WORKSPACE', process.cwd())
const dryRun = env('DRY_RUN', '0') === '1'
const fast = env('MODEL_FAST', '1') === '1'
const timeoutMs = Number(env('REVIEW_TIMEOUT_MS', '1500000'))
const toolBudget = Number(env('TOOL_BUDGET', '0'))
const githubToken = process.env.GITHUB_TOKEN ?? ''
const marker = `<!-- termul-reviewer:${headSha} -->`

// Keep secrets out of the agent's process env view and out of any output.
const secrets = [apiKey, githubToken].filter((s) => s.length >= 8)
delete process.env.CURSOR_API_KEY
delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN
const redact = (text) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), text)

async function gh(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'x-github-api-version': '2022-11-28',
      ...init.headers
    }
  })
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`
    )
  }
  return response
}

async function alreadyReviewed() {
  if (githubToken === '') return false
  const fetchPage = async (page) => {
    const path = `/repos/${repo}/pulls/${prNumber}/reviews?per_page=${REVIEWS_PER_PAGE}&page=${page}`
    return (await gh(path)).json()
  }
  return hasBotReview(fetchPage, marker)
}

async function loadDiff() {
  const response = await gh(`/repos/${repo}/pulls/${prNumber}`, {
    headers: { accept: 'application/vnd.github.diff' }
  })
  const text = await response.text()
  return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n…[truncated]\n` : text
}

const git = (...args) =>
  execFileSync('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// Diff with wide context from the local checkout. Falls back to the API diff.
async function loadContextDiff() {
  if (baseSha !== '') {
    try {
      const mergeBase = git('merge-base', baseSha, headSha).trim()
      for (const unified of [15, 8, 3]) {
        const text = git('diff', `-U${unified}`, '--no-color', mergeBase, headSha)
        if (text.length <= MAX_DIFF_CHARS) return { text, unified }
      }
    } catch (error) {
      console.log(
        `local diff unavailable (${String(error.message).split('\n')[0]}); using API diff`
      )
    }
  }
  return { text: await loadDiff(), unified: 3 }
}

// Changed files, new-file line ranges of each hunk, and status.
function parseDiff(text) {
  const files = new Map()
  let current = null
  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) {
      current = { path: header[2], ranges: [], deleted: false }
      files.set(current.path, current)
      continue
    }
    if (current === null) continue
    if (line.startsWith('+++ /dev/null')) current.deleted = true
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      current.ranges.push([start, start + Math.max(count, 1) - 1])
    }
  }
  return files
}

const SOURCE_RE = /\.(tsx?|jsx?|mjs|rs)$/
const TEST_RE = /(\.test\.|\.spec\.|__tests__|\/tests?\/)/

// Direct imports of each changed file and files that import it (via ripgrep).
function relatedFiles(files) {
  const changed = [...files.values()].filter(
    (f) => !f.deleted && SOURCE_RE.test(f.path) && !TEST_RE.test(f.path)
  )
  const lines = []
  for (const f of changed) {
    let imports = []
    try {
      const src = git('show', `${headSha}:${f.path}`)
      imports = [...src.matchAll(/from\s+['"]((?:@\/|\.)[^'"]+)['"]/g)].map((m) => m[1])
      imports = [...new Set(imports)].slice(0, 15)
    } catch {}
    const stem = f.path.replace(/^.*\//, '').replace(SOURCE_RE, '')
    let callers = []
    if (/\.(tsx?|jsx?|mjs)$/.test(f.path) && stem !== 'index') {
      try {
        // git grep is on every runner; ripgrep is not.
        callers = git('grep', '-l', '-E', `from ['"][^'"]*/${stem}['"]`, '--', 'src')
          .split('\n')
          .filter((p) => p !== '' && p !== f.path && !TEST_RE.test(p))
          .slice(0, 8)
      } catch {}
    }
    lines.push(
      `- ${f.path}` +
        (imports.length ? `\n  imports: ${imports.join(', ')}` : '') +
        (callers.length ? `\n  imported by: ${callers.join(', ')}` : '')
    )
  }
  return lines.join('\n')
}

const flatten = (v) => String(v).replace(/\s+/g, ' ').trim()

function reviewBody(findings) {
  const verdict = findings.length === 0 ? 'CLEAN' : 'FINDINGS'
  const lines = ['## Thermo review', '', `**Verdict:** ${verdict}`]
  for (const f of findings) {
    lines.push(`- **${f.severity}** \`${flatten(f.file)}:${f.line}\` — ${flatten(f.title)}`)
    lines.push(`  ${flatten(f.scenario)} ${flatten(f.detail)}`)
  }
  lines.push('', marker)
  return redact(lines.join('\n'))
}

function validFinding(f) {
  return (
    f !== null &&
    typeof f === 'object' &&
    SEVERITIES.has(f.severity) &&
    typeof f.file === 'string' &&
    f.file.length > 0 &&
    f.file.length <= 240 &&
    Number.isInteger(f.line) &&
    f.line > 0 &&
    typeof f.title === 'string' &&
    f.title.length > 0 &&
    f.title.length <= 160 &&
    typeof f.scenario === 'string' &&
    f.scenario.length > 0 &&
    f.scenario.length <= 400 &&
    typeof f.detail === 'string' &&
    f.detail.length > 0 &&
    f.detail.length <= 280
  )
}

async function main() {
  if (!dryRun && (await alreadyReviewed())) {
    console.log(`Already reviewed ${repo}#${prNumber} at ${headSha}. Skipping.`)
    return
  }

  const instructions = await readFile(join(HERE, 'instructions.md'), 'utf8')
  const { text: diff, unified } = await loadContextDiff()
  const changedFiles = parseDiff(diff)
  const related = relatedFiles(changedFiles)
  let findings

  // A finding must sit inside a hunk of a changed file (new-file lines).
  const inChangedHunk = (f) => {
    const file = changedFiles.get(f.file.replace(/^\.\//, ''))
    return file?.ranges.some(([lo, hi]) => f.line >= lo && f.line <= hi) ?? false
  }

  const prompt = [
    instructions,
    '',
    '## This run',
    `Pull request ${repo}#${prNumber}. Your working directory is the repository checked out at the PR head (${headSha}).`,
    'Steps:',
    '1. Read the diff and the file map below. They are your main context.',
    '2. List the suspected bugs to yourself, riskiest first.',
    `3. Confirm each by reading only the lines you need in a changed file or a file from the map.${toolBudget > 0 ? ` Budget: about ${toolBudget} read/grep/glob/ls calls in total.` : ''} No repo-wide searches.`,
    '4. Call post_findings once with the confirmed findings only.',
    'No shell. Do not build, run, or test anything.',
    '',
    '## Changed files, their direct imports, and files that import them',
    related || '(none)',
    '',
    `<diff context_lines="${unified}">`,
    diff,
    '</diff>'
  ].join('\n')

  if (process.env.PROMPT_ONLY === '1') {
    console.log(prompt.slice(prompt.indexOf('## This run'), prompt.indexOf('<diff')))
    console.log(
      `prompt_chars=${prompt.length} diff_chars=${diff.length} context_lines=${unified} files=${changedFiles.size}`
    )
    return
  }
  const startedAt = Date.now()
  const agent = await Agent.create({
    apiKey,
    name: `termul-review-${prNumber}-${headSha.slice(0, 7)}`,
    model: {
      id: 'grok-4.7',
      params: [
        { id: 'reasoning_effort', value: 'high' },
        { id: 'context', value: '500k' },
        { id: 'fast', value: fast ? 'true' : 'false' }
      ]
    },
    tools: ['read', 'grep', 'glob', 'ls', 'mcp'],
    local: {
      cwd: workspace,
      settingSources: [],
      customTools: {
        post_findings: {
          description:
            'Record the review for this pull request. Call once. Empty findings = CLEAN.',
          inputSchema: {
            type: 'object',
            properties: {
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                    file: { type: 'string' },
                    line: { type: 'integer', minimum: 1 },
                    title: { type: 'string', maxLength: 160 },
                    scenario: { type: 'string', maxLength: 400 },
                    detail: { type: 'string', maxLength: 280 }
                  },
                  required: ['severity', 'file', 'line', 'title', 'scenario', 'detail']
                }
              }
            },
            required: ['findings']
          },
          execute({ findings: raw }) {
            if (!Array.isArray(raw) || !raw.every(validFinding)) {
              return {
                content: [
                  { type: 'text', text: 'Invalid findings. Check the schema and call again.' }
                ],
                isError: true
              }
            }
            const outside = raw.filter((f) => !inChangedHunk(f))
            if (outside.length > 0) {
              const where = outside.map((f) => `${f.file}:${f.line}`).join(', ')
              return {
                content: [
                  {
                    type: 'text',
                    text: `These are not on lines this PR changed: ${where}. Point each finding at the changed line that causes it, or drop it, then call again.`
                  }
                ],
                isError: true
              }
            }
            findings = raw
            return 'Recorded. Stop now.'
          }
        }
      }
    }
  })

  const deadline = startedAt + timeoutMs
  let tools = 0
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  }
  const requests = []

  // One turn. Cancels when `stopAt` passes or, if `budget` is set, when the
  // turn has used that many tool calls.
  async function turn(message, stopAt, budget) {
    const run = await agent.send(message)
    let stopped = null
    const stop = (why) => {
      if (stopped !== null) return
      stopped = why
      console.log(`[stop] ${why}`)
      void run.cancel()
    }
    const timer = setTimeout(() => stop('time'), Math.max(0, stopAt - Date.now()))
    let used = 0
    for await (const event of run.stream()) {
      if (event.type === 'tool_call' && event.status === 'running') {
        tools += 1
        used += 1
        console.log(`[tool] ${event.name}`)
        if (budget !== undefined && used >= budget && event.name !== 'mcp') stop('tool budget')
      }
    }
    const result = await run.wait()
    clearTimeout(timer)
    requests.push(result.requestId ?? '-')
    for (const key of Object.keys(totals)) totals[key] += result.usage?.[key] ?? 0
    return result
  }

  let result = await turn(
    prompt,
    startedAt + timeoutMs * 0.7,
    toolBudget > 0 ? toolBudget : undefined
  )
  if (findings === undefined) {
    console.log('[wrap-up] asking for post_findings now')
    result = await turn(
      'Your tool budget is spent. Do not call read, grep, glob, or ls again. Call post_findings now with every bug you have concrete evidence for from the diff and the code you already read, each on its changed line with a concrete scenario. Drop only items you now think are wrong or are style.',
      deadline
    )
  }
  const elapsed = Date.now() - startedAt

  const usage = totals
  console.log(
    `status=${result.status} elapsed_ms=${elapsed} tools=${tools} requests=${requests.join(',')}`
  )
  if (usage) {
    console.log(
      `tokens in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens} reasoning=${usage.reasoningTokens}`
    )
  }
  try {
    const billed = await agent.getUsage()
    if (billed.cost)
      console.log(
        `cost charged_cents=${billed.cost.chargedCents} raw_cents=${billed.cost.rawCostCents}`
      )
  } catch (error) {
    console.log(`cost unavailable (${error.code ?? error.message})`)
  }
  if (process.env.REVIEW_METRICS_FILE) {
    await writeFile(
      process.env.REVIEW_METRICS_FILE,
      JSON.stringify({ status: result.status, elapsedMs: elapsed, tools, usage, findings }, null, 2)
    )
  }

  await agent[Symbol.asyncDispose]()

  if (findings === undefined) {
    throw new Error(`Run ended (${result.status}) without calling post_findings.`)
  }
  const body = reviewBody(findings)
  if (dryRun) {
    console.log('--- DRY RUN: review not posted ---')
    console.log(body)
    return
  }
  const response = await gh(`/repos/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_id: headSha, body, event: 'COMMENT' })
  })
  const review = await response.json()
  console.log(`Posted review: ${review.html_url}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${body}\n`)
  }
}

main().catch((error) => {
  console.error(redact(String(error?.stack ?? error)))
  process.exit(1)
})
