/**
 * Bundled icon catalog for the custom-agent icon picker.
 *
 * All icons are offline SVG using `currentColor`, sourced from:
 * 1. ACP Registry (acp/*.svg, managed by scripts/sync-acp-icons.mjs)
 * 2. Generic category icons (terminal, dev, robot, sparkles, code, brain, zap)
 *
 * All picker icons render as white via `text-white` on `bg-muted` cells.
 */

import acpManifest from '@/assets/agent-icons/acp/manifest.json'
import brainIcon from '@/assets/agent-icons/brain.svg?raw'
import codeIcon from '@/assets/agent-icons/code.svg?raw'
import devIcon from '@/assets/agent-icons/dev.svg?raw'
import robotIcon from '@/assets/agent-icons/robot.svg?raw'
import sparklesIcon from '@/assets/agent-icons/sparkles.svg?raw'
// Generic icons — hand-bundled category symbols
import terminalIcon from '@/assets/agent-icons/terminal.svg?raw'
import zapIcon from '@/assets/agent-icons/zap.svg?raw'

// ACP icons — loaded via Vite's import.meta.glob
const acpSvgModules = import.meta.glob<string>('@/assets/agent-icons/acp/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default'
})

export interface BundledIconEntry {
  key: string
  label: string
  svg: string
}

export { normalizeRootIconSvg as normalizeIconSvg } from '@/lib/agents/sanitize-agent-icon'

/**
 * Build ACP icon entries from manifest + glob-loaded SVG modules.
 * The manifest provides id + name; the glob provides the raw SVG content.
 */
function buildAcpEntries(): BundledIconEntry[] {
  const entries: BundledIconEntry[] = []
  for (const entry of acpManifest as Array<{ id: string; name: string; file: string }>) {
    // Match the glob key pattern to find the loaded SVG module.
    // import.meta.glob keys are like /src/renderer/assets/agent-icons/acp/claude-acp.svg
    const moduleKey = Object.keys(acpSvgModules).find((k) => k.endsWith(`/acp/${entry.file}`))
    if (moduleKey) {
      const svg = acpSvgModules[moduleKey] as string
      if (svg) {
        entries.push({ key: `acp:${entry.id}`, label: entry.name, svg })
      }
    }
  }
  return entries
}

const GENERIC_ICONS: readonly BundledIconEntry[] = [
  { key: 'generic:terminal', label: 'Terminal', svg: terminalIcon as string },
  { key: 'generic:dev', label: 'Developer', svg: devIcon as string },
  { key: 'generic:robot', label: 'Robot', svg: robotIcon as string },
  { key: 'generic:sparkles', label: 'Sparkles', svg: sparklesIcon as string },
  { key: 'generic:code', label: 'Code', svg: codeIcon as string },
  { key: 'generic:brain', label: 'Brain', svg: brainIcon as string },
  { key: 'generic:zap', label: 'Zap', svg: zapIcon as string }
] as const

/**
 * All bundled icons available in the picker — fully offline, no network fetch.
 * ACP registry icons first, then generic category icons.
 */
export const BUNDLED_ICON_CATALOG: readonly BundledIconEntry[] = [
  ...buildAcpEntries(),
  ...GENERIC_ICONS
]

/** Look up a bundled icon entry by its stored SVG content. */
export function findBundledIconBySvg(svg: string): BundledIconEntry | undefined {
  if (!svg) return undefined
  return BUNDLED_ICON_CATALOG.find((entry) => entry.svg === svg)
}

/** Look up a bundled icon entry by its catalog key (e.g. `acp:gemini`). */
export function findBundledIconByKey(key: string): BundledIconEntry | undefined {
  if (!key) return undefined
  return BUNDLED_ICON_CATALOG.find((entry) => entry.key === key)
}
