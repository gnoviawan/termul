/**
 * The page the `browser.pane` surface opens in both browser panes: static, no
 * script, no web fonts, on a fixed port so the typed URL is the same in both
 * clients. Both panes are WebKitGTK webviews, so its pixels should match.
 */

export const PAGE_PORT = 8289
export const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/reference`
export const PAGE_TITLE = 'R5 reference page'

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title>
<style>body{margin:0;font:20px sans-serif;background:#1f6f43;color:#fff}main{padding:24px}
h1{margin:0 0 16px}p{color:#ffe08a}div{width:160px;height:80px;background:#0b3d23}</style></head>
<body><main><h1>Reference page</h1><p>Rendered by the pane's own webview.</p><div></div></main></body></html>`

let server: ReturnType<typeof Bun.serve> | null = null

/** Serve the page once per process; a port another process holds fails loudly. */
export function servePage(): void {
  server ??= Bun.serve({
    port: PAGE_PORT,
    hostname: '127.0.0.1',
    fetch: (req) =>
      new URL(req.url).pathname === '/reference'
        ? new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : new Response('not found', { status: 404 })
  })
}
