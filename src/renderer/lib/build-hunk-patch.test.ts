import { describe, expect, it } from 'vitest'
import { buildHunkPatches } from './build-hunk-patch'

const SINGLE_HUNK_DIFF = [
  'diff --git a/foo.txt b/foo.txt',
  'index 1111111..2222222 100644',
  '--- a/foo.txt',
  '+++ b/foo.txt',
  '@@ -1,3 +1,3 @@',
  ' context line',
  '-old line',
  '+new line',
  ' trailing context'
].join('\n')

describe('buildHunkPatches', () => {
  it('returns no patches for empty diff', () => {
    expect(buildHunkPatches('', 'foo.txt')).toEqual([])
    expect(buildHunkPatches('whatever', '')).toEqual([])
  })

  it('builds one patch for a single-hunk diff with a/ b/ headers and body', () => {
    const hunks = buildHunkPatches(SINGLE_HUNK_DIFF, 'foo.txt')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].headerIndex).toBe(4)
    expect(hunks[0].headerLine).toBe('@@ -1,3 +1,3 @@')
    expect(hunks[0].patch).toBe(
      [
        '--- a/foo.txt',
        '+++ b/foo.txt',
        '@@ -1,3 +1,3 @@',
        ' context line',
        '-old line',
        '+new line',
        ' trailing context',
        '' // trailing newline: every diff line ends with \n
      ].join('\n')
    )
  })

  it('builds one patch per hunk for a multi-hunk diff', () => {
    const diff = [
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,2 +1,2 @@',
      ' ctx1',
      '-del1',
      '+add1',
      '@@ -10,2 +11,2 @@',
      ' ctx2',
      '-del2',
      '+add2'
    ].join('\n')
    const hunks = buildHunkPatches(diff, 'foo.txt')
    expect(hunks).toHaveLength(2)
    expect(hunks[0].headerIndex).toBe(2)
    expect(hunks[1].headerIndex).toBe(6)
    expect(hunks[0].patch).toContain('@@ -1,2 +1,2 @@')
    expect(hunks[1].patch).toContain('@@ -10,2 +11,2 @@')
    // Each patch must be self-contained: include the a/ b/ headers.
    expect(hunks[1].patch.startsWith('--- a/foo.txt\n+++ b/foo.txt\n')).toBe(true)
  })

  it('preserves meta lines (e.g. "\\ No newline at end of file") in the body', () => {
    const diff = [
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new'
    ].join('\n')
    const hunks = buildHunkPatches(diff, 'foo.txt')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].patch).toContain('\\ No newline at end of file')
  })

  it('does not truncate the body when a deletion looks like a file header', () => {
    // Deleting a line whose text starts with `-- ` (e.g. a SQL comment)
    // produces the diff line `--- comment`, which naïvely looks like a
    // `--- a/...` file header. The body must be bounded by the @@ counts,
    // not by prefix sniffing, so the hunk is not split mid-body and the
    // staged patch keeps every line (#257 review feedback).
    const diff = [
      '--- a/foo.sql',
      '+++ b/foo.sql',
      '@@ -1,2 +1,2 @@',
      ' context',
      '--- comment',
      '+-- new'
    ].join('\n')
    const hunks = buildHunkPatches(diff, 'foo.sql')
    // One hunk, not split mid-body by the `--- comment` line.
    expect(hunks).toHaveLength(1)
    expect(hunks[0].patch).toContain(' context')
    expect(hunks[0].patch).toContain('--- comment')
    expect(hunks[0].patch).toContain('+-- new')
  })

  it('stops a hunk at the next file header in a multi-file diff', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      'diff --git a/b.txt b/b.txt',
      '--- b/b.txt',
      '+++ b/b.txt',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B'
    ].join('\n')
    const hunks = buildHunkPatches(diff, 'a.txt')
    // buildHunkPatches is called per-file; only the first file's hunk should
    // be collected because the second `diff` header flushes and the next
    // hunk belongs to a different path (which the backend would reject).
    expect(hunks).toHaveLength(1)
    expect(hunks[0].patch).toContain('-a\n+A')
  })
})
