/**
 * ADR-004.3 / ADR-004.6: Custom (user-defined) terminal-native agents.
 *
 * Users can add their own agents: pick an existing registry logo + name for
 * identity (ADR-004.6 discovery), then set their own `command` / `promptMode`.
 * Custom agents are persisted via `persistenceApi` and merged with the built-in
 * launch table. This is a thin store; the launch path treats custom and built-in
 * definitions identically (both produce argv via `buildAgentArgv`).
 */

import { persistenceApi } from '@/lib/api'
import { PersistenceKeys } from '@shared/types/persistence.types'
import {
	BUILT_IN_AGENTS,
	type AgentPromptMode,
	type TerminalAgentDefinition,
} from '@/lib/agents/agent-registry'

const VALID_PROMPT_MODES: readonly AgentPromptMode[] = ['positional', 'flag', 'none']

export interface CustomAgentInput {
	name: string
	command: string
	promptMode: AgentPromptMode
	promptFlag?: string
	baseArgs?: string[]
	env?: Record<string, string>
	icon?: string
	/** Optional ACP Registry id whose logo/name this agent borrows. */
	registryId?: string
	/** Stable id; generated when omitted. */
	id?: string
}

interface PersistedCustomAgents {
	agents: TerminalAgentDefinition[]
}

/** Validate a custom-agent input, returning an error string or null when valid. */
export function validateCustomAgent(input: CustomAgentInput): string | null {
	if (!input.name || input.name.trim().length === 0) {
		return 'Agent name is required'
	}
	if (!input.command || input.command.trim().length === 0) {
		return 'Agent command is required'
	}
	if (!VALID_PROMPT_MODES.includes(input.promptMode)) {
		return `Invalid prompt mode: ${input.promptMode}`
	}
	if (input.promptMode === 'flag' && (!input.promptFlag || input.promptFlag.trim().length === 0)) {
		return "Prompt flag is required when prompt mode is 'flag'"
	}
	return null
}

/** Normalize a validated input into a stored `TerminalAgentDefinition`. */
export function toAgentDefinition(input: CustomAgentInput): TerminalAgentDefinition {
	return {
		id: input.id ?? `custom-${crypto.randomUUID().slice(0, 8)}`,
		name: input.name.trim(),
		command: input.command.trim(),
		baseArgs: input.baseArgs ?? [],
		promptMode: input.promptMode,
		promptFlag: input.promptMode === 'flag' ? input.promptFlag?.trim() : undefined,
		env: input.env,
		icon: input.icon,
		registryId: input.registryId,
		isBuiltIn: false,
	}
}

/** Load persisted custom agents (empty when none / on first run). */
export async function loadCustomAgents(): Promise<TerminalAgentDefinition[]> {
	const result = await persistenceApi.read<PersistedCustomAgents>(PersistenceKeys.customAgents)
	if (result.success && Array.isArray(result.data?.agents)) {
		// Defensive: force isBuiltIn:false on load so a tampered file can't shadow built-ins.
		return result.data.agents.map((a) => ({ ...a, isBuiltIn: false }))
	}
	return []
}

async function saveCustomAgents(agents: TerminalAgentDefinition[]): Promise<void> {
	const payload: PersistedCustomAgents = { agents }
	const result = await persistenceApi.write(PersistenceKeys.customAgents, payload)
	if (!result.success) {
		throw new Error(result.error || 'Failed to save custom agents')
	}
}

/**
 * Add or update a custom agent. Validates input, then upserts by id. Returns the
 * stored definition. Throws on validation failure or persistence error.
 */
export async function upsertCustomAgent(
	input: CustomAgentInput,
): Promise<TerminalAgentDefinition> {
	const error = validateCustomAgent(input)
	if (error) {
		throw new Error(error)
	}
	const def = toAgentDefinition(input)
	const existing = await loadCustomAgents()
	const next = existing.filter((a) => a.id !== def.id)
	next.push(def)
	await saveCustomAgents(next)
	return def
}

/** Delete a custom agent by id. No-op for unknown / built-in ids. */
export async function deleteCustomAgent(id: string): Promise<void> {
	const existing = await loadCustomAgents()
	const next = existing.filter((a) => a.id !== id)
	if (next.length !== existing.length) {
		await saveCustomAgents(next)
	}
}

/**
 * Merge built-in and custom agents into a single launch list. Built-ins come
 * first; a custom agent sharing a built-in id is ignored (built-ins win) so the
 * validated launch conventions can't be silently overridden by a stored file.
 */
export function mergeAgents(
	custom: readonly TerminalAgentDefinition[],
): TerminalAgentDefinition[] {
	const builtInIds = new Set(BUILT_IN_AGENTS.map((a) => a.id))
	const safeCustom = custom.filter((a) => !builtInIds.has(a.id))
	return [...BUILT_IN_AGENTS, ...safeCustom]
}

/** Convenience: load custom agents and return the merged launch list. */
export async function loadAllAgents(): Promise<TerminalAgentDefinition[]> {
	const custom = await loadCustomAgents()
	return mergeAgents(custom)
}
