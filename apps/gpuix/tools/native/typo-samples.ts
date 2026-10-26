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

export interface TypoReady {
  bounds: Record<string, { x: number; y: number; width: number; height: number } | null>
}

/** The web twin: the web client's Inter Variable and body font features, same positions. */
export function typoHtml(fontUrl: string): string {
  const blocks = TEXT_SAMPLES.map((s) => {
    const style = `position:absolute;left:${s.left}px;top:${s.top}px;font-size:${s.fontSize}px;line-height:${s.lineHeight}px;${s.width ? `width:${s.width}px;` : 'white-space:pre;'}`
    const body = s.stack
      ? Array.from({ length: s.stack }, () => `<div>${s.text}</div>`).join('')
      : `<span>${s.text}</span>`
    return `<div id="${s.id}" style="${style}">${body}</div>`
  }).join('\n')
  return `<!doctype html><html><head><style>
@font-face{font-family:'${FAMILY}';src:url(${fontUrl}) format('woff2');font-weight:100 900}
html,body{margin:0;background:#000;color:#fff}
body{font-family:'${FAMILY}',sans-serif;font-feature-settings:"cv11","ss01","ss03","cv02";font-variant-ligatures:contextual}
</style></head><body>${blocks}</body></html>`
}
