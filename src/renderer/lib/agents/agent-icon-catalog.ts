/**
 * Bundled icon catalog for the custom-agent icon picker.
 *
 * All icons are offline SVG with `currentColor` so the picker can tint them
 * via CSS. Includes built-in agent logos plus generic category icons.
 */

import claudeCodeIcon from '@/assets/agent-icons/claude-code.svg?raw'
import codexIcon from '@/assets/agent-icons/codex.svg?raw'
import cursorIcon from '@/assets/agent-icons/cursor.svg?raw'
import geminiIcon from '@/assets/agent-icons/gemini-cli.svg?raw'
import opencodeIcon from '@/assets/agent-icons/opencode.svg?raw'
import piIcon from '@/assets/agent-icons/pi.svg?raw'
import terminalIcon from '@/assets/agent-icons/terminal.svg?raw'
import devIcon from '@/assets/agent-icons/dev.svg?raw'
import robotIcon from '@/assets/agent-icons/robot.svg?raw'
import sparklesIcon from '@/assets/agent-icons/sparkles.svg?raw'
import codeIcon from '@/assets/agent-icons/code.svg?raw'
import brainIcon from '@/assets/agent-icons/brain.svg?raw'
import zapIcon from '@/assets/agent-icons/zap.svg?raw'

export interface BundledIconEntry {
	key: string
	label: string
	svg: string
	/** Tailwind text-color class applied in the picker grid. */
	pickerColor: string
}

/** Normalize SVG for inline rendering: strip fixed width/height. */
export function normalizeIconSvg(svg: string): string {
	return svg.replace(/\s+width="[^"]*"/g, '').replace(/\s+height="[^"]*"/g, '')
}

/**
 * All bundled icons available in the picker — fully offline, no network fetch.
 */
export const BUNDLED_ICON_CATALOG: readonly BundledIconEntry[] = [
	{ key: 'claude-code', label: 'Claude Code', svg: claudeCodeIcon as string, pickerColor: 'text-orange-400' },
	{ key: 'codex', label: 'Codex', svg: codexIcon as string, pickerColor: 'text-emerald-400' },
	{ key: 'cursor', label: 'Cursor', svg: cursorIcon as string, pickerColor: 'text-sky-400' },
	{ key: 'gemini-cli', label: 'Gemini', svg: geminiIcon as string, pickerColor: 'text-blue-400' },
	{ key: 'opencode', label: 'OpenCode', svg: opencodeIcon as string, pickerColor: 'text-violet-400' },
	{ key: 'pi', label: 'pi', svg: piIcon as string, pickerColor: 'text-amber-400' },
	{ key: 'terminal', label: 'Terminal', svg: terminalIcon as string, pickerColor: 'text-green-400' },
	{ key: 'dev', label: 'Developer', svg: devIcon as string, pickerColor: 'text-cyan-400' },
	{ key: 'robot', label: 'Robot', svg: robotIcon as string, pickerColor: 'text-indigo-400' },
	{ key: 'sparkles', label: 'Sparkles', svg: sparklesIcon as string, pickerColor: 'text-yellow-400' },
	{ key: 'code', label: 'Code', svg: codeIcon as string, pickerColor: 'text-teal-400' },
	{ key: 'brain', label: 'Brain', svg: brainIcon as string, pickerColor: 'text-pink-400' },
	{ key: 'zap', label: 'Zap', svg: zapIcon as string, pickerColor: 'text-amber-300' },
] as const

/** Look up a bundled icon entry by its stored SVG content. */
export function findBundledIconBySvg(svg: string): BundledIconEntry | undefined {
	if (!svg) return undefined
	return BUNDLED_ICON_CATALOG.find((entry) => entry.svg === svg)
}
