import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import {
  areaOf,
  type Batch,
  dirOf,
  findTermul,
  type Hit,
  keptPathOf,
  type Options,
  partition,
  rewrite,
  selectsPath,
  type TermulHit
} from './engine'
import {
  KEEP_PATHS,
  KEEP_PATTERNS,
  RULE_CATEGORIES,
  RULES,
  type Rule,
  type RuleCategory
} from './rules'

const USAGE = `Usage: bun scripts/rebrand/rebrand.ts [mode] [options]

Modes (pick one):
  --dry-run               Simulate the rewrite and print a Markdown report (default)
  --apply --paths <glob>  Rewrite matching files in place; --paths is required, '**' means all
  --check                 List every remaining word "Termul"; exit 1 if any

Options:
  --paths <glob>          Limit to files matching a path, directory or glob (repeatable)
  --report <path>         Write the dry-run report to a file instead of stdout
  --repo-renamed          Also rewrite github.com/gnoviawan/termul links
  --skip-category <name>  Turn off every rule in a category: display, prose, url or repo
                          (repeatable; dry run and apply only)
  --help                  Show this message`

type Mode = 'dry-run' | 'apply' | 'check'

export interface Cli {
  mode: Mode
  paths: string[]
  skip: RuleCategory[]
  report?: string
  opts: Options
}

function isCategory(value: string): value is RuleCategory {
  return (RULE_CATEGORIES as readonly string[]).includes(value)
}

export function parseArgs(argv: readonly string[]): Cli | { error: string } {
  const modes: Mode[] = []
  const paths: string[] = []
  const skip = new Set<RuleCategory>()
  let report: string | undefined
  let repoRenamed = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') modes.push('dry-run')
    else if (arg === '--apply') modes.push('apply')
    else if (arg === '--check') modes.push('check')
    else if (arg === '--repo-renamed') repoRenamed = true
    else if (arg === '--paths' || arg === '--report' || arg === '--skip-category') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` }
      i += 1
      if (arg === '--paths') paths.push(value)
      else if (arg === '--report') report = value
      else if (isCategory(value)) skip.add(value)
      else return { error: `unknown category: ${value} (pick ${RULE_CATEGORIES.join(', ')})` }
    } else return { error: arg === '--help' ? '' : `unknown argument: ${arg}` }
  }
  if (modes.length > 1) return { error: `pick one mode, got ${modes.join(' and ')}` }
  const mode = modes[0] ?? 'dry-run'
  if (mode === 'apply' && paths.length === 0) {
    return { error: "--apply needs --paths (use --paths '**' for every file)" }
  }
  if (report !== undefined && mode !== 'dry-run')
    return { error: '--report only works with --dry-run' }
  if (skip.size > 0 && mode === 'check')
    return { error: '--skip-category does not apply to --check' }
  return { mode, paths, skip: [...skip], report, opts: { repoRenamed } }
}

type Loaded =
  | { kind: 'text'; text: string; fd: number }
  | { kind: 'kept'; keepId: string }
  | { kind: 'binary' }
  | { kind: 'skipped' }

const SKIPPABLE_OPEN_ERRORS = new Set(['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR', 'EMLINK'])

// One no-follow descriptor serves the type check, the read and (for --apply) the
// write, so a path swapped for a symlink mid-run is never followed out of the repo.
function open(root: string, path: string, flags: number): Loaded {
  const keepId = keptPathOf(path)
  if (keepId) return { kind: 'kept', keepId }
  let fd: number
  try {
    fd = openSync(join(root, path), flags | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    // git ls-files also lists deleted files, symlinks and submodule gitlinks.
    // Anything else (a permission error) must fail the run, not pass silently.
    if (SKIPPABLE_OPEN_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) {
      return { kind: 'skipped' }
    }
    throw error
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    return { kind: 'skipped' }
  }
  const bytes = readFileSync(fd)
  if (bytes.includes(0)) {
    closeSync(fd)
    return { kind: 'binary' }
  }
  return { kind: 'text', text: bytes.toString('utf8'), fd }
}

function load(root: string, path: string): Loaded {
  const loaded = open(root, path, constants.O_RDONLY)
  if (loaded.kind === 'text') closeSync(loaded.fd)
  return loaded
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function trackedFiles(root: string): string[] {
  return git(root, ['ls-files', '-z'])
    .split('\0')
    .filter((path) => path.length > 0)
}

interface Touched {
  path: string
  hits: Hit[]
}

interface Scan {
  scanned: number
  binary: number
  keptPaths: Record<string, number>
  kept: Record<string, number>
  touched: Touched[]
  gaps: { path: string; hit: TermulHit }[]
  identifiers: Map<string, number>
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by
}

function scan(root: string, files: readonly string[], opts: Options, rules: readonly Rule[]): Scan {
  const result: Scan = {
    scanned: 0,
    binary: 0,
    keptPaths: {},
    kept: {},
    touched: [],
    gaps: [],
    identifiers: new Map()
  }
  for (const path of files) {
    const loaded = load(root, path)
    if (loaded.kind === 'kept') bump(result.keptPaths, loaded.keepId)
    if (loaded.kind === 'binary') result.binary += 1
    if (loaded.kind !== 'text') continue
    result.scanned += 1
    const { output, hits, kept } = rewrite(path, loaded.text, opts, rules)
    for (const [id, count] of Object.entries(kept)) bump(result.kept, id, count)
    if (hits.length > 0) result.touched.push({ path, hits })
    for (const hit of findTermul(path, output)) result.gaps.push({ path, hit })
    for (const [token] of output.matchAll(/\bTermul[A-Z0-9_]\w*/g)) {
      result.identifiers.set(token, (result.identifiers.get(token) ?? 0) + 1)
    }
  }
  return result
}

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

// A directory whose touched files all sit in this batch is passed as one glob;
// rewrite is a no-op on its untouched files. Split directories list each file.
function batchPathArgs(batch: Batch, touchedPerDir: Map<string, number>): string[] {
  const perDir = new Map<string, string[]>()
  for (const file of batch.files)
    perDir.set(dirOf(file), [...(perDir.get(dirOf(file)) ?? []), file])
  return [...perDir].flatMap(([dir, files]) => {
    const whole = files.length === touchedPerDir.get(dir) && !/[*?{}[\]]/.test(dir)
    if (!whole) return files
    return [dir === '.' ? '*' : `${dir}/*`]
  })
}

function applyCommand(
  batch: Batch,
  touchedPerDir: Map<string, number>,
  opts: Options,
  skip: readonly RuleCategory[]
): string {
  const flags = [
    ...(opts.repoRenamed ? ['--repo-renamed'] : []),
    ...skip.map((category) => `--skip-category ${category}`)
  ]
    .map((flag) => ` ${flag}`)
    .join('')
  const paths = batchPathArgs(batch, touchedPerDir)
    .map((arg) => `--paths ${shellQuote(arg)}`)
    .join(' ')
  return `bun run rebrand --apply${flags} ${paths}`
}

function table(header: string[], rows: (string | number)[][]): string {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

function sum(values: Iterable<number>): number {
  let total = 0
  for (const value of values) total += value
  return total
}

function renderReport(result: Scan, opts: Options, skip: readonly RuleCategory[]): string {
  const allHits = result.touched.flatMap((file) =>
    file.hits.map((hit) => ({ ...hit, path: file.path }))
  )
  const batches = partition(result.touched.map((file) => file.path))
  const touchedPerDir = new Map<string, number>()
  for (const { path } of result.touched)
    touchedPerDir.set(dirOf(path), (touchedPerDir.get(dirOf(path)) ?? 0) + 1)

  const ruleRows = RULES.map((rule) => {
    const hits = allHits.filter((hit) => hit.ruleId === rule.id)
    const state = skip.includes(rule.category)
      ? 'off (skipped)'
      : rule.requires && !opts[rule.requires]
        ? `off (needs ${rule.requires})`
        : 'on'
    return [
      `\`${rule.id}\``,
      rule.category,
      state,
      hits.length,
      new Set(hits.map((hit) => hit.path)).size
    ]
  })

  const areaStats = new Map<string, { hits: number; files: number }>()
  for (const file of result.touched) {
    const area = areaOf(file.path)
    const stats = areaStats.get(area) ?? { hits: 0, files: 0 }
    areaStats.set(area, { hits: stats.hits + file.hits.length, files: stats.files + 1 })
  }

  const out: string[] = [
    '# Rebrand dry run: Termul to Troupe',
    '',
    '## Options',
    '',
    `- repoRenamed: ${opts.repoRenamed}`,
    `- skipCategories: ${skip.length > 0 ? skip.join(', ') : 'none'}`,
    '',
    '## Totals',
    '',
    `- Text files scanned: ${result.scanned}`,
    `- Files skipped by keep paths: ${sum(Object.values(result.keptPaths))}`,
    `- Binary files skipped by NUL sniff: ${result.binary}`,
    `- Files that would change: ${result.touched.length}`,
    `- Replacements: ${allHits.length}`,
    `- Rule matches blocked by keep patterns: ${sum(Object.values(result.kept))}`,
    '',
    '## Hits per rule',
    '',
    table(['Rule', 'Category', 'State', 'Hits', 'Files'], ruleRows),
    '',
    '## Hits per area',
    '',
    table(
      ['Area', 'Hits', 'Files'],
      [...areaStats]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([area, s]) => [area, s.hits, s.files])
    ),
    '',
    '## Keep list',
    '',
    table(
      ['Keep pattern', 'Owner', 'Blocked matches', 'Reason'],
      KEEP_PATTERNS.map((keep) => [
        `\`${keep.id}\``,
        keep.owner,
        result.kept[keep.id] ?? 0,
        keep.reason
      ])
    ),
    '',
    table(
      ['Keep path', 'Owner', 'Files skipped', 'Reason'],
      KEEP_PATHS.map((keep) => [
        `\`${keep.id}\``,
        keep.owner,
        result.keptPaths[keep.id] ?? 0,
        keep.reason
      ])
    ),
    '',
    '## Proposed apply batches',
    '',
    table(
      ['Batch', 'Area', 'Files'],
      batches.map((batch) => [`\`${batch.id}\``, batch.area, batch.files.length])
    )
  ]
  for (const batch of batches) {
    out.push(
      '',
      `### ${batch.id} (${batch.area}, ${batch.files.length} files)`,
      '',
      '```sh',
      applyCommand(batch, touchedPerDir, opts, skip),
      '```',
      '',
      ...batch.files.map((file) => `- ${file}`)
    )
  }

  out.push(
    '',
    '## Gaps',
    '',
    'Words "Termul" the rules leave behind outside keep paths and keep patterns.',
    ''
  )
  if (result.gaps.length === 0) out.push('None.')
  else {
    out.push(
      '```text',
      ...result.gaps.map(({ path, hit }) => `${path}:${hit.line}: ${hit.lineText.trim()}`),
      '```'
    )
  }
  out.push(
    '',
    '### Compound identifiers (code identifiers, out of scope)',
    '',
    result.identifiers.size === 0
      ? 'None.'
      : table(
          ['Identifier', 'Count'],
          [...result.identifiers]
            .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
            .map(([token, count]) => [`\`${token}\``, count])
        ),
    ''
  )
  return out.join('\n')
}

function overwrite(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  ftruncateSync(fd, 0)
  for (let offset = 0; offset < bytes.length; ) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, offset)
  }
}

function runApply(
  root: string,
  files: readonly string[],
  opts: Options,
  rules: readonly Rule[]
): void {
  let changed = 0
  let replacements = 0
  for (const path of files) {
    const loaded = open(root, path, constants.O_RDWR)
    if (loaded.kind !== 'text') continue
    const { output, hits } = rewrite(path, loaded.text, opts, rules)
    if (output !== loaded.text) overwrite(loaded.fd, output)
    closeSync(loaded.fd)
    if (output === loaded.text) continue
    changed += 1
    replacements += hits.length
    console.log(`${path}: ${hits.length} hits`)
  }
  console.log(`\n${changed} files changed, ${replacements} replacements`)
}

function runCheck(root: string, files: readonly string[]): number {
  let found = 0
  for (const path of files) {
    const loaded = load(root, path)
    if (loaded.kind !== 'text') continue
    for (const hit of findTermul(path, loaded.text)) {
      found += 1
      console.log(`${path}:${hit.line}: ${hit.lineText.trim()}`)
    }
  }
  console.error(found === 0 ? 'No "Termul" left.' : `${found} "Termul" left.`)
  return found === 0 ? 0 : 1
}

function main(argv: readonly string[]): number {
  const cli = parseArgs(argv)
  if ('error' in cli) {
    if (cli.error) console.error(`rebrand: ${cli.error}\n`)
    console.error(USAGE)
    return cli.error ? 2 : 0
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  const tracked = trackedFiles(root)
  const files =
    cli.paths.length > 0 ? tracked.filter((path) => selectsPath(path, cli.paths)) : tracked

  const rules = RULES.filter((rule) => !cli.skip.includes(rule.category))

  if (cli.mode === 'apply') {
    runApply(root, files, cli.opts, rules)
    return 0
  }
  if (cli.mode === 'check') return runCheck(root, files)

  const report = renderReport(scan(root, files, cli.opts, rules), cli.opts, cli.skip)
  if (cli.report) {
    writeFileSync(cli.report, report)
    console.error(`Report written to ${cli.report}`)
  } else {
    process.stdout.write(report)
  }
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
