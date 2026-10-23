import { describe, expect, test } from 'bun:test'
import { proseChunks, proseParts } from '../prose-parts'
import { flowGap } from '../prose-flow'
import { fileLinkPath, proseBlocks } from '../prose-source'

describe('proseParts', () => {
  test('splits top-level fences out of prose with their language', () => {
    expect(proseParts('Intro **bold**\n\n```TS title\nconst a = 1\n```\nAfter')).toEqual([
      { kind: 'prose', key: '0.0', source: 'Intro **bold**' },
      { kind: 'fence', key: '1', language: 'ts', code: 'const a = 1', open: false },
      { kind: 'prose', key: '2.0', source: 'After' }
    ])
  })

  test('an unclosed fence is open and keeps its key as it streams', () => {
    const early = proseParts('Run:\n\n```bash\nls')
    const later = proseParts('Run:\n\n```bash\nls -la\npwd\n```\n\nDone')
    expect(early).toEqual([
      { kind: 'prose', key: '0.0', source: 'Run:' },
      { kind: 'fence', key: '1', language: 'bash', code: 'ls', open: true }
    ])
    expect(later.map((p) => p.key)).toEqual(['0.0', '1', '2.0'])
    expect(later[1]).toEqual({ kind: 'fence', key: '1', language: 'bash', code: 'ls -la\npwd', open: false })
  })

  test('a fence nested in a list item stays in the prose piece', () => {
    const text = '- step\n  ```js\n  x()\n  ```\n- next'
    expect(proseParts(text)).toEqual([{ kind: 'prose', key: '0.0', source: text }])
  })

  test('a closing marker shorter than the opener does not close it', () => {
    expect(proseParts('````md\n```\ninner\n```\n````')).toEqual([
      { kind: 'fence', key: '0', language: 'md', code: '```\ninner\n```', open: false }
    ])
  })

  test('long prose is cut only at block boundaries, and earlier cuts never move', () => {
    const para = (n: number) => `Paragraph ${n} line one\nline two`
    const lines = Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n').split('\n')
    const chunks = proseChunks(lines)
    expect(chunks.length).toBe(3)
    expect(chunks[0].startsWith('Paragraph 0 line one')).toBe(true)
    expect(chunks[1].startsWith('Paragraph 14 line one')).toBe(true)
    expect(chunks[2].startsWith('Paragraph 28 line one')).toBe(true)
    const grown = proseChunks([...lines, '', 'Paragraph 30 line one'])
    expect(grown.slice(0, 2)).toEqual(chunks.slice(0, 2))
  })

  test('a table is never split from its header', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| r${i} | v |`)
    const lines = ['| a | b |', '| --- | --- |', ...rows]
    expect(proseChunks(lines)).toEqual([lines.join('\n')])
  })
})

describe('proseBlocks', () => {
  test('each top-level block is its own markdown source with its kind', () => {
    expect(proseBlocks('## Title\n\nBody **bold**\n\n- a\n- b\n\n---', false)).toEqual([
      { kind: 'markdown', block: 'heading', depth: 2, source: '## Title' },
      { kind: 'markdown', block: 'paragraph', depth: 0, source: 'Body **bold**' },
      { kind: 'markdown', block: 'list', depth: 0, source: '- a\n- b' },
      { kind: 'markdown', block: 'rule', depth: 0, source: '---' }
    ])
  })

  test('bare file paths become termul-file links when file links are on', () => {
    expect(proseBlocks('Edit src/renderer/App.tsx now', true)).toEqual([
      {
        kind: 'markdown',
        block: 'paragraph',
        depth: 0,
        source: 'Edit [src/renderer/App.tsx](termul-file:src%2Frenderer%2FApp.tsx) now'
      }
    ])
    expect(fileLinkPath('termul-file:src%2Frenderer%2FApp.tsx')).toBe('src/renderer/App.tsx')
  })

  test('paths in inline code and urls stay as written', () => {
    const source = 'See `src/a.ts` and https://example.com/src/a.ts'
    expect(proseBlocks(source, true)).toEqual([{ kind: 'markdown', block: 'paragraph', depth: 0, source }])
  })

  test('a markdown link to a local file keeps its label and opens the file', () => {
    expect(proseBlocks('Open [the app](src/renderer/App.tsx#L12) or [docs](https://x.dev)', true)).toEqual([
      {
        kind: 'markdown',
        block: 'paragraph',
        depth: 0,
        source: 'Open [the app](termul-file:src%2Frenderer%2FApp.tsx%3A12) or [docs](https://x.dev)'
      }
    ])
  })

  test('without file links the source is untouched', () => {
    expect(proseBlocks('Edit src/renderer/App.tsx', false)).toEqual([
      { kind: 'markdown', block: 'paragraph', depth: 0, source: 'Edit src/renderer/App.tsx' }
    ])
  })

  test('a paragraph of only images is cut out for the image renderer', () => {
    expect(proseBlocks('Before\n\n![shot](data:image/png;base64,AAAA)\n\nAfter', false)).toEqual([
      { kind: 'markdown', block: 'paragraph', depth: 0, source: 'Before' },
      { kind: 'image', url: 'data:image/png;base64,AAAA', alt: 'shot' },
      { kind: 'markdown', block: 'paragraph', depth: 0, source: 'After' }
    ])
  })

  test('a reference definition follows the block that uses it', () => {
    expect(proseBlocks('See [docs][d].\n\nNext.\n\n[d]: https://x.dev', false)).toEqual([
      { kind: 'markdown', block: 'paragraph', depth: 0, source: 'See [docs][d].\n\n[d]: https://x.dev' },
      { kind: 'markdown', block: 'paragraph', depth: 0, source: 'Next.' }
    ])
  })
})

describe('flowGap', () => {
  test('adjoining margins collapse to the larger, as in the web block flow', () => {
    expect(flowGap({ kind: 'paragraph' }, { kind: 'list' })).toBe(22.75)
    expect(flowGap({ kind: 'list' }, { kind: 'paragraph' })).toBeCloseTo(7.7)
    expect(flowGap({ kind: 'list' }, { kind: 'fence' })).toBe(16)
    expect(flowGap({ kind: 'heading', depth: 2 }, { kind: 'paragraph' })).toBeCloseTo(4.2)
    expect(flowGap({ kind: 'paragraph' }, { kind: 'heading', depth: 2 })).toBe(22.75)
  })
})
