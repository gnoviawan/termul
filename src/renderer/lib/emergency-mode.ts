/**
 * Emergency mode state and settings for power users.
 *
 * Provides hotfix mode that skips non-essential prompts
 * and expert workflow configurations.
 */

export interface EmergencyModeState {
	/** Whether emergency mode is currently active */
	isActive: boolean
	/** Timestamp when emergency mode was activated */
	activatedAt: number | null
	/** Reason for activation (e.g., "hotfix", "incident") */
	reason: string | null
}

export interface ExpertSettings {
	/** Skip all confirmation dialogs */
	skipConfirmations: boolean
	/** Auto-archive worktrees when closing terminal */
	autoArchiveOnClose: boolean
	/** Default branch naming pattern (e.g., "hotfix/") */
	defaultBranchPrefix: string
	/** Skip .gitignore selection (use defaults) */
	skipGitignoreSelection: boolean
	/** Use force flag by default for removals */
	defaultForceRemove: boolean
}

/** Default expert settings */
export const DEFAULT_EXPERT_SETTINGS: ExpertSettings = {
	skipConfirmations: false,
	autoArchiveOnClose: false,
	defaultBranchPrefix: 'feature/',
	skipGitignoreSelection: false,
	defaultForceRemove: false,
}

/** Emergency mode preset: hotfix settings */
export const HOTFIX_EXPERT_SETTINGS: ExpertSettings = {
	skipConfirmations: true,
	autoArchiveOnClose: false,
	defaultBranchPrefix: 'hotfix/',
	skipGitignoreSelection: true,
	defaultForceRemove: false,
}

/**
 * Create initial emergency mode state.
 */
export function createEmergencyModeState(): EmergencyModeState {
	return {
		isActive: false,
		activatedAt: null,
		reason: null,
	}
}

/**
 * Activate emergency mode.
 */
export function activateEmergencyMode(
	state: EmergencyModeState,
	reason: string,
): EmergencyModeState {
	return {
		isActive: true,
		activatedAt: Date.now(),
		reason,
	}
}

/**
 * Deactivate emergency mode.
 */
export function deactivateEmergencyMode(state: EmergencyModeState): EmergencyModeState {
	return {
		isActive: false,
		activatedAt: null,
		reason: null,
	}
}

/**
 * Get the appropriate expert settings based on emergency mode.
 */
export function getEffectiveSettings(
	baseSettings: ExpertSettings,
	emergencyMode: EmergencyModeState,
): ExpertSettings {
	if (emergencyMode.isActive) {
		return {
			...baseSettings,
			// Override certain settings in emergency mode
			skipConfirmations: true,
			skipGitignoreSelection: true,
			defaultBranchPrefix: 'hotfix/',
		}
	}
	return baseSettings
}

/**
 * Get the duration of emergency mode in minutes.
 */
export function getEmergencyModeDuration(state: EmergencyModeState): number | null {
	if (!state.isActive || !state.activatedAt) return null
	return Math.floor((Date.now() - state.activatedAt) / 60000)
}