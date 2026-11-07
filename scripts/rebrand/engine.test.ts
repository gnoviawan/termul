import { describe, expect, it } from 'vitest'
import { areaOf, findTermul, globToRegExp, partition, rewrite, selectsPath } from './engine'

const off = { repoRenamed: false }

describe('globToRegExp', () => {
  it.each([
    ['**/*.md', 'README.md', true],
    ['**/*.md', 'a/b/c.md', true],
    ['**/*.md', 'a/b/c.mdx', false],
    ['**', 'any/path/at/all.ts', true],
    ['src-tauri/gen/**', 'src-tauri/gen/a/b.json', true],
    ['src-tauri/gen/**', 'src-tauri/general.json', false],
    ['*.ts', 'b.ts', true],
    ['*.ts', 'a/b.ts', false],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['**/*.{png,jpg}', 'x/y.jpg', true],
    ['**/*.{png,jpg}', 'x/y.gif', false],
    ['{src,docs}/*.ts', 'docs/x.ts', true],
    ['.github/workflows/release*.yml', '.github/workflows/release-nightly.yml', true],
    ['.github/workflows/release*.yml', '.github/workflows/ci.yml', false],
    ['a.b', 'axb', false],
    ['a+(b)', 'a+(b)', true]
  ])('%s against %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected)
  })
})

describe('selectsPath', () => {
  it('selects by exact path, directory prefix or glob', () => {
    const files = ['src/a.ts', 'src/b/c.ts', 'docs/x.md', 'docs/y.mdx', 'srcx/d.ts']
    expect(files.filter((f) => selectsPath(f, ['src']))).toEqual(['src/a.ts', 'src/b/c.ts'])
    expect(files.filter((f) => selectsPath(f, ['docs/*.md', 'srcx/d.ts']))).toEqual([
      'docs/x.md',
      'srcx/d.ts'
    ])
    expect(files.filter((f) => selectsPath(f, ['**']))).toEqual(files)
  })
})

describe('areaOf', () => {
  it('matches the first prefix on a path segment boundary', () => {
    expect(areaOf('src/renderer/App.tsx')).toBe('src/renderer')
    expect(areaOf('src-tauri/src/lib.rs')).toBe('src-tauri/src')
    expect(areaOf('src-tauri/Cargo.toml')).toBe('other')
    expect(areaOf('docs/a.md')).toBe('docs')
    expect(areaOf('docsite/a.md')).toBe('other')
    expect(areaOf('.github/workflows/ci.yml')).toBe('.github')
  })
})

describe('rewrite', () => {
  const mixed = [
    '# Termul Manager',
    '',
    'Install termul from https://docs.termul.dev/docs/install or https://termul.dev.',
    'Set TERMUL_WEB_AUTH_TOKEN and run `termul-server`.',
    '',
    '```bash',
    'termul --help # Termul prints usage',
    '```',
    '',
    'The termul MCP server, .termul/ dir and termul.deviceId key stay.',
    'Ship Termul Manager.app; <TermulIcon /> stays.'
  ].join('\n')

  it('rewrites a mixed fixture and reports hit lines', () => {
    const result = rewrite('docs/guide.md', mixed, off)
    expect(result.output).toBe(
      [
        '# Troupe',
        '',
        'Install troupe from https://usetroupe.dev/docs/install or https://usetroupe.dev.',
        'Set TERMUL_WEB_AUTH_TOKEN and run `termul-server`.',
        '',
        '```bash',
        'termul --help # Troupe prints usage',
        '```',
        '',
        'The termul MCP server, .termul/ dir and termul.deviceId key stay.',
        'Ship Termul Manager.app; <TermulIcon /> stays.'
      ].join('\n')
    )
    expect(result.hits).toEqual([
      { ruleId: 'display-termul-manager', line: 1 },
      { ruleId: 'display-termul', line: 7 },
      { ruleId: 'docs-url-docs-path', line: 3 },
      { ruleId: 'site-url', line: 3 },
      { ruleId: 'prose-termul', line: 3 }
    ])
    expect(result.kept).toEqual({ 'artifact-names': 2, 'mcp-name': 1 })
  })

  it('is idempotent', () => {
    for (const path of ['docs/guide.md', 'docs/guide.mdx', 'src/a.ts']) {
      const first = rewrite(path, mixed, { repoRenamed: true })
      const second = rewrite(path, first.output, { repoRenamed: true })
      expect(second.output).toBe(first.output)
      expect(second.hits).toEqual([])
    }
  })
})

describe('findTermul', () => {
  it('reports the word outside keep ranges with line and column', () => {
    const text = 'const a = 1\nTermul is here\r\nTermul Manager.app\nTermulIcon\n  see Termul'
    expect(findTermul('src/a.ts', text)).toEqual([
      { line: 2, column: 1, lineText: 'Termul is here' },
      { line: 5, column: 7, lineText: '  see Termul' }
    ])
  })

  it('reports nothing for kept paths', () => {
    expect(findTermul('CHANGELOG.md', 'Termul')).toEqual([])
    expect(findTermul('docs/CHANGES.md', 'Termul')).toEqual([
      { line: 1, column: 1, lineText: 'Termul' }
    ])
  })
})

describe('partition', () => {
  it('keeps a directory together and groups by area', () => {
    const files = [
      'src/renderer/b/x.test.ts',
      'src/renderer/a/one.ts',
      'src/renderer/b/x.ts',
      'src/renderer/a/two.ts',
      'src/renderer/a/three.ts',
      'docs/z.md',
      'README.md'
    ]
    expect(partition(files, 4)).toEqual([
      {
        id: 'src-renderer-01',
        area: 'src/renderer',
        files: ['src/renderer/a/one.ts', 'src/renderer/a/three.ts', 'src/renderer/a/two.ts']
      },
      {
        id: 'src-renderer-02',
        area: 'src/renderer',
        files: ['src/renderer/b/x.test.ts', 'src/renderer/b/x.ts']
      },
      { id: 'docs-01', area: 'docs', files: ['docs/z.md'] },
      { id: 'other-01', area: 'other', files: ['README.md'] }
    ])
  })

  it('caps batches at 45 and splits only a directory that alone exceeds it', () => {
    const big = Array.from(
      { length: 50 },
      (_, i) => `src-tauri/src/acp/f${String(i).padStart(2, '0')}.rs`
    )
    const small = ['src-tauri/src/web/a.rs', 'src-tauri/src/web/a_tests.rs']
    const batches = partition([...small, ...big])
    expect(batches.map((b) => [b.id, b.files.length])).toEqual([
      ['src-tauri-src-01', 45],
      ['src-tauri-src-02', 7]
    ])
    expect(batches[1].files.slice(5)).toEqual(small)
  })
})
