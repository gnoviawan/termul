import type { CSSProperties } from 'react'
/**
 * Bundled icon catalog for the custom-agent icon picker.
 *
 * All icons are offline SVG using `currentColor`, sourced from:
 * 1. ACP Registry (acp/*.svg, frozen bundled snapshot)
 * 2. Generic category icons (terminal, dev, robot, sparkles, code, brain, zap)
 *
 * All picker icons render as `text-foreground` on `bg-muted` cells.
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

/**
 * An agent's brand colour per appearance: `light` for light themes, `dark`
 * for dark ones (Termul Dark, Dracula). Each clears 3:1 against the panel.
 * Agents without one (monochrome marks, custom agents) use `currentColor`.
 */
export interface AgentBrandColor {
  light: string
  dark: string
  /**
   * Optional gradient fill (start and end stops per appearance, bottom-left
   * to top-right), e.g. Gemini's blue to purple. `light`/`dark` stay the
   * solid fallback. Every stop clears 3:1 too.
   */
  gradient?: { light: readonly [string, string]; dark: readonly [string, string] }
}

export interface BundledIconEntry {
  key: string
  label: string
  svg: string
  brandColor?: AgentBrandColor
}

export { normalizeRootIconSvg as normalizeIconSvg } from '@/lib/agents/sanitize-agent-icon'

/**
 * Build ACP icon entries from manifest + glob-loaded SVG modules.
 * The manifest provides id + name; the glob provides the raw SVG content.
 */
function buildAcpEntries(): BundledIconEntry[] {
  const entries: BundledIconEntry[] = []
  for (const entry of acpManifest as Array<{
    id: string
    name: string
    file: string
    brandColor?: AgentBrandColor
  }>) {
    // Match the glob key pattern to find the loaded SVG module.
    // import.meta.glob keys are like /src/renderer/assets/agent-icons/acp/claude-acp.svg
    const moduleKey = Object.keys(acpSvgModules).find((k) => k.endsWith(`/acp/${entry.file}`))
    if (moduleKey) {
      const svg = acpSvgModules[moduleKey] as string
      if (svg) {
        entries.push({
          key: `acp:${entry.id}`,
          label: entry.name,
          svg,
          ...(entry.brandColor ? { brandColor: entry.brandColor } : {})
        })
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

/**
 * The brand colour for a glyph. A persisted icon is coloured only when it IS
 * the bundled icon (an uploaded one keeps `currentColor`).
 */
export function agentBrandColor(
  icon: string | null | undefined,
  templateId: string | null | undefined
): AgentBrandColor | null {
  if (icon) return findBundledIconBySvg(icon)?.brandColor ?? null
  if (!templateId) return null
  return findBundledIconByKey(`acp:${templateId}`)?.brandColor ?? null
}

/**
 * Colours a glyph with its brand, per theme: the root `.dark` class (set by the
 * colour theme) picks `dark`, otherwise `light`. Merge `className` LAST with
 * `cn` so it replaces a caller's text colour. A gradient brand also fills the
 * icon's paths from the `<linearGradient>` that `withBrandGradient` adds.
 */
const BRAND_TEXT = 'text-(--agent-brand-light) [.dark_&]:text-(--agent-brand-dark)'
const BRAND_GRADIENT =
  '[--agent-brand-from:var(--agent-brand-from-light)] [--agent-brand-to:var(--agent-brand-to-light)] [.dark_&]:[--agent-brand-from:var(--agent-brand-from-dark)] [.dark_&]:[--agent-brand-to:var(--agent-brand-to-dark)] [&_path]:fill-(--agent-brand-fill)'

export function agentBrandProps(
  brand: AgentBrandColor,
  gradientId: string
): { className: string; style: CSSProperties } {
  const style: Record<string, string> = {
    '--agent-brand-light': brand.light,
    '--agent-brand-dark': brand.dark
  }
  if (!brand.gradient) return { className: BRAND_TEXT, style }
  const { light, dark } = brand.gradient
  Object.assign(style, {
    '--agent-brand-from-light': light[0],
    '--agent-brand-to-light': light[1],
    '--agent-brand-from-dark': dark[0],
    '--agent-brand-to-dark': dark[1],
    '--agent-brand-fill': `url(#${gradientId})`
  })
  return { className: `${BRAND_TEXT} ${BRAND_GRADIENT}`, style }
}

/** A DOM id usable inside `url(#…)`: React's `useId` output minus punctuation. */
export function brandGradientId(reactId: string): string {
  return `agent-brand-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

/**
 * Adds the brand gradient (`id` unique per glyph instance) to a sanitized
 * icon. Stops read the theme-picked colours set by `agentBrandProps`.
 */
export function withBrandGradient(svg: string, brand: AgentBrandColor | null, id: string): string {
  if (!brand?.gradient) return svg
  const defs =
    `<defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0">` +
    '<stop offset="0" style="stop-color:var(--agent-brand-from)"></stop>' +
    '<stop offset="1" style="stop-color:var(--agent-brand-to)"></stop>' +
    '</linearGradient></defs>'
  return svg.replace(/<svg\b[^>]*>/, (open) => `${open}${defs}`)
}
