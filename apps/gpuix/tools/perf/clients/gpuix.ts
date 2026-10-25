import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TreeNode } from '@gpuix/native/automation'
import { launch } from '@gpuix/react/automation'
import { APP_DIR } from '../../../build.ts'
import { LAVAPIPE_ICD } from '../../parity/shoot-gpuix.ts'
import { descendants, readCmdline } from '../proc-sampler.ts'
import { PERF_AGENT_NAME, PERF_DEVICE_ID, PERF_PROJECT_NAME, PERF_TOKEN } from '../server.ts'
import type { ChatStartPart, ClientDriver, ClientHandle, ClientLaunchOptions } from './client.ts'

type App = Awaited<ReturnType<typeof launch>>

const WIN = process.platform === 'win32'
/** Read once at load, outside every timed window. */
const WINDOWS_GPU = WIN
  ? execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name'
    ])
      .toString()
      .trim()
  : ''

export interface GpuixHandle extends ClientHandle {
  app: App
  windowHeight: number
}

/** The production bundle (`bun run build`), which sets NODE_ENV=production. */
export const GPUIX_ENTRY = path.join(APP_DIR, 'dist', 'main.js')

/**
 * The real GPUIX app (`dist/main.js`, the production build) on the run's X
 * display, pointed at the byte relay with the perf token. Its web storage
 * lives under the run's scratch dir and is seeded with the device id the
 * Chromium lane uses, so both clients read the same device-scoped agent config.
 */
export async function launchGpuix(
  opts: ClientLaunchOptions & { clientStateDir: string }
): Promise<GpuixHandle> {
  if (opts.gl !== (WIN ? 'gpu' : 'lavapipe'))
    throw new Error(`the GPUIX lane renders with ${WIN ? 'the GPU on Windows' : 'lavapipe'} only`)
  const origin = new URL(opts.url)
  const storage = path.join(
    opts.clientStateDir,
    'web-storage',
    `${origin.hostname}_${origin.port}.json`
  )
  mkdirSync(path.dirname(storage), { recursive: true, mode: 0o700 })
  writeFileSync(
    storage,
    JSON.stringify({ 'termul.webAuthToken': PERF_TOKEN, 'termul.deviceId': PERF_DEVICE_ID }),
    { mode: 0o600 }
  )
  const t0 = performance.now()
  const app = await launch({
    command: process.execPath,
    args: [GPUIX_ENTRY],
    cwd: APP_DIR,
    env: {
      ...process.env,
      ...(WIN ? {} : { DISPLAY: opts.display, VK_ICD_FILENAMES: LAVAPIPE_ICD }),
      GPUIX_BACKGROUND: '1',
      GPUIX_WINDOW_SIZE: `${opts.width}x${opts.height}`,
      TERMUL_SERVER_URL: opts.url,
      TERMUL_SERVER_TOKEN: PERF_TOKEN,
      TERMUL_GPUIX_STATE_DIR: opts.clientStateDir,
      TERMUL_GPUIX_DATA_DIR: path.join(opts.clientStateDir, 'data')
    }
  })
  const launchedMs = performance.now() - t0
  const rootPid = appPid()
  return {
    kind: 'gpuix',
    rootPid,
    launchedMs,
    version: `GPUIX ${gpuixVersion()} on Bun ${Bun.version}`,
    backend: vulkanDriver(rootPid),
    app,
    windowHeight: opts.height,
    close: () => app.close().catch(() => undefined)
  }
}

/** launch() spawns the app as a direct child of this process. */
function appPid(): number {
  for (const pid of descendants(process.pid)) {
    if (pid !== process.pid && readCmdline(pid).includes(GPUIX_ENTRY)) return pid
  }
  throw new Error('could not find the launched GPUIX app process')
}

function gpuixVersion(): string {
  const pkg = path.join(APP_DIR, 'node_modules', '@gpuix', 'native', 'package.json')
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version
}

/** Which Vulkan driver the app actually loaded, from its memory maps. */
function vulkanDriver(pid: number): string {
  if (WIN) return `GPUI on ${WINDOWS_GPU}`
  const maps = readFileSync(`/proc/${pid}/maps`, 'utf8')
  const lib = /\S*libvulkan_\w+\.so\S*/.exec(maps)?.[0]
  return lib ? `GPUI Vulkan, ${path.basename(lib)}` : 'no Vulkan ICD mapped'
}

const ACTION_MS = 30_000
const POLL_MS = 250
const PROJECT_ROW = 'project-item-perf-project-0001'
const LAUNCHER_HEADING = `What should we do in ${PERF_PROJECT_NAME}?`
const COMPOSER_PLACEHOLDER = 'Ask anything… (/ for commands, @ for files)'

function walk(node: TreeNode | null | undefined, visit: (n: TreeNode) => void): void {
  if (!node) return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function find(root: TreeNode, pred: (n: TreeNode) => boolean): TreeNode | null {
  let hit: TreeNode | null = null
  walk(root, (n) => {
    if (!hit && pred(n)) hit = n
  })
  return hit
}

function textOf(node: TreeNode): string {
  let text = node.text ?? ''
  for (const child of node.children ?? []) text += textOf(child)
  return text
}

const contains = (node: TreeNode, pred: (n: TreeNode) => boolean) => find(node, pred) !== null
const byTestId = (id: string) => (n: TreeNode) => n.testId === id
const byText = (text: string) => (n: TreeNode) => n.type === 'text' && n.text === text

async function until<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = ACTION_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await probe()
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await Bun.sleep(POLL_MS)
  }
}

const center = (n: TreeNode) => {
  const b = n.bounds
  if (!b) throw new Error(`node ${n.id} (${n.type}) has no bounds`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

const keysFor = (text: string) => [...text].map((ch) => (ch === ' ' ? 'space' : ch))

/** The app's top-level error boundary replaces the whole UI with this. */
function crashReport(root: TreeNode): string | null {
  const overlay = find(root, byTestId('runtime-error-overlay'))
  if (!overlay) return null
  const stack = find(overlay, byTestId('runtime-error-stack'))
  return (stack ? (stack.children ?? []).map(textOf) : [textOf(overlay)]).join(' | ')
}

/**
 * The app waits at most 2 s for its GPUI UI thread to take each automation
 * command. Under load the UI thread can be busier than that; the command
 * still sits in its ordered queue and lands later, before any command sent
 * after it.
 */
const isUiTimeout = (err: unknown) => /Timed out after 2 seconds waiting for/.test(String(err))
const queued = (err: unknown) => {
  if (!isUiTimeout(err)) throw err
}

/**
 * The automation tree carries test ids and text but no aria-labels, so the
 * controls the Chromium lane finds by label are found here by structure:
 *
 * - New chat: the first icon button next to the side panel's workspace
 *   switcher (`SidePanelColumn`: switcher, then [New chat, hide panel]).
 * - Start agent chat: the button after the launcher's agent picker.
 * - A chat: its card in `chats-list-scroll`; each card names the agent.
 * - A terminal: the status-bar Terminal button, the same spawn path as the
 *   tab bar's Bash entry, and a new `terminal-<id>` element with a prompt.
 */
export function gpuixDriver(handle: GpuixHandle): ClientDriver {
  const { app } = handle
  const titles: string[] = []
  const parts: ChatStartPart[] = []
  const tree = async (): Promise<TreeNode> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const root = (await app.call('getTree', {})).tree as TreeNode
        const crash = crashReport(root)
        if (crash) throw new Error(`app crashed: ${crash}`)
        return root
      } catch (err) {
        if (!isUiTimeout(err) || attempt === 5) throw err
      }
    }
  }
  const click = (n: TreeNode) => app.mouse.click(center(n)).catch(queued)
  // One key per command, as a person types; a long batch is one UI-thread job.
  const type = async (elementId: number, keys: string[]) => {
    for (const key of keys) await app.call('keystrokes', { elementId, keys: key }).catch(queued)
  }
  let terminalId: string | null = null

  const chatCards = (root: TreeNode): TreeNode[] => {
    const list = find(root, byTestId('chats-list-scroll'))
    const cards: TreeNode[] = []
    if (list) walk(list, (n) => byText(PERF_AGENT_NAME)(n) && cards.push(n))
    return cards
  }
  const launcherOpen = (root: TreeNode) => contains(root, byText(LAUNCHER_HEADING))

  // A hidden chat pane can keep its own composer-editor; the launcher's is the
  // first one under the launcher heading.
  const launcherComposer = (root: TreeNode): TreeNode | null => {
    const heading = find(root, byText(LAUNCHER_HEADING))?.bounds
    if (!heading) return null
    const below: TreeNode[] = []
    walk(root, (n) => {
      if (n.testId === 'composer-editor' && n.bounds && n.bounds.y > heading.y) below.push(n)
    })
    return below.sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0] ?? null
  }

  // The launcher's composer remounts while agent config loads, as on the web
  // (see the Chromium lane). The textarea exposes no value, so "the text
  // landed" is the placeholder going away; a new composer id means a remount.
  const typeIntoLauncher = async (firstId: number, prompt: string) => {
    let id = firstId
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = performance.now()
      await type(id, ['ctrl-a', 'backspace', ...keysFor(prompt)])
      const typedMs = Math.round(performance.now() - t0)
      let lastSeen = 'nothing polled'
      const landed = await until(
        'launcher composer shows typed text or remounts',
        async () => {
          const r = await tree()
          const box = launcherComposer(r)
          if (!box) {
            lastSeen = `no launcher composer (heading ${launcherOpen(r) ? 'shown' : 'gone'})`
            return null
          }
          if (box.id !== id) return { remounted: box.id }
          const empty = find(
            r,
            (n) => byText(COMPOSER_PLACEHOLDER)(n) && n.bounds?.y === box.bounds?.y
          )
          lastSeen = empty ? `placeholder still shown in ${box.id}` : 'text landed'
          return empty ? null : { remounted: null }
        },
        20_000
      ).catch(() => ({ remounted: id }))
      if (process.env.PERF_DEBUG)
        console.log(
          `[debug] "${prompt}" attempt ${attempt}: typed in ${typedMs} ms, then ${Math.round(performance.now() - t0 - typedMs)} ms waiting; last seen: ${lastSeen}; next ${landed.remounted ?? 'done'}`
        )
      if (landed.remounted === null) return
      id = landed.remounted
    }
    await debugSnapshot(`type-${prompt}`, 0)
    throw new Error(`launcher composer never accepted "${prompt}"`)
  }

  /**
   * A drag at a person's pace. The app paints its drop zones a frame after
   * `dragstart`, and the compat layer hit-tests the last painted frame, so a
   * burst of moves and a release land before any zone exists to take the drop.
   */
  const humanDrag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const step = (t: number) => ({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t
    })
    await app.mouse.down(from).catch(queued)
    for (let i = 1; i <= 12; i++) {
      await app.mouse.move(step(i / 12), { pressedButton: 0 }).catch(queued)
      await Bun.sleep(25)
    }
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(100)
      await app.mouse.move({ x: to.x, y: to.y + (i % 2) }, { pressedButton: 0 }).catch(queued)
    }
    await app.mouse.up(to).catch(queued)
  }

  const debugSnapshot = async (label: string, expected: number) => {
    const dir = process.env.PERF_DEBUG
    if (!dir) return
    const r = await tree().catch(() => null)
    if (!r) return console.log(`[debug] ${label}: tree unavailable`)
    const box = launcherComposer(r)
    const placeholder =
      !!box && !!find(r, (n) => byText(COMPOSER_PLACEHOLDER)(n) && n.bounds?.y === box.bounds?.y)
    console.log(
      `[debug] ${label}: launcher ${launcherOpen(r) ? 'open' : 'closed'}, composer ${box ? (placeholder ? 'empty' : 'has text') : 'none'}, cards ${chatCards(r).length}, panes ${visibleTranscripts(r).length}, expected more than ${expected}`
    )
    await app
      .screenshot({ path: path.join(dir, `${label.replace(/\W+/g, '-')}.png`) })
      .catch(() => undefined)
  }

  // An inactive chat tab is out of layout, so only on-screen transcripts have bounds.
  const visibleTranscripts = (root: TreeNode): TreeNode[] => {
    const out: TreeNode[] = []
    walk(root, (n) => {
      if (n.testId === 'chat-transcript' && (n.bounds?.width ?? 0) > 0) out.push(n)
    })
    return out
  }

  const terminalNodes = (root: TreeNode): TreeNode[] => {
    const out: TreeNode[] = []
    walk(root, (n) => {
      if (n.testId?.startsWith('terminal-') && n.testId !== 'terminal-assist-close') out.push(n)
    })
    return out
  }

  return {
    handle,
    waitForProjectList: () =>
      until('project row', async () => contains(await tree(), byTestId(PROJECT_ROW)), 60_000).then(
        () => undefined
      ),
    waitForLauncher: () =>
      until('launcher', async () => {
        const root = await tree()
        return launcherOpen(root) && contains(root, byTestId('agent-model-selector-trigger'))
      }).then(() => undefined),
    startChat: async (prompt) => {
      // Under load a click can land on a frame that is about to relayout;
      // New chat is idempotent, so click again if no launcher shows.
      for (let attempt = 0; attempt < 3 && !launcherOpen(await tree()); attempt++) {
        const root = await tree()
        const header = find(
          root,
          (n) =>
            n.children?.length === 2 &&
            textOf(n.children[0]) === 'Workspace' &&
            (n.children[1].children?.length ?? 0) === 2
        )
        const newChat = header?.children?.[1].children?.[0]
        if (!newChat) throw new Error('no New chat button next to the workspace switcher')
        await click(newChat)
        await until(
          'launcher after New chat',
          async () => launcherOpen(await tree()),
          10_000
        ).catch(() => undefined)
      }
      const picker = await until('launcher agent picker names the perf agent', async () => {
        const r = await tree()
        const trigger = find(r, byTestId('agent-model-selector-trigger'))
        return trigger && contains(trigger, byText(PERF_AGENT_NAME)) && launcherComposer(r)
          ? r
          : null
      })
      const before = chatCards(picker).length
      const composer = launcherComposer(picker)
      if (!composer) throw new Error('launcher has no composer')
      const typed = performance.now()
      await typeIntoLauncher(composer.id, prompt)
      const clicked = performance.now()
      // Innermost [picker, button] pair: outer ancestors also have two children.
      const rows: TreeNode[] = []
      walk(await tree(), (n) => {
        if (
          n.children?.length === 2 &&
          contains(n.children[0], byTestId('agent-model-selector-trigger'))
        )
          rows.push(n)
      })
      const start = rows.at(-1)?.children?.[1]
      const size = start?.bounds
      if (start && size && (size.width > 64 || size.height > 64)) {
        throw new Error(
          `Start button candidate is ${size.width}x${size.height}, not an icon button`
        )
      }
      if (!start) throw new Error('no Start button after the agent picker')
      await click(start)
      await until('a new chat card and a closed launcher', async () => {
        const r = await tree()
        return chatCards(r).length > before && !launcherOpen(r)
      }).catch(async (err) => {
        await debugSnapshot(`start-${prompt}`, before)
        throw err
      })
      parts.push({
        typeMs: Math.round(clicked - typed),
        openMs: Math.round(performance.now() - clicked)
      })
      titles.push(prompt)
    },
    chatStartParts: () => parts,
    crashed: async () => crashReport((await app.call('getTree', {})).tree as TreeNode),
    chatCount: async () => chatCards(await tree()).length,
    switchToChat: async (index) => {
      const title = titles[index % titles.length]
      const list = find(await tree(), byTestId('chats-list-scroll'))
      const card = list && find(list, byText(title))
      if (!card) throw new Error(`no chat card titled ${title}`)
      await click(card)
    },
    // The tab, not the sidebar card: with every chat streaming the sidebar
    // reorders its cards by latest activity, so the card under the press can
    // differ from the one the tree placed there a moment before. Tabs hold
    // still; the scenario splits the first tab each time, which no narrow
    // pane clips.
    splitChatRight: async (title) => {
      const root = await tree()
      const panes = visibleTranscripts(root)
      const pane = [...panes].sort((a, b) => (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0))[0]
      const box = pane?.bounds
      if (!box) throw new Error('no pane on screen')
      const tab = find(
        root,
        (n) =>
          byText(title)(n) &&
          !!n.bounds &&
          n.bounds.y < box.y &&
          n.bounds.x >= box.x &&
          n.bounds.x < box.x + box.width
      )
      if (!tab) throw new Error(`no tab titled ${title} in the left pane`)
      // The right drop zone is the pane's right quarter.
      await humanDrag(center(tab), { x: box.x + box.width * 0.9, y: box.y + box.height / 2 })
      await until(
        'a pane of its own',
        async () => visibleTranscripts(await tree()).length > panes.length
      ).catch(async (err) => {
        await debugSnapshot(`split-${title}`, panes.length)
        throw err
      })
    },
    visibleChatCount: async () => visibleTranscripts(await tree()).length,
    openTerminal: async () => {
      const root = await tree()
      const seen = new Set(terminalNodes(root).map((t) => t.testId))
      const button = find(
        root,
        (n) => byText('Terminal')(n) && (n.bounds?.y ?? 0) > handle.windowHeight - 40
      )
      if (!button) throw new Error('no status-bar Terminal button')
      await click(button)
      // Keys typed before the shell prints its prompt are lost, so wait for the
      // prompt: bash's `$`/`#`, or Command Prompt's `>` on Windows.
      const opened = await until('a new terminal with a prompt', async () =>
        terminalNodes(await tree()).find(
          (t) =>
            !seen.has(t.testId) && (t.children ?? []).some((row) => /[#$>] *$/.test(textOf(row)))
        )
      )
      terminalId = opened.testId ?? null
    },
    runInTerminal: async (command) => {
      if (!terminalId) throw new Error('no terminal opened')
      const nodes = terminalNodes(await tree())
      const node = nodes.find((t) => t.testId === terminalId)
      if (!node) {
        await debugSnapshot(`terminal-${terminalId.slice(-6)}`, nodes.length)
        throw new Error(
          `terminal ${terminalId} is not in the tree; present: ${nodes.map((t) => t.testId).join(', ') || 'none'}`
        )
      }
      await app
        .call('keystrokes', { elementId: node.id, keys: [...keysFor(command), 'enter'].join(' ') })
        .catch(queued)
    },
    waitForTerminalText: async (marker, timeoutMs) => {
      await until(
        `terminal text ${marker}`,
        async () => {
          const node = terminalNodes(await tree()).find((t) => t.testId === terminalId)
          return node && textOf(node).includes(marker)
        },
        timeoutMs
      )
    },
    beginPhase: async () => undefined,
    endPhase: async () => null
  }
}
