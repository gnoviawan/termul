/**
 * GPUIX side of the workspace terminal pane scene: each visited project's
 * pane tree from the real workspace store, kept mounted while hidden like
 * `ProjectTreeHost`, with the tab strip (`TerminalTabInline` through compat)
 * and the pane body `PaneContent` gives a terminal tab (the `ConnectedTerminal`
 * override). `PaneContent` itself cannot join the bundle yet: its lazy panels
 * reach BlockNote, which has no GPUIX override. Terminals open through
 * `spawnTerminalInPane` and projects switch through the stores, as the app
 * does; the harness drives it with a control file and reads a state file.
 */
import { type NativeRenderer, render } from '@gpuix/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { ConnectedTerminal } from '@/components/terminal/ConnectedTerminal'
import { TerminalTabInline } from '@/components/workspace/tabs/terminal-tab'
import { useProjectRegistry } from '@/hooks/use-project-registry'
import { useTerminalDetachedOutput } from '@/hooks/use-terminal-detached-output'
import { spawnTerminalInPane } from '@/lib/terminal-spawn'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { setWebAuthToken } from '@/lib/web-auth-token'
import { ensureClientIdentity } from '@/lib/web-client-identity'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalActions, useTerminalStore } from '@/stores/terminal-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import { ProjectPaneContext, selectProjectTree } from '@/stores/workspace-store/pane-context'
import { getTerminal } from '@/utils/terminal-registry'
import type { ClientConfig } from '../../../src/client-config'
import { CompatRoot, compatRenderOptions } from '../../../src/compat/root'
import { log } from '../../../src/log'
import { tw } from '../../../src/style/tw'
import { screenOf } from '../../../src/terminal/xterm-facade'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { ControlIo, PaneBox, PaneSceneOptions, PaneSceneState } from './contract'

let io: ControlIo = { read: () => null, write: () => {} }
export function setControlIo(next: ControlIo): void {
  io = next
}

let switchStarted: { projectId: string; at: number } | null = null
let lastSwitch: PaneSceneState['lastSwitch'] = null
let lastHit: string[] = []
let pingStarted: number | null = null
let lastPing: PaneSceneState['lastPing'] = null
let publishMs = 0
let setPing: ((n: number) => void) | null = null

function Ping() {
  const [n, set] = useState(0)
  setPing = set
  useLayoutEffect(() => {
    if (pingStarted !== null && n > 0)
      lastPing = { commitMs: performance.now() - pingStarted, frameMs: null }
  }, [n])
  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        bottom: 0,
        width: 1,
        height: 1,
        backgroundColor: n % 2 ? '#010101' : '#020202'
      }}
    />
  )
}
const screenIds = new WeakMap<object, number>()
let nextScreenId = 1
const screensSeen = new Map<string, Set<number>>()

/** PaneContent's tab strip and terminal body for one leaf. */
const TAB_STRIP = 36

function TerminalPane({
  paneId,
  projectId,
  box
}: {
  paneId: string
  projectId: string
  box?: PaneBox
}) {
  const pane = useWorkspaceStore((state) =>
    getAllLeafPanes(selectProjectTree(state, projectId).root).find((leaf) => leaf.id === paneId)
  )
  const terminals = useTerminalStore(
    useShallow((state) => state.terminals.filter((t) => t.projectId === projectId))
  )
  const isActiveProject = useWorkspaceStore((state) => state.activeProjectId === projectId)
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab)
  const { setTerminalPtyId, renameTerminal } = useTerminalActions()
  if (!pane) return null
  const tabs = pane.tabs.filter((tab) => tab.type === 'terminal')
  const visibleTabId = isActiveProject ? pane.activeTabId : undefined
  return (
    <div
      style={
        box
          ? {
              ...tw('flex flex-col'),
              position: 'absolute',
              left: box.x,
              top: box.y - TAB_STRIP,
              width: box.width,
              height: box.height + TAB_STRIP
            }
          : tw('flex h-full w-full flex-col')
      }
    >
      <div style={tw('flex h-9 shrink-0 flex-row items-center gap-1 border-b border-border px-2')}>
        {tabs.map((tab) => {
          const terminal = terminals.find((t) => t.id === tab.terminalId)
          if (!terminal) return null
          return (
            <TerminalTabInline
              key={tab.id}
              terminal={terminal}
              isActive={tab.id === pane.activeTabId}
              isDragging={false}
              isDropTarget={false}
              dropPosition={null}
              onSelect={() => setActiveTab(pane.id, tab.id)}
              onClose={() => {}}
              onRename={(name: string) => renameTerminal(terminal.id, name)}
              onDragStart={() => {}}
              onDragOver={() => {}}
              onDragLeave={() => {}}
              onDrop={() => {}}
            />
          )
        })}
      </div>
      <div style={tw('relative min-h-0 w-full flex-1')}>
        {tabs.map((tab) => {
          const terminal = terminals.find((t) => t.id === tab.terminalId)
          if (!terminal?.ptyId) return null
          const isVisible = visibleTabId === tab.id
          return (
            <div
              key={tab.id}
              style={{
                ...tw(
                  isVisible
                    ? 'flex h-full w-full'
                    : 'absolute inset-0 invisible pointer-events-none flex h-full w-full'
                ),
                ...(isVisible ? { visibility: 'visible', pointerEvents: 'auto' } : {})
              }}
            >
              <ConnectedTerminal
                terminalId={terminal.ptyId}
                storeTerminalId={terminal.id}
                autoSpawn={false}
                spawnOptions={{
                  projectId: terminal.projectId,
                  shell: terminal.shell,
                  cwd: terminal.cwd
                }}
                onBoundToStoreTerminal={(ptyId) => {
                  if (terminal.ptyId !== ptyId) setTerminalPtyId(terminal.id, ptyId)
                }}
                initialScrollback={terminal.pendingScrollback}
                initialModes={terminal.pendingModes}
                className="w-full h-full"
                isVisible={isVisible}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** ProjectTreeHost: the tree stays mounted; a hidden one is invisible and unclickable. */
function ProjectHost({
  projectId,
  isActiveProject,
  box
}: {
  projectId: string
  isActiveProject: boolean
  box?: PaneBox
}) {
  const paneIds = useWorkspaceStore(
    useShallow((state) =>
      getAllLeafPanes(selectProjectTree(state, projectId).root).map((p) => p.id)
    )
  )
  useLayoutEffect(() => {
    if (!isActiveProject || switchStarted?.projectId !== projectId) return
    lastSwitch = {
      projectId,
      activateMs: null,
      commitMs: performance.now() - switchStarted.at,
      frameMs: null
    }
  }, [isActiveProject, projectId])
  return (
    <ProjectPaneContext.Provider value={{ projectId, isActiveProject }}>
      <div
        style={{
          ...tw(
            isActiveProject
              ? 'flex h-full w-full'
              : 'absolute inset-0 invisible pointer-events-none flex'
          ),
          // GPUIX keeps a style key a later render drops, so the visible state spells both out.
          ...(isActiveProject ? { visibility: 'visible', pointerEvents: 'auto' } : {})
        }}
      >
        {paneIds.map((paneId) => (
          <TerminalPane key={paneId} paneId={paneId} projectId={projectId} box={box} />
        ))}
      </div>
    </ProjectPaneContext.Provider>
  )
}

function useMountedProjects(): string[] {
  const active = useWorkspaceStore((state) => state.activeProjectId)
  const parked = useWorkspaceStore(useShallow((state) => Object.keys(state.parkedTrees)))
  const order = useRef<string[]>([])
  const live = [active, ...parked].filter(Boolean)
  const next = order.current.filter((id) => live.includes(id))
  for (const id of live) if (!next.includes(id)) next.push(id)
  order.current = next
  return next
}

function activate(projectId: string): void {
  useProjectStore.getState().selectProject(projectId)
  useWorkspaceStore.getState().activateProject(projectId)
}

function publish(renderer: NativeRenderer, seq: number): void {
  const started = performance.now()
  // The automation tree walk is the expensive part (tens of ms); refresh the
  // testId -> element map only when a terminal is missing from it.
  const ids = useTerminalStore.getState().terminals.map((t) => `terminal-${t.id}`)
  if (ids.some((testId) => !hostIds.has(testId)) && Date.now() - lastTreeWalk > 3000) {
    lastTreeWalk = Date.now()
    const tree = (
      'getAutomationTree' in renderer && typeof renderer.getAutomationTree === 'function'
        ? JSON.parse(renderer.getAutomationTree())
        : {}
    ) as TreeNode
    hostIds.clear()
    for (const testId of ids) {
      const node = findTestId(tree, testId)
      if (node) hostIds.set(testId, node.id)
    }
  }
  const terminals = useTerminalStore.getState().terminals.map((t) => {
    const screen = t.ptyId ? screenOf(getTerminal(t.ptyId)) : undefined
    if (screen && t.ptyId) {
      if (!screenIds.has(screen)) screenIds.set(screen, nextScreenId++)
      const seen = screensSeen.get(t.id) ?? new Set<number>()
      seen.add(screenIds.get(screen)!)
      screensSeen.set(t.id, seen)
    }
    const hostId = hostIds.get(`terminal-${t.id}`)
    const bounds = hostId !== undefined ? renderer.getElementBounds?.(hostId) : null
    if (hostId !== undefined && !bounds) hostIds.delete(`terminal-${t.id}`)
    const cell = screen?.cellSize
    return {
      storeId: t.id,
      ptyId: t.ptyId ?? null,
      projectId: t.projectId,
      cols: screen?.cols ?? 0,
      rows: screen?.rows ?? 0,
      visibleText: screen?.visibleText() ?? [],
      selection: screen?.selectedText() ?? '',
      grid:
        bounds && cell
          ? { x: bounds.x, y: bounds.y, cellWidth: cell.width, cellHeight: cell.height }
          : null
    }
  })
  const state: PaneSceneState = {
    seq,
    activeProjectId: useWorkspaceStore.getState().activeProjectId,
    terminals,
    screensBuilt: Object.fromEntries([...screensSeen].map(([id, seen]) => [id, seen.size])),
    lastSwitch,
    lastPing,
    publishMs,
    hit: lastHit
  }
  io.write(stateFileRef.current, JSON.stringify(state))
  publishMs = performance.now() - started
}

interface TreeNode {
  id: number
  testId?: string
  children?: TreeNode[]
}

function findTestId(node: TreeNode, testId: string): TreeNode | null {
  if (node.testId === testId) return node
  for (const child of node.children ?? []) {
    const hit = findTestId(child, testId)
    if (hit) return hit
  }
  return null
}

const stateFileRef = { current: '' }
const hostIds = new Map<string, number>()
let lastTreeWalk = 0

function Scene({
  options,
  renderer
}: {
  options: PaneSceneOptions<NativeRenderer>
  renderer: NativeRenderer | null
}) {
  useProjectRegistry()
  useTerminalDetachedOutput()
  const mounted = useMountedProjects()
  const active = useWorkspaceStore((state) => state.activeProjectId)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!renderer) return
    stateFileRef.current = options.stateFile
    let last = 0
    let frames = renderer.getDebugFrameOverlayStats?.().frames ?? 0
    const framePoll = setInterval(() => {
      const now = renderer.getDebugFrameOverlayStats?.().frames ?? 0
      if (now !== frames && lastPing && lastPing.frameMs === null && pingStarted !== null) {
        lastPing = { ...lastPing, frameMs: performance.now() - pingStarted }
        pingStarted = null
      }
      if (now !== frames && lastSwitch && lastSwitch.frameMs === null && switchStarted)
        lastSwitch = { ...lastSwitch, frameMs: performance.now() - switchStarted.at }
      if (lastSwitch?.frameMs != null) switchStarted = null
      frames = now
    }, 1)
    const timer = setInterval(() => {
      const command = io.read(options.control)
      if (command && command.seq > last) {
        last = command.seq
        log.info('terminal-scene', `command ${JSON.stringify(command)}`)
        if ('open' in command) {
          activate(command.open.projectId)
          const paneId = useWorkspaceStore.getState().activePaneId
          void spawnTerminalInPane(paneId, command.open.projectId, command.open.cwd).then(
            (result) => {
              if (!result.success) log.warn('terminal-scene', `open failed: ${result.error}`)
            }
          )
        } else if ('switchTo' in command) {
          switchStarted = { projectId: command.switchTo, at: performance.now() }
          lastSwitch = null
          activate(command.switchTo)
          const activateMs = performance.now() - switchStarted.at
          const committed = lastSwitch as PaneSceneState['lastSwitch']
          if (committed) lastSwitch = { ...committed, activateMs }
        } else if ('ping' in command) {
          pingStarted = performance.now()
          lastPing = null
          setPing?.(command.seq)
        } else if ('hit' in command) {
          const tree = (
            'getAutomationTree' in renderer && typeof renderer.getAutomationTree === 'function'
              ? JSON.parse(renderer.getAutomationTree())
              : {}
          ) as TreeNode
          const byId = new Map<number, TreeNode & { type?: string }>()
          const walk = (node: TreeNode) => {
            byId.set(node.id, node)
            for (const child of node.children ?? []) walk(child)
          }
          walk(tree)
          lastHit = (renderer.getElementsAt?.(command.hit.x, command.hit.y) ?? []).map(
            (elementId) => {
              const node = byId.get(elementId) as (TreeNode & { type?: string }) | undefined
              const firstTestId = (n: TreeNode | undefined): string => {
                if (!n) return ''
                if (n.testId) return n.testId
                for (const c of n.children ?? []) {
                  const t = firstTestId(c)
                  if (t) return t
                }
                return ''
              }
              const keys = node
                ? Object.keys(node)
                    .filter((k) => k !== 'children')
                    .join(',')
                : ''
              return `${elementId}:${node?.type ?? '?'}:${node?.testId ?? ''}:kids=${node?.children?.length ?? 0}:first=${firstTestId(node)}:${keys}`
            }
          )
        } else {
          setGeneration((g) => g + 1)
        }
      }
      publish(renderer, last)
    }, 100)
    return () => {
      clearInterval(timer)
      clearInterval(framePoll)
    }
  }, [renderer, options])

  return (
    <div
      style={{
        ...tw('bg-background'),
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        display: 'flex'
      }}
    >
      <Ping />
      {mounted.map((projectId) => (
        <ProjectHost
          key={`${projectId}-${generation}`}
          projectId={projectId}
          isActiveProject={projectId === active}
          box={options.box}
        />
      ))}
    </div>
  )
}

function SceneRoot({ options }: { options: PaneSceneOptions<NativeRenderer> }) {
  const [renderer, setRenderer] = useState<NativeRenderer | null>(null)
  const onRenderer = useCallback(
    (r: NativeRenderer) => {
      options.onRenderer(r)
      setRenderer(r)
    },
    [options]
  )
  return (
    <CompatRoot onRenderer={onRenderer}>
      <Scene options={options} renderer={renderer} />
    </CompatRoot>
  )
}

export function boot(config: ClientConfig, options: PaneSceneOptions<NativeRenderer>): void {
  if (config.token) setWebAuthToken(config.token)
  ensureClientIdentity()
  checkWebAuthGate()
  render(<SceneRoot options={options} />, {
    title: 'Termul terminal pane',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focus: false,
    ...compatRenderOptions
  })
}
