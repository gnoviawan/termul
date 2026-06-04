/**
 * Terminal Profile - Saved terminal configuration preset
 * Allows users to create reusable terminal configurations
 */
export interface TerminalProfile {
  id: string
  name: string
  shell?: string
  cwd?: string
  env?: Record<string, string>
  args?: string[]
  font?: {
    family?: string
    size?: number
  }
  createdAt: number
  updatedAt: number
}

export const TERMINAL_PROFILES_KEY = 'settings/terminal-profiles'

export const DEFAULT_TERMINAL_PROFILES: TerminalProfile[] = []
