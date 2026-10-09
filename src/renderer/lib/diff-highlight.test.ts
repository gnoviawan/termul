import { describe, expect, it } from 'vitest'
import {
  DIFF_HIGHLIGHT_MAX_CHARS,
  DIFF_HIGHLIGHT_MAX_LINES,
  highlightDiffText,
  resolveDiffLanguage
} from './diff-highlight'

describe('resolveDiffLanguage', () => {
  it.each([
    ['src/app.ts', 'typescript'],
    ['src/App.TSX', 'tsx'],
    ['lib/util.js', 'javascript'],
    ['a.jsx', 'jsx'],
    ['data.json', 'json'],
    ['style.css', 'css'],
    ['page.html', 'html'],
    ['main.py', 'python'],
    ['lib.rs', 'rust'],
    ['main.go', 'go'],
    ['a.java', 'java'],
    ['a.cpp', 'cpp'],
    ['run.sh', 'bash'],
    ['config.yaml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['README.md', 'markdown'],
    ['query.sql', 'sql'],
    ['Dockerfile', 'dockerfile'],
    ['docker/Dockerfile', 'dockerfile'],
    ['Makefile', 'makefile']
  ])('maps %s to %s', (path, expected) => {
    expect(resolveDiffLanguage(path)).toBe(expected)
  })

  it('falls back to plaintext for unknown or missing extensions', () => {
    expect(resolveDiffLanguage('notes.zzzunknown')).toBe('plaintext')
    expect(resolveDiffLanguage('LICENSE')).toBe('plaintext')
    expect(resolveDiffLanguage('')).toBe('plaintext')
  })
})

describe('highlightDiffText', () => {
  it('tokenizes losslessly: joined tokens equal each source line', async () => {
    const text = 'const x = 1\n// hello\nexport default x'
    const lines = await highlightDiffText(text, 'typescript')
    expect(lines).not.toBeNull()
    expect(lines?.length).toBe(3)
    for (const [i, line] of text.split('\n').entries()) {
      expect(lines?.[i].map((t) => t.content).join('')).toBe(line)
    }
  })

  it('carries both light and dark colors', async () => {
    const lines = await highlightDiffText('const x = 1', 'typescript')
    const colored = lines?.[0].filter((t) => t.light && t.dark) ?? []
    expect(colored.length).toBeGreaterThan(0)
  })

  it('paints termul keywords and strings in the bright palette', async () => {
    const lines = await highlightDiffText('const name = "ada"', 'typescript')
    const tokens = lines?.[0] ?? []
    const keyword = tokens.find((token) => token.content === 'const')
    const string = tokens.find((token) => token.content.includes('ada'))
    expect(keyword?.dark?.toLowerCase()).toBe('#95d0cd')
    expect(keyword?.light?.toLowerCase()).toBe('#3e7875')
    expect(string?.dark?.toLowerCase()).toBe('#d898d8')
    expect(string?.light?.toLowerCase()).toBe('#945995')
  })

  it('keeps multi-line block comments one color across lines', async () => {
    const text = '/* line one\nline two */\nconst x = 1'
    const lines = await highlightDiffText(text, 'css')
    expect(lines?.length).toBe(3)
    const opener = lines?.[0].find((t) => t.content.includes('/*'))
    const middle = lines?.[1][0]
    expect(opener?.dark).toBeDefined()
    // Whole-text tokenizing keeps the continued comment on the same color.
    expect(middle?.dark).toBe(opener?.dark)
  })

  it('returns null past the line cap', async () => {
    const text = Array.from({ length: DIFF_HIGHLIGHT_MAX_LINES + 1 }, () => 'x').join('\n')
    await expect(highlightDiffText(text, 'typescript')).resolves.toBeNull()
  })

  it('returns null past the char cap', async () => {
    const text = `const x = '${'y'.repeat(DIFF_HIGHLIGHT_MAX_CHARS)}'`
    await expect(highlightDiffText(text, 'typescript')).resolves.toBeNull()
  })

  it('returns null for an unknown language without throwing', async () => {
    await expect(highlightDiffText('hello', 'not-a-real-lang')).resolves.toBeNull()
  })

  it('strips carriage returns to align with diff line splitting', async () => {
    const lines = await highlightDiffText('const x = 1\r\nconst y = 2\r\n', 'typescript')
    expect(lines?.[0].map((t) => t.content).join('')).toBe('const x = 1')
    expect(lines?.[1].map((t) => t.content).join('')).toBe('const y = 2')
  })
})
