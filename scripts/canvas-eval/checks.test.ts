import { describe, expect, test } from 'vitest'
import { checkDocument, type LayerNode } from './checks.ts'

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

function text(id: number, props: Partial<LayerNode>): LayerNode {
  return {
    id,
    type: 'TEXT',
    width: 100,
    height: 20,
    absoluteBounds: box(0, 0, 100, 20),
    fills: [{ color: '#111111' }],
    fontFamily: 'Inter',
    fontStyle: 'Regular',
    characters: 'Roti hangat setiap pagi',
    ...props
  }
}

function page(...children: LayerNode[]) {
  const root: LayerNode = {
    id: 1,
    type: 'FRAME',
    width: 400,
    height: 300,
    clip: true,
    absoluteBounds: box(0, 0, 400, 300),
    children
  }
  return { pages: [{ children: [root] }] }
}

const kinds = (document: ReturnType<typeof page>) => checkDocument(document).map((i) => i.kind)

describe('checkDocument', () => {
  test('a clean design has no issues', () => {
    expect(kinds(page(text(2, {})))).toEqual([])
  })

  test('a page without frames is an empty canvas', () => {
    expect(checkDocument({ pages: [{ children: [] }] }).map((i) => i.kind)).toEqual([
      'empty-canvas'
    ])
  })

  test('fill text in a hug parent collapses to zero width', () => {
    expect(kinds(page(text(2, { width: 0, absoluteBounds: box(10, 10, 0, 15) })))).toEqual([
      'collapsed'
    ])
  })

  test('hug text past the edge of a clipping frame is clipped', () => {
    const issues = checkDocument(page(text(2, { absoluteBounds: box(300, 0, 213, 15) })))
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'clipped-text', id: 2, detail: 'cut off by 113' })
    ])
  })

  test('overflow inside a frame that does not clip is not reported', () => {
    const loose: LayerNode = {
      id: 3,
      type: 'FRAME',
      clip: false,
      absoluteBounds: box(0, 0, 50, 50),
      children: [text(4, { absoluteBounds: box(0, 0, 120, 15) })]
    }
    expect(kinds(page(loose))).toEqual([])
  })

  test('transparent text is invisible', () => {
    const transparent = text(2, { fills: [{ color: '#000000', opacity: 0 }] })
    const alpha = text(3, { fills: [{ color: '#00000000' }] })
    const none = text(4, { fills: [] })
    expect(kinds(page(transparent, alpha, none))).toEqual([
      'invisible-text',
      'invisible-text',
      'invisible-text'
    ])
  })

  test('families and faces the canvas does not embed are flagged', () => {
    const poppins = text(2, { fontFamily: 'Poppins' })
    const medium = text(3, { fontStyle: 'Medium' })
    expect(kinds(page(poppins, medium))).toEqual(['unrendered-font', 'unrendered-font'])
  })

  test('lorem ipsum is placeholder copy', () => {
    expect(kinds(page(text(2, { characters: 'Lorem ipsum dolor sit amet' })))).toEqual([
      'placeholder-copy'
    ])
  })

  test('hidden layers are skipped', () => {
    expect(kinds(page(text(2, { visible: false, fills: [] })))).toEqual([])
  })
})
