import { describe, expect, it } from 'vitest'
import { normalizePlanFenceBoundary, stripEmptyFences } from './strip-empty-fences'

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

  it('stops scanning after an unmatched opening fence', () => {
    // Nested empty triple fence must stay; continuing the scan would wrongly strip it.
    const md = 'intro\n\n````outer\n```\n```\nmore text'
    expect(stripEmptyFences(md, true)).toBe(md)
    expect(stripEmptyFences(md, false)).toBe(md)
  })

  it('rejects backtick fences whose info string contains a backtick', () => {
    // CommonMark does not treat ```foo` as an opener. A following empty fence
    // is therefore stripped on its own, while the invalid opener line remains.
    const md = '```foo`\n\n```bash\n```\n\nafter'
    for (const streaming of [false, true]) {
      const out = stripEmptyFences(md, streaming)
      expect(out).toContain('```foo`')
      expect(out).not.toContain('```bash')
      expect(out).toContain('after')
    }
  })

  it('still allows backticks in tilde-fence info strings', () => {
    const md = '~~~foo`bar\n\n~~~'
    expect(stripEmptyFences(md, false).trim()).toBe('')
  })
})

describe('normalizePlanFenceBoundary', () => {
  const fence = '```termul-plan\n[{"content":"x"}]\n```'

  it('inserts a newline before a termul-plan opener glued to prose', () => {
    // Mirrors the joined-blocks text produced before the appendPlanSnapshot fix
    const joined = `working on it${fence}`
    const out = normalizePlanFenceBoundary(joined)
    expect(out).toBe(`working on it\n${fence}`)
    // The opener is now at the start of a line (CommonMark fence requirement)
    expect(/(^|\n)```termul-plan/.test(out)).toBe(true)
  })

  it('leaves an opener already at line start untouched', () => {
    const md = `intro\n\n${fence}`
    expect(normalizePlanFenceBoundary(md)).toBe(md)
  })

  it('leaves an opener at position 0 untouched', () => {
    expect(normalizePlanFenceBoundary(fence)).toBe(fence)
  })

  it('leaves a CRLF-terminated prose untouched (opener already at line start)', () => {
    // `\r\n` ends with `\n`, so the opener is already at the start of a line.
    const md = `intro\r\n${fence}`
    expect(normalizePlanFenceBoundary(md)).toBe(md)
  })

  it('splits a lone CR before the opener so the fence is recognized', () => {
    // A lone `\r` (not `\r\n`) is not `\n`; the normalizer must split it so
    // the opener sits on its own line.
    const joined = `prose\r${fence}`
    const out = normalizePlanFenceBoundary(joined)
    expect(/(^|\n)```termul-plan/.test(out)).toBe(true)
  })

  it('leaves a longer info string like termul-plan-v2 untouched', () => {
    // Only the exact opener (followed by a newline) is normalized; a quoted
    // reference with a suffix must not be split.
    const md = 'see ```termul-plan-v2 notes```'
    expect(normalizePlanFenceBoundary(md)).toBe(md)
  })

  it('does not split a backtick run that precedes the opener', () => {
    // A 4-backtick run before `termul-plan` is a longer fenced construct; the
    // regex matches the trailing 3 backticks, but the line prefix is a single
    // backtick (the 4th) — that must be left intact, not split.
    const md = '````termul-plan\n[{"content":"x"}]\n````'
    expect(normalizePlanFenceBoundary(md)).toBe(md)
  })

  it('leaves an indented (up to 3 spaces) opener untouched', () => {
    // CommonMark allows up to 3 leading spaces on a fence opener.
    const md = `intro\n   ${fence}`
    expect(normalizePlanFenceBoundary(md)).toBe(md)
  })

  it('normalizes a glued opener inside a larger prose paragraph', () => {
    const joined = `here is some prose without a newline${fence}`
    const out = normalizePlanFenceBoundary(joined)
    expect(out).toBe(`here is some prose without a newline\n${fence}`)
  })
})
