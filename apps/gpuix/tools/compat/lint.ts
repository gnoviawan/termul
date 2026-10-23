/**
 * `bun tools/compat/lint.ts [--write] [--json] [--root dir] [--overrides file]`
 *
 * Scans shared renderer source against `src/compat/dom-support.ts`. A file that
 * uses an unsupported DOM API or library must be listed in `overrides.json`,
 * meaning GPUIX renders a native override instead of the shared file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import { DOM_APIS, DOM_LIBS, type Support } from '../../src/compat/dom-support.ts'

export type Status = 'needs-override' | 'partial' | 'clean'

export interface Hit {
  kind: 'api' | 'lib'
  id: string
  support: Support | 'shim'
  lines: number[]
}

export interface FileScan {
  /** Relative to the renderer root, `/`-separated. */
  path: string
  loc: number
  status: Status
  hits: Hit[]
}

export type Allowlist = Record<string, { reasons: string[] }>

export interface Verdict {
  unlisted: FileScan[]
  vanished: string[]
  stale: string[]
  drifted: { path: string; listed: string[]; current: string[] }[]
}

export const DEFAULT_ROOT = path.resolve(import.meta.dir, '../../../../src/renderer')
export const DEFAULT_OVERRIDES = path.join(import.meta.dir, 'overrides.json')

const FIX =
  'add a native override under apps/gpuix/src/overrides and list it in tools/compat/overrides.json, or use a supported API'

const EXCLUDED = [
  /\.d\.ts$/,
  /\.(test|spec)\.tsx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)test-utils\//,
  /(^|\/)__repro[^/]*(\/|$)/
]

// Patterns that spell out a quoted event name ('focusin', 'keydown', the
// element.addEventListener event allowlist) need string contents intact.
const QUOTED = /['"`]/

function blankRanges(text: string, ranges: [number, number][]): string {
  const chars = text.split('')
  for (const [from, to] of ranges) {
    for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' '
  }
  return chars.join('')
}

/** Source with comments blanked, and with comments plus literal contents blanked. Offsets are preserved. */
function blank(sf: ts.SourceFile): { code: string; withStrings: string } {
  const text = sf.text
  const comments: [number, number][] = []
  const literals: [number, number][] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      literals.push([node.pos, node.end])
      return
    }
    for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      comments.push([r.pos, r.end])
    }
    const start = node.getStart(sf)
    // `{/* ... */}` has no child tokens to carry the comment as trivia.
    if (ts.isJsxExpression(node) && !node.expression) {
      comments.push([start + 1, node.end - 1])
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.push([start + 1, node.end - 1])
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      literals.push([start + 1, node.end - 2])
    } else if (ts.isRegularExpressionLiteral(node)) {
      literals.push([start + 1, start + node.text.lastIndexOf('/')])
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  const code = blankRanges(text, comments)
  return { code, withStrings: blankRanges(code, literals) }
}

function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const named = clause.namedBindings
  return (
    !clause.name &&
    named !== undefined &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((el) => el.isTypeOnly)
  )
}

/** Runtime module specifiers with their 1-based lines; type-only imports load nothing. */
function moduleSpecifiers(sf: ts.SourceFile): { specifier: string; line: number }[] {
  const out: { specifier: string; line: number }[] = []
  const add = (lit: ts.StringLiteralLike) =>
    out.push({
      specifier: lit.text,
      line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1
    })
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier) && !isTypeOnly(node)) add(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments
      if (arg && ts.isStringLiteralLike(arg)) add(arg)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function statusOf(hits: Hit[]): Status {
  if (hits.some((h) => h.support === 'none')) return 'needs-override'
  if (hits.some((h) => h.support === 'partial')) return 'partial'
  return 'clean'
}

function countLines(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function scanSource(relPath: string, text: string): FileScan {
  const kind = relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind)
  const { code, withStrings } = blank(sf)
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const hits: Hit[] = []
  for (const api of DOM_APIS) {
    const source = QUOTED.test(api.pattern.source) ? code : withStrings
    const lines = [...source.matchAll(api.pattern)].map((m) => lineOf(m.index))
    if (lines.length > 0)
      hits.push({ kind: 'api', id: api.id, support: api.support, lines: [...new Set(lines)] })
  }
  const specifiers = moduleSpecifiers(sf)
  for (const lib of DOM_LIBS) {
    const lines = specifiers.filter((s) => lib.specifier.test(s.specifier)).map((s) => s.line)
    if (lines.length > 0)
      hits.push({ kind: 'lib', id: lib.id, support: lib.support, lines: [...new Set(lines)] })
  }
  return { path: relPath, loc: countLines(text), status: statusOf(hits), hits }
}

export function listSources(root: string): string[] {
  return [...new Bun.Glob('**/*.{ts,tsx}').scanSync(root)]
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => !EXCLUDED.some((re) => re.test(rel)))
    .sort()
}

export function scanTree(root: string): FileScan[] {
  return listSources(root).map((rel) => scanSource(rel, readFileSync(path.join(root, rel), 'utf8')))
}

export function overrideReasons(scan: FileScan): string[] {
  return scan.hits
    .filter((h) => h.support === 'none')
    .map((h) => h.id)
    .sort()
}

export function allowlistFrom(scans: FileScan[]): Allowlist {
  const out: Allowlist = {}
  for (const scan of [...scans].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (scan.status === 'needs-override') out[scan.path] = { reasons: overrideReasons(scan) }
  }
  return out
}

export function parseAllowlist(raw: unknown, source: string): Allowlist {
  const fail = (why: string): never => {
    throw new Error(`${source}: ${why}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    fail('expected an object keyed by path')
  const out: Allowlist = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const reasons = (value as { reasons?: unknown } | null)?.reasons
    if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === 'string')) {
      fail(`"${key}" needs { "reasons": string[] }`)
    }
    out[key] = { reasons: reasons as string[] }
  }
  return out
}

export function judge(scans: FileScan[], allowlist: Allowlist): Verdict {
  const byPath = new Map(scans.map((s) => [s.path, s]))
  const verdict: Verdict = { unlisted: [], vanished: [], stale: [], drifted: [] }
  for (const scan of scans) {
    if (scan.status === 'needs-override' && !(scan.path in allowlist)) verdict.unlisted.push(scan)
  }
  for (const [listed, { reasons }] of Object.entries(allowlist)) {
    const scan = byPath.get(listed)
    if (!scan) {
      verdict.vanished.push(listed)
    } else if (scan.status !== 'needs-override') {
      verdict.stale.push(listed)
    } else {
      const current = overrideReasons(scan)
      if ([...reasons].sort().join() !== current.join())
        verdict.drifted.push({ path: listed, listed: reasons, current })
    }
  }
  return verdict
}

export interface Summary {
  files: number
  loc: number
  needsOverride: { files: number; loc: number }
  partialOnly: number
  clean: number
  topApis: { id: string; support: Support; files: number }[]
  libs: { id: string; support: 'shim' | 'none'; files: number }[]
}

export function summarize(scans: FileScan[]): Summary {
  const sum = (xs: FileScan[]) => xs.reduce((n, s) => n + s.loc, 0)
  const needs = scans.filter((s) => s.status === 'needs-override')
  const filesWith = (id: string) => scans.filter((s) => s.hits.some((h) => h.id === id)).length
  return {
    files: scans.length,
    loc: sum(scans),
    needsOverride: { files: needs.length, loc: sum(needs) },
    partialOnly: scans.filter((s) => s.status === 'partial').length,
    clean: scans.filter((s) => s.status === 'clean').length,
    topApis: DOM_APIS.map((a) => ({ id: a.id, support: a.support, files: filesWith(a.id) }))
      .filter((a) => a.files > 0)
      .sort((a, b) => b.files - a.files || (a.id < b.id ? -1 : 1))
      .slice(0, 10),
    libs: DOM_LIBS.map((l) => ({ id: l.id, support: l.support, files: filesWith(l.id) })).filter(
      (l) => l.files > 0
    )
  }
}

function hintFor(hit: Hit): string {
  if (hit.kind === 'lib') return `${hit.id} has no GPUIX element`
  return DOM_APIS.find((a) => a.id === hit.id)?.note ?? hit.id
}

function report(summary: Summary, scans: FileScan[], verdict: Verdict): string {
  const out: string[] = []
  for (const scan of verdict.unlisted) {
    out.push(`error ${scan.path}: needs a native override`)
    for (const hit of scan.hits.filter((h) => h.support === 'none')) {
      out.push(`  ${hit.id} at line ${hit.lines.join(', ')}. Fix: ${FIX}: ${hintFor(hit)}`)
    }
  }
  for (const listed of verdict.vanished) {
    out.push(
      `error ${listed}: listed in tools/compat/overrides.json but not a scanned file; remove it or run --write`
    )
  }
  for (const listed of verdict.stale) {
    out.push(
      `warn ${listed}: listed in tools/compat/overrides.json but uses no unsupported API; remove it`
    )
  }
  for (const d of verdict.drifted) {
    out.push(
      `warn ${d.path}: listed reasons [${d.listed.join(', ')}], current [${d.current.join(', ')}]; run --write`
    )
  }
  for (const api of DOM_APIS.filter((a) => a.support === 'partial')) {
    const users = scans.filter((s) => s.hits.some((h) => h.id === api.id)).length
    if (users > 0) out.push(`info ${api.id} is partial (${api.note}) and used in ${users} files`)
  }
  const s = summary
  out.push(
    '',
    `Scanned ${s.files} files, ${s.loc} LOC.`,
    `Needs override ${s.needsOverride.files} files, ${s.needsOverride.loc} LOC. Partial-only ${s.partialOnly} files. Clean ${s.clean} files.`,
    `Top APIs by file count: ${s.topApis.map((a) => `${a.id} ${a.files} (${a.support})`).join(', ')}.`,
    `Libraries by file count: ${s.libs.map((l) => `${l.id} ${l.files} (${l.support})`).join(', ')}.`
  )
  return out.join('\n')
}

// Biome's JSON layout (arrays inline up to 100 columns), so a --write result
// passes `biome ci` unchanged.
export function formatAllowlist(allowlist: Allowlist): string {
  const entries = Object.entries(allowlist).map(([file, { reasons }]) => {
    const quoted = reasons.map((r) => JSON.stringify(r))
    const inline = `    "reasons": [${quoted.join(', ')}]`
    const body =
      inline.length <= 100
        ? inline
        : `    "reasons": [\n${quoted.map((q) => `      ${q}`).join(',\n')}\n    ]`
    return `  ${JSON.stringify(file)}: {\n${body}\n  }`
  })
  return entries.length === 0 ? '{}\n' : `{\n${entries.join(',\n')}\n}\n`
}

function readAllowlist(file: string): Allowlist {
  if (!existsSync(file)) return {}
  return parseAllowlist(JSON.parse(readFileSync(file, 'utf8')), file)
}

/** Runs the CLI and returns its exit code. */
export function run(argv: string[], log: (line: string) => void = console.log): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      root: { type: 'string', default: DEFAULT_ROOT },
      overrides: { type: 'string', default: DEFAULT_OVERRIDES }
    }
  })
  const scans = scanTree(values.root)
  if (values.write) writeFileSync(values.overrides, formatAllowlist(allowlistFrom(scans)))
  const verdict = judge(scans, readAllowlist(values.overrides))
  const summary = summarize(scans)
  const failed = verdict.unlisted.length > 0 || verdict.vanished.length > 0
  if (values.json) {
    log(JSON.stringify({ ok: !failed, summary, verdict, files: scans }, null, 2))
  } else {
    log(report(summary, scans, verdict))
  }
  return failed ? 1 : 0
}

if (import.meta.main) process.exit(run(process.argv.slice(2)))
