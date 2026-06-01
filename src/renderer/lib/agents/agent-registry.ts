/**
 * ADR-004.3: Agent Registry — per-agent launch metadata for the
 * terminal-native CLI agent launcher.
 *
 * Each agent has a different "interactive TUI + seed prompt" invocation
 * (`claude "P"`, `codex "P"`, `gemini -i "P"`, `opencode --prompt "P"`). This is
 * APP-OWNED launch metadata that the ACP Registry does not provide — the ACP
 * Registry only publishes the agent's ACP-server invocation (JSON-RPC over
 * stdio), which would dump raw JSON-RPC into the terminal if launched. See
 * ADR-004.6: `registryId` links a built-in to its ACP Registry entry purely for
 * identity reuse (icon, display name, description); it is NEVER used to derive
 * the launch command. The `command`/`baseArgs`/`promptMode` fields here are
 * authoritative for the TUI route.
 */

/**
 * How the user's prompt is supplied to the agent's argv.
 *  - 'positional': prompt is appended as the final argv element
 *  - 'flag':       prompt follows `promptFlag` (e.g. `['-i', prompt]`)
 *  - 'none':       agent launched with no seed prompt (prompt ignored; the user
 *                  types it after the TUI boots)
 */
export type AgentPromptMode = 'positional' | 'flag' | 'none'

export interface TerminalAgentDefinition {
	/** Stable launch-table id, e.g. 'claude-code'. */
	id: string
	/** Display name, e.g. 'Claude Code'. */
	name: string
	/** Resolvable binary name or absolute path, e.g. 'claude'. */
	command: string
	/** Static args always prepended before the prompt (e.g. gemini's '-i'). */
	baseArgs: string[]
	/** How the user's prompt is supplied to the agent. */
	promptMode: AgentPromptMode
	/** Required when `promptMode === 'flag'`; the flag the prompt follows. */
	promptFlag?: string
	/**
	 * Optional env requirements. Values may reference an existing env var with a
	 * leading `$` (e.g. `{ ANTHROPIC_API_KEY: '$ANTHROPIC_API_KEY' }`), resolved
	 * at launch time against the process/project env.
	 */
	env?: Record<string, string>
	/** Resolved icon path (bundled asset or cached registry SVG). */
	icon?: string
	/** Optional link to an ACP Registry entry for identity reuse (ADR-004.6). */
	registryId?: string
	/** True for app-shipped definitions; false for user-defined agents. */
	isBuiltIn: boolean
}

/**
 * Pure builder: turn a definition + prompt into a `{ program, args }` pair.
 *
 * No side effects, trivially unit-testable. The prompt is returned as a discrete
 * argv element — it is the caller's contract (and the Rust spawn path's) to pass
 * `args` without shell interpolation. A blank/whitespace-only prompt is treated
 * as "no prompt" so the agent simply boots its TUI.
 */
export function buildAgentArgv(
	def: TerminalAgentDefinition,
	prompt: string | undefined,
): { program: string; args: string[] } {
	const args = [...def.baseArgs]
	const hasPrompt = typeof prompt === 'string' && prompt.trim().length > 0

	if (hasPrompt && def.promptMode === 'positional') {
		args.push(prompt as string)
	} else if (hasPrompt && def.promptMode === 'flag' && def.promptFlag) {
		args.push(def.promptFlag, prompt as string)
	}

	return { program: def.command, args }
}

/**
 * Built-in agent definitions, seeded from the validated CLI conventions in
 * ADR-004. These are the INTERACTIVE TUI invocations, deliberately distinct from
 * each agent's ACP-server invocation.
 *
 * Notes captured from the ADR's validation table:
 *  - Claude Code / Codex / Cursor use a positional prompt.
 *  - Gemini uses `-i/--prompt-interactive` (NOT `-p`, which is non-interactive).
 *  - OpenCode's positional arg is a PROJECT PATH, so the prompt must use
 *    `--prompt`.
 *  - pi ships `promptMode: 'none'` until its interactive seed-prompt flag is
 *    verified; it boots the TUI and the user types the prompt after.
 */
export const BUILT_IN_AGENTS: readonly TerminalAgentDefinition[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		baseArgs: [],
		promptMode: 'positional',
		registryId: 'claude-acp',
		isBuiltIn: true,
	},
	{
		id: 'codex',
		name: 'Codex',
		command: 'codex',
		baseArgs: [],
		promptMode: 'positional',
		registryId: 'codex-acp',
		isBuiltIn: true,
	},
	{
		id: 'cursor',
		name: 'Cursor',
		command: 'cursor-agent',
		baseArgs: [],
		promptMode: 'positional',
		registryId: 'cursor',
		isBuiltIn: true,
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		command: 'gemini',
		baseArgs: [],
		promptMode: 'flag',
		promptFlag: '-i',
		registryId: 'gemini',
		isBuiltIn: true,
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		command: 'opencode',
		baseArgs: [],
		promptMode: 'flag',
		promptFlag: '--prompt',
		registryId: 'opencode',
		isBuiltIn: true,
	},
	{
		id: 'pi',
		name: 'pi',
		command: 'pi',
		baseArgs: [],
		// TODO(ADR-004.3): confirm pi's interactive seed-prompt invocation, then
		// flip to the correct mode. Until verified, launch the TUI without a seed
		// prompt so we never pass an unsupported flag.
		promptMode: 'none',
		registryId: 'pi-acp',
		isBuiltIn: true,
	},
] as const

/** Look up a built-in agent definition by its launch-table id. */
export function getBuiltInAgent(id: string): TerminalAgentDefinition | undefined {
	return BUILT_IN_AGENTS.find((a) => a.id === id)
}
