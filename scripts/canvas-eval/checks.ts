/**
 * Layout-integrity checks for one eval result, run on the document tree that
 * `inspect_document` returns. These are the rubric's objective failures:
 * anything here is a defect a user would see, independent of taste.
 */

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Paint {
  color?: string
  opacity?: number
  visible?: boolean
}

export interface LayerNode {
  id: number
  name?: string
  type: string
  visible?: boolean
  opacity?: number
  clip?: boolean
  width?: number
  height?: number
  absoluteBounds?: Bounds
  fills?: Paint[]
  characters?: string
  fontFamily?: string
  fontStyle?: string
  children?: LayerNode[]
}

export interface InspectedDocument {
  pages?: { children?: LayerNode[] }[]
}

export type IssueKind =
  | 'empty-canvas'
  | 'collapsed'
  | 'clipped-text'
  | 'invisible-text'
  | 'unrendered-font'
  | 'placeholder-copy'

export interface Issue {
  kind: IssueKind
  id?: number
  name?: string
  detail: string
}

/** Faces the canvas wasm embeds today (#1421, #1422). */
const RENDERED_FACES = new Set(['Regular', 'Italic', 'Semi Bold', 'SemiBold', 'Bold'])
const CONTAINERS = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET', 'SECTION'])
const PLACEHOLDER = /lorem ipsum|dolor sit amet|your (headline|title|text) here|company name/i
/** Rounding in layout reports sizes to the unit, so allow one unit of slack. */
const SLACK = 1

function paints(fills: Paint[] | undefined): boolean {
  return (fills ?? []).some(
    (fill) =>
      fill.visible !== false &&
      (fill.opacity ?? 1) > 0 &&
      !(fill.color?.length === 9 && fill.color.toUpperCase().endsWith('00'))
  )
}

function overflow(inner: Bounds, outer: Bounds): number {
  return Math.max(
    outer.x - inner.x,
    outer.y - inner.y,
    inner.x + inner.width - (outer.x + outer.width),
    inner.y + inner.height - (outer.y + outer.height)
  )
}

export function checkDocument(document: InspectedDocument): Issue[] {
  const issues: Issue[] = []
  const roots = (document.pages ?? []).flatMap((page) => page.children ?? [])
  if (!roots.some((node) => CONTAINERS.has(node.type))) {
    issues.push({ kind: 'empty-canvas', detail: 'no top-level frame on any page' })
  }
  const visit = (node: LayerNode, clips: Bounds[]) => {
    if (node.visible === false || node.opacity === 0) return
    const at = { id: node.id, name: node.name }
    const box = node.absoluteBounds
    const sized = CONTAINERS.has(node.type) || node.type === 'TEXT'
    if (sized && ((node.width ?? 1) < SLACK || (node.height ?? 1) < SLACK)) {
      issues.push({ kind: 'collapsed', ...at, detail: `${node.width} x ${node.height}` })
    }
    if (node.type === 'TEXT') {
      if (!paints(node.fills)) {
        issues.push({ kind: 'invisible-text', ...at, detail: 'no visible fill' })
      }
      const clipped = box && clips.map((clip) => overflow(box, clip)).find((by) => by > SLACK)
      if (clipped) {
        issues.push({ kind: 'clipped-text', ...at, detail: `cut off by ${Math.round(clipped)}` })
      }
      if (node.fontFamily !== 'Inter' || !RENDERED_FACES.has(node.fontStyle ?? '')) {
        issues.push({
          kind: 'unrendered-font',
          ...at,
          detail: `${node.fontFamily} ${node.fontStyle} falls back in the canvas`
        })
      }
      if (node.characters && PLACEHOLDER.test(node.characters)) {
        issues.push({ kind: 'placeholder-copy', ...at, detail: node.characters.slice(0, 60) })
      }
    }
    const inner = node.clip && box ? [...clips, box] : clips
    for (const child of node.children ?? []) visit(child, inner)
  }
  for (const root of roots) visit(root, [])
  return issues
}
