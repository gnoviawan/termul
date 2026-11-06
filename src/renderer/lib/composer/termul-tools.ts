/**
 * Termul's own agent tools that the composer can point the agent at. Each
 * entry becomes a "tool" pill; on the wire the pill reads as a plain-language
 * request naming the tool and the `termul` MCP server, so any ACP agent can
 * act on it (no agent-specific tool ids such as `mcp__termul__browser`).
 *
 * The host serves these tools from its `termul` MCP server
 * (`src-tauri/src/acp/host_mcp/child.rs`): the browser tool, the canvas
 * tools and the automation tools.
 */

/** The MCP server name the host registers for its own tools. */
export const TERMUL_MCP_SERVER = 'termul'

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
  state: (context: TermulToolContext) => TermulToolState
}

function wireText(tools: string): string {
  return `(Use ${tools} from the ${TERMUL_MCP_SERVER} MCP server)`
}

const always = (): TermulToolState => 'available'

export const TERMUL_TOOLS: readonly TermulToolEntry[] = [
  {
    id: 'browser',
    label: 'Browser',
    description: 'Open, click and read pages',
    wireText: wireText('the browser tool'),
    // The host lists the tool on every surface; with no browser host (the
    // standalone server) a call fails with a clear reason.
    state: always
  },
  {
    id: 'canvas',
    label: 'Canvas',
    description: 'Design on the project canvas',
    wireText: wireText('the canvas tools'),
    state: ({ canvasReady }) => (canvasReady ? 'available' : 'closed')
  },
  {
    id: 'automations',
    label: 'Automations',
    description: 'Schedule background work',
    wireText: wireText('the automation tools'),
    state: always
  }
]

export function termulTool(id: string): TermulToolEntry | undefined {
  return TERMUL_TOOLS.find((tool) => tool.id === id)
}
