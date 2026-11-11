/**
 * Troupe's own agent tools that the composer can point the agent at. Each
 * entry becomes a "tool" pill; on the wire the pill reads as a plain-language
 * request naming the tool and the `troupe` MCP server, so any ACP agent can
 * act on it (no agent-specific tool ids such as `mcp__troupe__browser`).
 *
 * The host serves these tools from its `troupe` MCP server
 * (`src-tauri/src/acp/host_mcp/child.rs`): the browser tool, the canvas
 * tools and the automation tools.
 */

/** The MCP server name the host registers for its own tools. */
const HOST_MCP_SERVER = 'troupe'

/** The server name 0.4.x hosts registered; persisted prompts still carry it. */
const LEGACY_MCP_SERVER = 'termul'

export type TermulToolId = 'browser' | 'canvas' | 'automations'

/**
 * `closed`: the agent can call the tool, but it fails until the user opens
 * the thing it drives. The pill still inserts; the menu says so.
 */
export type TermulToolState = 'available' | 'closed'

export interface TermulToolContext {
  /** The project's canvas is mounted and ready (`CANVAS_CLOSED` otherwise). */
  canvasReady: boolean
}

export interface TermulToolEntry {
  id: TermulToolId
  /** Pill and menu label. */
  label: string
  /** Muted line under the label in the menus. */
  description: string
  /** What the agent reads in place of the pill. */
  wireText: string
  /** The wire text a 0.4.x host sent, restored to the pill when old history reopens. */
  legacyWireText: string
  state: (context: TermulToolContext) => TermulToolState
}

function frame(tools: string, server: string): string {
  return `(Use ${tools} from the ${server} MCP server)`
}

function wire(tools: string): Pick<TermulToolEntry, 'wireText' | 'legacyWireText'> {
  return {
    wireText: frame(tools, HOST_MCP_SERVER),
    legacyWireText: frame(tools, LEGACY_MCP_SERVER)
  }
}

const always = (): TermulToolState => 'available'

export const TERMUL_TOOLS: readonly TermulToolEntry[] = [
  {
    id: 'browser',
    label: 'Browser',
    description: 'Open, click and read pages',
    ...wire('the browser tool'),
    // The host lists the tool on every surface; with no browser host (the
    // standalone server) a call fails with a clear reason.
    state: always
  },
  {
    id: 'canvas',
    label: 'Canvas',
    description: 'Design on the project canvas',
    ...wire('the canvas tools'),
    state: ({ canvasReady }) => (canvasReady ? 'available' : 'closed')
  },
  {
    id: 'automations',
    label: 'Automations',
    description: 'Schedule background work',
    ...wire('the automation tools'),
    state: always
  }
]

export function termulTool(id: string): TermulToolEntry | undefined {
  return TERMUL_TOOLS.find((tool) => tool.id === id)
}
