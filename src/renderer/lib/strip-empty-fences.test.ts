import { describe, expect, it } from 'vitest'
import { stripEmptyFences } from './strip-empty-fences'

describe('stripEmptyFences', () => {
  it('removes an empty terminated fence', () => {
    const out = stripEmptyFences('before\n\n```bash\n```\n\nafter', false)
    expect(out).not.toContain('```')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('removes an empty fence with only whitespace between markers', () => {
    const out = stripEmptyFences('```js\n   \n\t\n```', false)
    expect(out.trim()).toBe('')
  })

  it('keeps a fence that has real content', () => {
    const md = '```bash\nls -la\n```'
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('keeps ASCII art inside a fence', () => {
    const md = '```text\n┌───┐\n│ x │\n└───┘\n```'
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('strips a trailing unterminated empty fence only when settled', () => {
    const md = 'intro\n\n```bash'
    expect(stripEmptyFences(md, true)).toContain('```') // streaming: leave the cue
    expect(stripEmptyFences(md, false).trimEnd()).toBe('intro') // settled: strip
  })

  it('does not strip a trailing fence that already has content while streaming', () => {
    const md = 'intro\n\n```bash\nls'
    expect(stripEmptyFences(md, true)).toBe(md)
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('removes multiple empty fences', () => {
    const out = stripEmptyFences('```\n```\n\ntext\n\n```py\n```', false)
    expect(out).not.toContain('```')
    expect(out).toContain('text')
  })

  it('is a no-op for plain prose', () => {
    const md = 'just some text\nwith lines'
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('preserves inline backtick sequences', () => {
    const md = 'Use `code` and ``more code`` inline.'
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('preserves four-space indented literal backticks', () => {
    const md = '    ```\n    not a fence\n    ```'
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('preserves triple-backtick content inside a four-backtick fence', () => {
    const md = '````md\n```js\nconsole.log(1)\n```\n````'
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('does not strip a four-backtick fence that only contains an empty triple fence', () => {
    // Outer fence body is the inner ```…``` lines — not whitespace-only, so keep it.
    const md = '````text\n```\n```\n````'
    expect(stripEmptyFences(md, false)).toBe(md)
  })
})
