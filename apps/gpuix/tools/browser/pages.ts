/**
 * Local pages for the browser-pane checks. Page one reports every key it receives in its title
 * (the app shows the title on the tab) and on the console; both pages log a load line.
 */

const VIEWPORT = `const vp = () => console.log('b2-viewport ' + innerWidth + 'x' + innerHeight);
addEventListener('load', vp); addEventListener('resize', vp);`

const STYLE = `body{margin:0;font:20px sans-serif;background:#1f6f43;color:#fff}main{padding:24px}
a{display:block;color:#ffe08a;font-size:28px;padding:16px 0}#typed{font:32px monospace;background:#0b3d23;padding:12px;min-height:40px}`

function page(title: string, body: string, script: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head>
<body><main>${body}</main><script>${VIEWPORT}${script}</script></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export function startPages(): { origin: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/one')
        return page(
          'B2 page one',
          '<a id="next" href="/two">Go to page two</a><h1>Page one</h1><div id="typed"></div>',
          `console.log('b2-page-one-loaded');
let typed = '';
document.addEventListener('keydown', (e) => {
  if (e.key.length !== 1) return;
  typed += e.key;
  document.getElementById('typed').textContent = typed;
  document.title = 'B2 keys ' + typed;
  console.log('b2-key ' + e.key);
});`
        )
      if (pathname === '/two')
        return page(
          'B2 page two',
          '<h1>Page two</h1><p>The second page.</p>',
          `console.log('b2-page-two-loaded')`
        )
      return new Response('not found', { status: 404 })
    }
  })
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
