/**
 * Shared by the typography scene (GPUIX), its web twin (Chromium) and the
 * checker. Every sample sits at a fixed window position in both clients, so
 * the checker compares the two frames in one coordinate system.
 */
export const TYPO_WINDOW = { width: 960, height: 600 } as const
export const FAMILY = 'Inter Variable'

/** Words of x-height letters only: every wrapped line has the same ink band. */
const XWORDS = 'num mux nun xum muu wax runs maze snow cows mean'
const paragraph = (words: number) =>
  Array.from({ length: words }, (_, i) => XWORDS.split(' ')[i % 11]).join(' ')

const RUN_TEXT =
  'The quick brown fox jumps over the lazy dog while the agent reads every file in the workspace, then writes a plan.'

export interface TextSample {
  id: string
  left: number
  top: number
  width?: number
  fontSize: number
  lineHeight: number
  text: string
  /** Rendered as this many separate one-line elements stacked in a column. */
  stack?: number
}

export const TEXT_SAMPLES: readonly TextSample[] = [
  /** The brief's 13px/1.5 run: lines 19.5 px apart in Chromium. */
  {
    id: 'pitch13',
    left: 16,
    top: 16,
    width: 240,
    fontSize: 13,
    lineHeight: 19.5,
    text: paragraph(48)
  },
  /** Tailwind `text-xs leading-relaxed`, the settings descriptions. */
  {
    id: 'pitch12',
    left: 288,
    top: 16,
    width: 240,
    fontSize: 12,
    lineHeight: 19.5,
    text: paragraph(48)
  },
  /** The same metrics as one-line elements stacked in a column (settings rows). */
  {
    id: 'stack12',
    left: 560,
    top: 16,
    fontSize: 12,
    lineHeight: 19.5,
    text: 'num mux nun',
    stack: 10
  },
  { id: 'run13', left: 16, top: 440, fontSize: 13, lineHeight: 20, text: RUN_TEXT },
  { id: 'run14', left: 16, top: 480, fontSize: 14, lineHeight: 20, text: RUN_TEXT },
  { id: 'run12', left: 16, top: 520, fontSize: 12, lineHeight: 20, text: RUN_TEXT }
]

/**
 * The matrix transcript's table (tools/chat/script.ts) in a 734 px card, as
 * `.chat-streamdown` lays it out: `w-full` auto table layout, 8 by 4.8 px
 * cells, 14/20 text, a semibold header, inline code at 0.88em with 0.3em
 * side padding. The checker compares where each header label starts.
 */
export const TABLE_SAMPLE = {
  id: 'table',
  left: 16,
  top: 236,
  width: 734,
  align: ['left', 'left', 'center'] as const,
  rows: [
    ['Route', 'Component', 'Panes mounted'],
    ['`/`', '`WorkspaceDashboard`', 'yes'],
    ['`/c/:sessionId`', '`ChatRoute`', 'yes'],
    ['`/snapshots`', '`WorkspaceSnapshots`', 'no'],
    ['anything else', '`NotFound`', 'no']
  ]
} as const

export function tableMarkdown(): string {
  const [head, ...body] = TABLE_SAMPLE.rows
  const rule = TABLE_SAMPLE.align.map((a) => (a === 'center' ? ':---:' : '---'))
  return [head, rule, ...body].map((cells) => `| ${cells.join(' | ')} |`).join('\n')
}

function tableHtml(): string {
  const cell = (tag: string, text: string, col: number) =>
    `<${tag} style="text-align:${TABLE_SAMPLE.align[col]}">${text.replace(/`([^`]+)`/g, '<code>$1</code>')}</${tag}>`
  const [head, ...body] = TABLE_SAMPLE.rows
  const row = (tag: string, cells: readonly string[]) =>
    `<tr>${cells.map((c, i) => cell(tag, c, i)).join('')}</tr>`
  const { id, left, top, width } = TABLE_SAMPLE
  return `<div id="${id}" class="card" style="position:absolute;left:${left}px;top:${top}px;width:${width - 2}px"><table><thead>${row('th', head)}</thead><tbody>${body.map((r) => row('td', r)).join('')}</tbody></table></div>`
}

/** One `typo-check.ts` result; `patch-check.ts` prints them with its own rows. */
export interface TypoRow {
  /** The patch or gap the row proves: `zed/0005` line pitch, `run-width` advances. */
  patch: string
  what: string
  value: unknown
  ok: boolean
}

export interface TypoReady {
  bounds: Record<string, { x: number; y: number; width: number; height: number } | null>
}

/** The web twin: the web client's Inter Variable and body font features, same positions. */
export function typoHtml(fontUrl: string, monoUrl: string): string {
  const blocks =
    TEXT_SAMPLES.map((s) => {
      const style = `position:absolute;left:${s.left}px;top:${s.top}px;font-size:${s.fontSize}px;line-height:${s.lineHeight}px;${s.width ? `width:${s.width}px;` : 'white-space:pre;'}`
      const body = s.stack
        ? Array.from({ length: s.stack }, () => `<div>${s.text}</div>`).join('')
        : `<span>${s.text}</span>`
      return `<div id="${s.id}" style="${style}">${body}</div>`
    }).join('\n') + tableHtml()
  return `<!doctype html><html><head><style>
@font-face{font-family:'${FAMILY}';src:url(${fontUrl}) format('woff2');font-weight:100 900}
@font-face{font-family:'Paper Mono';src:url(${monoUrl}) format('woff2');font-weight:100 800}
html,body{margin:0;background:#000;color:#fff}
.card{border:1px solid #444;font-size:14px;line-height:20px}
table{width:100%;border-collapse:collapse;text-align:left}
th,td{padding:4.8px 8px}
th{font-weight:600}
tbody tr{border-top:1px solid #444}
code{font-family:'Paper Mono',monospace;font-size:.88em;padding:.08em .3em;font-feature-settings:normal;font-variant-ligatures:common-ligatures}
body{font-family:'${FAMILY}',sans-serif;font-feature-settings:"cv11","ss01","ss03","cv02";font-variant-ligatures:contextual}
</style></head><body>${blocks}</body></html>`
}
