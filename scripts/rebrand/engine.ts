import { AREAS, KEEP_PATHS, KEEP_PATTERNS, RULES, type Rule, type RuleFlag } from './rules'

export type Options = Record<RuleFlag, boolean>

export interface Hit {
  ruleId: string
  line: number
}

export interface RewriteResult {
  output: string
  hits: Hit[]
  kept: Record<string, number>
}

export interface TermulHit {
  line: number
  column: number
  lineText: string
}

export interface Batch {
  id: string
  area: string
  files: string[]
}

interface Span {
  start: number
  end: number
}

interface KeepSpan extends Span {
  id: string
}

const globCache = new Map<string, RegExp>()

export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob)
  if (!re) {
    re = new RegExp(`^${globSource(glob)}$`)
    globCache.set(glob, re)
  }
  return re
}

function globSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/'
      if (segmentStart && glob[i + 2] === '/') {
        out += '(?:[^/]*/)*'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{' && glob.indexOf('}', i) !== -1) {
      const close = glob.indexOf('}', i)
      out += `(?:${glob
        .slice(i + 1, close)
        .split(',')
        .map(globSource)
        .join('|')})`
      i = close
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path))
}

export function keptPathOf(path: string): string | undefined {
  return KEEP_PATHS.find((entry) => matchesAny(path, entry.globs))?.id
}

export function areaOf(path: string): string {
  return AREAS.find((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ?? 'other'
}

function ruleApplies(rule: Rule, path: string, opts: Options): boolean {
  if (rule.requires && !opts[rule.requires]) return false
  return matchesAny(path, rule.include) && !matchesAny(path, rule.exclude)
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

function spansOf(text: string, pattern: RegExp): Span[] {
  return [...text.matchAll(pattern)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length
  }))
}

function keepSpans(path: string, text: string): KeepSpan[] {
  return KEEP_PATTERNS.filter((keep) => !keep.include || matchesAny(path, keep.include)).flatMap(
    (keep) => spansOf(text, keep.pattern).map((span) => ({ ...span, id: keep.id }))
  )
}

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/
const BLANK_LINE = /\n[ \t]*\r?\n/
const LINK_DESTINATION = /\]\([^)\n]*\)/g
const AUTOLINK = /<https?:\/\/[^>\s]*>/g
const BARE_URL = /https?:\/\/[^\s)>\]]+/g
const MDX_IMPORT_EXPORT = /^(?:import|export)\s.*$/gm

function fenceSpans(text: string): Span[] {
  const spans: Span[] = []
  let open: { start: number; marker: string } | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    const end = offset + line.length
    if (!open) {
      const marker = FENCE_OPEN.exec(line)?.[1]
      if (marker) open = { start: offset, marker }
    } else {
      const marker = FENCE_CLOSE.exec(line)?.[1]
      if (marker && marker[0] === open.marker[0] && marker.length >= open.marker.length) {
        spans.push({ start: open.start, end })
        open = undefined
      }
    }
    offset = end + 1
  }
  if (open) spans.push({ start: open.start, end: text.length })
  return spans
}

// A backtick run opens a code span only if a run of the same length closes it
// within the same paragraph; otherwise the backticks are literal text.
function inlineCodeSpans(text: string, fences: Span[]): Span[] {
  const runs = spansOf(text, /`+/g).filter((run) => !fences.some((f) => overlaps(f, run)))
  const spans: Span[] = []
  let i = 0
  while (i < runs.length) {
    const open = runs[i]
    const length = open.end - open.start
    const j = runs.findIndex((run, k) => k > i && run.end - run.start === length)
    const close = j === -1 ? undefined : runs[j]
    if (close && !BLANK_LINE.test(text.slice(open.end, close.start))) {
      spans.push({ start: open.start, end: close.end })
      i = j + 1
    } else {
      i += 1
    }
  }
  return spans
}

function markdownCodeSpans(path: string, text: string): Span[] {
  const fences = fenceSpans(text)
  return [
    ...fences,
    ...inlineCodeSpans(text, fences),
    ...spansOf(text, LINK_DESTINATION),
    ...spansOf(text, AUTOLINK),
    ...spansOf(text, BARE_URL),
    ...(path.endsWith('.mdx') ? spansOf(text, MDX_IMPORT_EXPORT) : [])
  ]
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

function lineIndexOf(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

// Rules run one after another on the evolving text, so keep and code spans are
// recomputed per rule. No rule adds or removes a newline, so hit lines stay valid.
export function rewrite(
  path: string,
  text: string,
  opts: Options,
  rules: readonly Rule[] = RULES
): RewriteResult {
  const hits: Hit[] = []
  const kept: Record<string, number> = {}
  if (keptPathOf(path)) return { output: text, hits, kept }

  let output = text
  for (const rule of rules) {
    if (!ruleApplies(rule, path, opts)) continue
    const matches = spansOf(output, rule.pattern)
    if (matches.length === 0) continue

    const keeps = keepSpans(path, output)
    const code = rule.skipCode && /\.mdx?$/.test(path) ? markdownCodeSpans(path, output) : []
    const starts = lineStarts(output)
    let next = ''
    let cursor = 0
    for (const match of matches) {
      if (code.some((span) => overlaps(span, match))) continue
      const blocker = keeps.find((span) => overlaps(span, match))
      if (blocker) {
        kept[blocker.id] = (kept[blocker.id] ?? 0) + 1
        continue
      }
      next += output.slice(cursor, match.start) + rule.replacement
      cursor = match.end
      hits.push({ ruleId: rule.id, line: lineIndexOf(starts, match.start) + 1 })
    }
    output = next + output.slice(cursor)
  }
  return { output, hits, kept }
}

export function findTermul(path: string, text: string): TermulHit[] {
  if (keptPathOf(path)) return []
  const keeps = keepSpans(path, text)
  const starts = lineStarts(text)
  return spansOf(text, /\bTermul\b/g)
    .filter((match) => !keeps.some((span) => overlaps(span, match)))
    .map((match) => {
      const index = lineIndexOf(starts, match.start)
      const lineEnd = index + 1 < starts.length ? starts[index + 1] - 1 : text.length
      return {
        line: index + 1,
        column: match.start - starts[index] + 1,
        lineText: text.slice(starts[index], lineEnd).replace(/\r$/, '')
      }
    })
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '.' : path.slice(0, slash)
}

function areaSlug(area: string): string {
  return area.replace(/\W+/g, '-').replace(/^-+|-+$/g, '')
}

// Whole directories stay in one batch so a source file and its sibling test
// (x.ts and x.test.ts, foo.rs and foo_tests.rs) are reviewed together.
export function partition(files: readonly string[], max = 45): Batch[] {
  const byArea = new Map<string, Map<string, string[]>>()
  for (const file of [...new Set(files)].sort()) {
    const area = areaOf(file)
    const dirs = byArea.get(area) ?? new Map<string, string[]>()
    byArea.set(area, dirs)
    const dir = dirOf(file)
    dirs.set(dir, [...(dirs.get(dir) ?? []), file])
  }

  const areaOrder = [...AREAS, 'other']
  const batches: Batch[] = []
  for (const area of [...byArea.keys()].sort(
    (a, b) => areaOrder.indexOf(a) - areaOrder.indexOf(b)
  )) {
    const groups: string[][] = []
    let current: string[] = []
    for (const dirFiles of byArea.get(area)?.values() ?? []) {
      if (current.length + dirFiles.length > max && current.length > 0) {
        groups.push(current)
        current = []
      }
      for (let i = 0; i < dirFiles.length; i += max) {
        const chunk = dirFiles.slice(i, i + max)
        if (current.length + chunk.length > max) {
          groups.push(current)
          current = []
        }
        current.push(...chunk)
      }
    }
    if (current.length > 0) groups.push(current)
    groups.forEach((group, index) => {
      batches.push({
        id: `${areaSlug(area)}-${String(index + 1).padStart(2, '0')}`,
        area,
        files: group
      })
    })
  }
  return batches
}

// A --paths argument selects a file by exact path, by directory prefix, or by glob.
export function selectsPath(path: string, args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      path === arg || path.startsWith(`${arg.replace(/\/+$/, '')}/`) || globToRegExp(arg).test(path)
  )
}
