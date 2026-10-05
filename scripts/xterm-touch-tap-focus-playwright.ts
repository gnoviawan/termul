/**
 * Mobile-emulation check for issue #845.
 *
 * Loads the installed @xterm/xterm (6.1 beta) in headless Chrome with
 * hasTouch, blurs the helper textarea, then taps `.xterm-screen`. Without the
 * workaround the tap does not focus (Gesture preventDefault cancels the
 * compatibility click). With `bindXtermTouchTapFocus`, the textarea is focused
 * and typed bytes show up on xterm's onData — the same stream
 * ConnectedTerminal writes to the PTY via terminalApi.write.
 *
 * A drag past the tap slop must not focus, and an existing selection must
 * survive a tap. A desktop mouse click (hasTouch: false) still focuses.
 *
 * Run: bun scripts/xterm-touch-tap-focus-playwright.ts
 */

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, type BrowserContext, chromium, devices, type Page } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const xtermMjs = readFileSync(resolve(root, 'node_modules/@xterm/xterm/lib/xterm.mjs'))
const xtermCss = readFileSync(resolve(root, 'node_modules/@xterm/xterm/css/xterm.css'))

const PAGE = `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/xterm.css">
  <style>html,body{margin:0;height:100%;background:#111}#t{height:100%;width:100%}</style>
</head>
<body>
  <div id="t"></div>
  <script type="module">
    import { Terminal } from '/xterm.mjs'
    import { bindXtermTouchTapFocus } from '/bind.js'
    const term = new Terminal({ fontSize: 16, rows: 30, cols: 60, scrollback: 1000, cursorBlink: false })
    term.open(document.getElementById('t'))
    const bind = new URLSearchParams(location.search).get('bind') !== '0'
    if (bind) bindXtermTouchTapFocus(term)
    const lines = []
    for (let i = 0; i < 80; i++) lines.push('line ' + i + '  ' + 'x'.repeat(20))
    term.writeln(lines.join('\\r\\n'))
    term.write('$ ')
    window.__term = term
    window.__pty = ''
    term.onData((data) => { window.__pty += data })
    term.focus()
    window.__ready = true
  </script>
</body>
</html>`

interface Harness {
  url: string
  close: () => Promise<void>
}

async function bundleBinder(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [resolve(root, 'src/renderer/components/terminal/xterm-touch-tap-focus.ts')],
    target: 'browser',
    format: 'esm',
    write: false
  })
  if (!built.success) {
    throw new Error(built.logs.map((line) => line.message).join('\n'))
  }
  return built.outputs[0].text()
}

function startServer(bindJs: string): Promise<Harness> {
  const server: Server = createServer((req, res) => {
    const path = req.url?.split('?')[0]
    if (path === '/xterm.mjs') {
      res.setHeader('content-type', 'text/javascript')
      res.end(xtermMjs)
      return
    }
    if (path === '/xterm.css') {
      res.setHeader('content-type', 'text/css')
      res.end(xtermCss)
      return
    }
    if (path === '/bind.js') {
      res.setHeader('content-type', 'text/javascript')
      res.end(bindJs)
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(PAGE)
  })
  return new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      done({
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()))
          })
      })
    })
  })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function openPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true)
  await page.waitForSelector('.xterm-helper-textarea')
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`)
  return page
}

async function installFocusCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const term = (window as unknown as { __term: { focus: () => void } }).__term
    const orig = term.focus.bind(term)
    let count = 0
    term.focus = () => {
      count += 1
      orig()
    }
    ;(window as unknown as { __focusCount: () => number }).__focusCount = () => count
    document.activeElement instanceof HTMLElement && document.activeElement.blur()
  })
}

async function readState(page: Page): Promise<{
  active: string
  pty: string
  focusCount: number
  viewportY: number
  selectionLength: number
}> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __pty: string
      __focusCount?: () => number
      __term: {
        buffer: { active: { viewportY: number } }
        getSelection: () => string
      }
    }
    const active = document.activeElement
    const activeClass =
      active instanceof HTMLElement && active.className
        ? active.className
        : active?.tagName || 'none'
    return {
      active: activeClass,
      pty: w.__pty,
      focusCount: w.__focusCount?.() ?? -1,
      viewportY: w.__term.buffer.active.viewportY,
      selectionLength: w.__term.getSelection().length
    }
  })
}

async function touchDrag(page: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
  const session = await page.context().newCDPSession(page)
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }]
  })
  const steps = 4
  for (let i = 1; i <= steps; i++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }]
    })
  }
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  })
  await session.detach()
}

async function checkBrokenBaseline(
  browser: Browser,
  baseUrl: string,
  deviceName: string
): Promise<void> {
  const { defaultBrowserType: _ignored, ...device } = devices[deviceName]
  const context = await browser.newContext(device)
  const page = await openPage(context, `${baseUrl}?bind=0`)
  await page.evaluate(() => {
    document.activeElement instanceof HTMLElement && document.activeElement.blur()
  })
  await page.locator('.xterm-screen').tap()
  await page.waitForTimeout(200)
  const state = await readState(page)
  assert(
    !state.active.includes('xterm-helper-textarea'),
    `${deviceName} without workaround unexpectedly focused (${state.active}). This Chrome did not reproduce #845.`
  )
  console.log(`${deviceName} baseline (no workaround): tap left focus on ${state.active}`)
  await context.close()
}

async function checkFixed(browser: Browser, baseUrl: string, deviceName: string): Promise<void> {
  const { defaultBrowserType: _ignored, ...device } = devices[deviceName]
  assert(device.hasTouch, `${deviceName} context is not a touch device`)
  const context = await browser.newContext(device)
  const page = await openPage(context, `${baseUrl}?bind=1`)
  await installFocusCounter(page)

  await page.locator('.xterm-screen').tap()
  await page.waitForTimeout(150)
  let state = await readState(page)
  assert(
    state.active.includes('xterm-helper-textarea'),
    `${deviceName} tap did not focus textarea (active=${state.active})`
  )
  assert(state.focusCount === 1, `${deviceName} tap focused ${state.focusCount} times`)

  await page.keyboard.insertText('hi')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  state = await readState(page)
  assert(
    state.pty.includes('hi'),
    `${deviceName} typed text missing from PTY stream: ${JSON.stringify(state.pty)}`
  )
  assert(
    state.pty.includes('\r'),
    `${deviceName} Enter missing from PTY stream: ${JSON.stringify(state.pty)}`
  )

  const focusedBeforeSecondTap = state.focusCount
  await page.locator('.xterm-screen').tap()
  await page.waitForTimeout(100)
  state = await readState(page)
  assert(
    state.focusCount === focusedBeforeSecondTap,
    `${deviceName} second tap refocused (${state.focusCount} vs ${focusedBeforeSecondTap})`
  )

  await page.evaluate(() => {
    const term = (
      window as unknown as { __term: { selectAll: () => void; getSelection: () => string } }
    ).__term
    term.selectAll()
    ;(window as unknown as { __selection: string }).__selection = term.getSelection()
    document.activeElement instanceof HTMLElement && document.activeElement.blur()
  })
  await page.locator('.xterm-screen').tap()
  await page.waitForTimeout(100)
  const selection = await page.evaluate(() => {
    const w = window as unknown as {
      __selection: string
      __term: { getSelection: () => string }
    }
    return { before: w.__selection.length, after: w.__term.getSelection().length }
  })
  state = await readState(page)
  assert(
    state.active.includes('xterm-helper-textarea'),
    `${deviceName} tap after selectAll did not focus`
  )
  assert(
    selection.after > 0 && selection.after === selection.before,
    `${deviceName} tap cleared selection (${selection.before} -> ${selection.after})`
  )

  await page.evaluate(() => {
    document.activeElement instanceof HTMLElement && document.activeElement.blur()
  })
  const beforeDrag = await readState(page)
  const box = await page.locator('.xterm-screen').boundingBox()
  assert(box, `${deviceName} screen has no box`)
  await touchDrag(page, box.x + box.width / 2, box.y + 40, 0, 160)
  await page.waitForTimeout(200)
  state = await readState(page)
  assert(
    !state.active.includes('xterm-helper-textarea'),
    `${deviceName} scroll drag focused the textarea`
  )
  assert(
    state.viewportY !== beforeDrag.viewportY,
    `${deviceName} touch drag did not scroll (viewportY ${beforeDrag.viewportY} -> ${state.viewportY})`
  )
  console.log(
    `${deviceName} fixed: pty=${JSON.stringify(state.pty)} scroll ${beforeDrag.viewportY}->${state.viewportY} selection=${selection.after} dragFocus=${state.active}`
  )
  await context.close()
}

async function checkDesktopClick(browser: Browser, baseUrl: string): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    hasTouch: false,
    isMobile: false
  })
  const page = await openPage(context, `${baseUrl}?bind=1`)
  await installFocusCounter(page)
  const blurred = await readState(page)
  assert(
    !blurred.active.includes('xterm-helper-textarea'),
    `desktop blur failed (${blurred.active})`
  )
  await page.locator('.xterm-screen').click()
  await page.waitForTimeout(100)
  const state = await readState(page)
  assert(
    state.active.includes('xterm-helper-textarea'),
    `desktop click did not focus (${state.active})`
  )
  // Mouse clicks focus through xterm's own mousedown handler, not the touch
  // listener, so the public focus() wrapper stays at 0.
  assert(
    state.focusCount === 0,
    `desktop click also ran the touch focus path (${state.focusCount})`
  )
  await page.keyboard.insertText('ls')
  const typed = await readState(page)
  assert(
    typed.pty.includes('ls'),
    `desktop click typing missing from PTY stream: ${JSON.stringify(typed.pty)}`
  )
  console.log(`desktop click: focus=${state.active} pty=${JSON.stringify(typed.pty)}`)
  await context.close()
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
})
const harness = await startServer(await bundleBinder())
try {
  for (const deviceName of ['Pixel 7', 'iPhone 13']) {
    await checkBrokenBaseline(browser, harness.url, deviceName)
    await checkFixed(browser, harness.url, deviceName)
  }
  await checkDesktopClick(browser, harness.url)
  console.log('xterm touch-tap focus checks passed')
} finally {
  await browser.close()
  await harness.close()
}
