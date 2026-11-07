import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from './rebrand'

const SCRIPT = join(__dirname, 'rebrand.ts')

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', paths: [], opts: { repoRenamed: false } })
  })

  it('collects repeated --paths and the repo flag', () => {
    expect(parseArgs(['--apply', '--paths', 'docs', '--paths', '**', '--repo-renamed'])).toEqual({
      mode: 'apply',
      paths: ['docs', '**'],
      opts: { repoRenamed: true }
    })
  })

  it.each([
    [['--apply'], "--apply needs --paths (use --paths '**' for every file)"],
    [['--bogus'], 'unknown argument: --bogus'],
    [['--check', '--apply'], 'pick one mode, got check and apply'],
    [['--paths'], '--paths needs a value'],
    [['--check', '--report', 'r.md'], '--report only works with --dry-run']
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

  it('prints usage and exits 2 on an unknown flag', () => {
    setup({})
    const result = run('--nope')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('rebrand: unknown argument: --nope')
  })
})
