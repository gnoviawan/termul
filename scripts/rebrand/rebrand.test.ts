import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from './rebrand'

const SCRIPT = join(__dirname, 'rebrand.ts')

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({
      mode: 'dry-run',
      paths: [],
      skip: [],
      opts: { repoRenamed: false }
    })
  })

  it('collects repeated --paths and the repo flag', () => {
    expect(parseArgs(['--apply', '--paths', 'docs', '--paths', '**', '--repo-renamed'])).toEqual({
      mode: 'apply',
      paths: ['docs', '**'],
      skip: [],
      opts: { repoRenamed: true }
    })
  })

  it('collects repeated --skip-category once per category', () => {
    expect(
      parseArgs([
        '--skip-category',
        'url',
        '--apply',
        '--paths',
        'src',
        '--skip-category',
        'prose',
        '--skip-category',
        'url'
      ])
    ).toEqual({
      mode: 'apply',
      paths: ['src'],
      skip: ['url', 'prose'],
      opts: { repoRenamed: false }
    })
  })

  it.each([
    [['--apply'], "--apply needs --paths (use --paths '**' for every file)"],
    [['--bogus'], 'unknown argument: --bogus'],
    [['--check', '--apply'], 'pick one mode, got check and apply'],
    [['--paths'], '--paths needs a value'],
    [['--check', '--report', 'r.md'], '--report only works with --dry-run'],
    [['--skip-category'], '--skip-category needs a value'],
    [['--skip-category', 'urls'], 'unknown category: urls (pick display, prose, url, repo)'],
    [['--check', '--skip-category', 'url'], '--skip-category does not apply to --check']
  ])('rejects %j', (argv, error) => {
    expect(parseArgs(argv)).toEqual({ error })
  })
})

describe('CLI against a git repo', () => {
  let repo = ''

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  function setup(files: Record<string, string>): void {
    repo = mkdtempSync(join(tmpdir(), 'rebrand-'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
    spawnSync('git', ['init', '-q'], { cwd: repo })
    spawnSync('git', ['add', '-A'], { cwd: repo })
  }

  function run(...args: string[]) {
    const result = spawnSync('bun', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  function read(path: string): string {
    return readFileSync(join(repo, path), 'utf8')
  }

  it('applies only to selected, non-kept text files', () => {
    setup({
      'docs/a.md': 'Termul Manager is fast.\n',
      'src/b.ts': "const title = 'Termul'\n",
      'CHANGELOG.md': 'Termul 1.0\n',
      'bin.dat': 'Termul\0binary'
    })
    const result = run('--apply', '--paths', 'docs', '--paths', 'CHANGELOG.md', '--paths', '*.dat')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('docs/a.md: 1 hits\n\n1 files changed, 1 replacements\n')
    expect(read('docs/a.md')).toBe('Troupe is fast.\n')
    expect(read('src/b.ts')).toBe("const title = 'Termul'\n")
    expect(read('CHANGELOG.md')).toBe('Termul 1.0\n')
    expect(read('bin.dat')).toBe('Termul\0binary')
  })

  it('never follows a tracked symlink and catches a NUL past the first 8 KiB', () => {
    const outside = mkdtempSync(join(tmpdir(), 'rebrand-outside-'))
    writeFileSync(join(outside, 'target.md'), 'Termul outside\n')
    const lateNul = `${'x'.repeat(10_000)}Termul\0`
    setup({ 'big.dat': lateNul, 'docs/a.md': 'Termul\n' })
    symlinkSync(join(outside, 'target.md'), join(repo, 'link.md'))
    spawnSync('git', ['add', '-A'], { cwd: repo })
    const result = run('--apply', '--paths', '**')
    expect(result.stdout).toBe('docs/a.md: 1 hits\n\n1 files changed, 1 replacements\n')
    expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('Termul outside\n')
    expect(read('big.dat')).toBe(lateNul)
    rmSync(outside, { recursive: true, force: true })
  })

  it.skipIf(process.getuid?.() === 0)('fails instead of skipping a file it cannot open', () => {
    setup({ 'docs/a.md': 'Termul\n' })
    chmodSync(join(repo, 'docs/a.md'), 0o444)
    const result = run('--apply', '--paths', '**')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('EACCES')
    expect(read('docs/a.md')).toBe('Termul\n')
  })

  it('--check exits 1 while the word remains and 0 once applied', () => {
    setup({ 'src/b.ts': "const title = 'Termul'\nconst app = 'Termul Manager.app'\n" })
    expect(run('--check')).toMatchObject({
      status: 1,
      stdout: "src/b.ts:1: const title = 'Termul'\n"
    })
    run('--apply', '--paths', '**')
    expect(run('--check')).toMatchObject({ status: 0, stdout: '' })
  })

  it('the dry run reports hits, batches and leaves files untouched', () => {
    setup({ 'docs/a.md': 'Termul and <TermulIcon />\n' })
    const result = run()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('| `display-termul` | display | on | 1 | 1 |')
    expect(result.stdout).toContain("bun run rebrand --apply --paths 'docs/*'")
    expect(result.stdout).toContain('| `TermulIcon` | 1 |')
    expect(read('docs/a.md')).toBe('Termul and <TermulIcon />\n')
  })

  it('--skip-category url renames the word and leaves every site URL', () => {
    const text = 'Termul docs: https://docs.termul.dev/docs/start and termul.dev\n'
    setup({ 'docs/a.md': text, 'src/b.ts': "const help = 'https://termul.dev/help'\n" })
    const result = run('--apply', '--skip-category', 'url', '--paths', '**')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('docs/a.md: 1 hits\n\n1 files changed, 1 replacements\n')
    expect(read('docs/a.md')).toBe(
      'Troupe docs: https://docs.termul.dev/docs/start and termul.dev\n'
    )
    expect(read('src/b.ts')).toBe("const help = 'https://termul.dev/help'\n")
  })

  it('the dry run marks skipped rules and carries the flag into each apply command', () => {
    setup({ 'docs/a.md': 'Termul at https://termul.dev\n' })
    const result = run('--skip-category', 'url')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('- skipCategories: url')
    expect(result.stdout).toContain('| `site-url` | url | off (skipped) | 0 | 0 |')
    expect(result.stdout).toContain('| `display-termul` | display | on | 1 | 1 |')
    expect(result.stdout).toContain("bun run rebrand --apply --skip-category url --paths 'docs/*'")
  })

  it('prints usage and exits 2 on an unknown flag', () => {
    setup({})
    const result = run('--nope')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('rebrand: unknown argument: --nope')
  })
})
