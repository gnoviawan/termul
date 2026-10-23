import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_OVERRIDES, judge, run, scanSource, scanTree } from './lint.ts'

const LINT = path.join(import.meta.dir, 'lint.ts')

const dirs: string[] = []
function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'compat-lint-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cli(...args: string[]): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(['bun', LINT, ...args])
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() }
}

describe('scanSource', () => {
  test('document.createElement needs an override as dom-create', () => {
    const text =
      "export function mount() {\n  const c = document.createElement('canvas')\n  return c\n}\n"
    expect(scanSource('lib/mount.ts', text)).toEqual({
      path: 'lib/mount.ts',
      loc: 4,
      status: 'needs-override',
      hits: [{ kind: 'api', id: 'dom-create', support: 'none', lines: [2] }]
    })
  })

  test('ref.current.focus() alone is clean', () => {
    const text = 'export function focusIt(ref) {\n  ref.current.focus()\n}\n'
    expect(scanSource('hooks/focus.ts', text)).toEqual({
      path: 'hooks/focus.ts',
      loc: 3,
      status: 'clean',
      hits: [{ kind: 'api', id: 'focus()', support: 'full', lines: [2] }]
    })
  })

  test('comments, strings and JSX text do not count', () => {
    const text = [
      '// dangerouslySetInnerHTML is banned here',
      '/* new IntersectionObserver(cb) */',
      "const label = 'use getComputedStyle sparingly'",
      'export const Hint = () => <p>{/* execCommand */}no dangerouslySetInnerHTML {label}</p>',
      ''
    ].join('\n')
    expect(scanSource('components/Hint.tsx', text)).toEqual({
      path: 'components/Hint.tsx',
      loc: 4,
      status: 'clean',
      hits: []
    })
  })

  test('quoted event patterns still see their string literal', () => {
    const text = [
      "document.addEventListener('focusin', onFocus)",
      "// window.addEventListener('keydown', onKey)",
      "window.addEventListener('keydown', onKey)",
      ''
    ].join('\n')
    expect(scanSource('hooks/keys.ts', text).hits).toEqual([
      { kind: 'api', id: 'focusin', support: 'full', lines: [1] },
      { kind: 'api', id: 'window-key', support: 'full', lines: [3] }
    ])
  })

  test('runtime imports of a DOM library need an override, type-only imports do not', () => {
    const text = [
      "import type { Terminal } from '@xterm/xterm'",
      "import { toast } from 'sonner'",
      "export { useVirtualizer } from '@tanstack/react-virtual'",
      "const load = () => import('@codemirror/view')",
      ''
    ].join('\n')
    expect(scanSource('lib/mixed.ts', text)).toEqual({
      path: 'lib/mixed.ts',
      loc: 4,
      status: 'needs-override',
      hits: [
        { kind: 'lib', id: 'codemirror', support: 'none', lines: [4] },
        { kind: 'lib', id: 'tanstack-virtual', support: 'none', lines: [3] },
        { kind: 'lib', id: 'sonner', support: 'shim', lines: [2] }
      ]
    })
  })

  test('a partial API alone marks the file partial', () => {
    expect(scanSource('lib/q.ts', "el.closest('[data-pane]')\n").status).toBe('partial')
  })
})

describe('judge', () => {
  test('classifies unlisted, vanished, stale and drifted entries', () => {
    const scans = [
      scanSource('a.ts', 'getComputedStyle(el)\n'),
      scanSource('b.ts', 'getComputedStyle(el)\n'),
      scanSource('c.ts', 'ref.current.focus()\n'),
      scanSource('d.ts', 'new MutationObserver(cb)\ngetComputedStyle(el)\n')
    ]
    const verdict = judge(scans, {
      'b.ts': { reasons: ['getComputedStyle'] },
      'c.ts': { reasons: ['getComputedStyle'] },
      'd.ts': { reasons: ['MutationObserver'] },
      'gone.ts': { reasons: ['dom-create'] }
    })
    expect(verdict.unlisted.map((s) => s.path)).toEqual(['a.ts'])
    expect(verdict.vanished).toEqual(['gone.ts'])
    expect(verdict.stale).toEqual(['c.ts'])
    expect(verdict.drifted).toEqual([
      {
        path: 'd.ts',
        listed: ['MutationObserver'],
        current: ['MutationObserver', 'getComputedStyle']
      }
    ])
  })
})

describe('CLI', () => {
  test('exits 1 on an unlisted needs-override file and names the fix', () => {
    const root = fixtureTree({
      'lib/mount.ts': "export const c = document.createElement('canvas')\n",
      'lib/ok.ts': 'export const ok = 1\n',
      'lib/mount.test.ts': "document.execCommand('copy')\n"
    })
    const { exitCode, stdout } = cli(
      '--root',
      root,
      '--overrides',
      path.join(root, 'overrides.json')
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain(
      'error lib/mount.ts: needs a native override\n  dom-create at line 1. Fix: add a native override under apps/gpuix/src/overrides and list it in tools/compat/overrides.json, or use a supported API: no DOM nodes outside React'
    )
    expect(stdout).toContain('Scanned 2 files, 2 LOC.')
  })

  test('--write produces an allowlist the next run accepts, and a vanished entry fails', () => {
    const root = fixtureTree({
      'lib/mount.ts': "document.createElement('a')\ngetComputedStyle(el)\n"
    })
    const overrides = path.join(root, 'overrides.json')
    expect(cli('--root', root, '--overrides', overrides, '--write').exitCode).toBe(0)
    expect(JSON.parse(readFileSync(overrides, 'utf8'))).toEqual({
      'lib/mount.ts': { reasons: ['dom-create', 'getComputedStyle'] }
    })
    expect(cli('--root', root, '--overrides', overrides).exitCode).toBe(0)
    rmSync(path.join(root, 'lib/mount.ts'))
    const { exitCode, stdout } = cli('--root', root, '--overrides', overrides)
    expect(exitCode).toBe(1)
    expect(stdout).toContain(
      'error lib/mount.ts: listed in tools/compat/overrides.json but not a scanned file'
    )
  })

  test('a stale entry warns and exits 0', () => {
    const root = fixtureTree({ 'lib/clean.ts': 'export const x = 1\n' })
    const overrides = path.join(root, 'overrides.json')
    writeFileSync(overrides, JSON.stringify({ 'lib/clean.ts': { reasons: ['dom-create'] } }))
    const { exitCode, stdout } = cli('--root', root, '--overrides', overrides)
    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      'warn lib/clean.ts: listed in tools/compat/overrides.json but uses no unsupported API'
    )
  })
})

describe('the committed allowlist', () => {
  // read-css-token.ts reads theme tokens through getComputedStyle, which GPUIX
  // answers with empty strings: a silent breakage the allowlist must not lose.
  test('dropping a real override fails the lint on exactly that file', () => {
    const real = JSON.parse(readFileSync(DEFAULT_OVERRIDES, 'utf8'))
    expect(real['lib/themes/read-css-token.ts']).toEqual({ reasons: ['getComputedStyle'] })
    const { 'lib/themes/read-css-token.ts': _, ...rest } = real
    const root = fixtureTree({ 'overrides.json': JSON.stringify(rest) })
    const lines: string[] = []
    const exitCode = run(['--json', '--overrides', path.join(root, 'overrides.json')], (l) =>
      lines.push(l)
    )
    const result = JSON.parse(lines.join('\n'))
    expect(exitCode).toBe(1)
    expect(result.verdict.unlisted.map((s: { path: string }) => s.path)).toEqual([
      'lib/themes/read-css-token.ts'
    ])
    expect(result.verdict.vanished).toEqual([])
  }, 60_000)
})

test('scanTree skips test files and declaration files', () => {
  const root = fixtureTree({
    'a.tsx': 'export const A = () => null\n',
    'a.test.tsx': 'getComputedStyle(el)\n',
    'b.spec.ts': 'getComputedStyle(el)\n',
    '__tests__/c.ts': 'getComputedStyle(el)\n',
    'test-utils/d.ts': 'getComputedStyle(el)\n',
    '__repro-e.tsx': 'getComputedStyle(el)\n',
    'env.d.ts': 'declare function getComputedStyle(): void\n'
  })
  expect(scanTree(root).map((s) => s.path)).toEqual(['a.tsx'])
})
