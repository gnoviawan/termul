// Context bar visibility settings
export interface ContextBarSettings {
  showGitBranch: boolean
  showGitStatus: boolean
  showWorkingDirectory: boolean
  showExitCode: boolean
}

// Default settings with all elements visible
export const DEFAULT_CONTEXT_BAR_SETTINGS: ContextBarSettings = {
  showGitBranch: true,
  showGitStatus: true,
  showWorkingDirectory: true,
  showExitCode: true
}

// Persistence key for context bar settings
export const CONTEXT_BAR_SETTINGS_KEY = 'settings/context-bar'

// Application-wide settings
export interface AppSettings {
  terminalFontFamily: string
  terminalFontSize: number
  terminalBufferSize: number // Scrollback buffer size in lines
  defaultShell: string
  defaultProjectColor: string // Default color for new projects (from PROJECT_COLORS)
  maxTerminalsPerProject: number // Maximum terminals allowed per project
  orphanDetectionEnabled: boolean // Enable automatic cleanup of inactive terminals
  orphanDetectionTimeout: number | null // Timeout in ms, null = disabled
}

// Terminal buffer size options
export const BUFFER_SIZE_OPTIONS = [
  { value: 1000, label: '1,000 lines' },
  { value: 5000, label: '5,000 lines' },
  { value: 10000, label: '10,000 lines' },
  { value: 25000, label: '25,000 lines' },
  { value: 50000, label: '50,000 lines' }
]

// Font family options for terminal
export const FONT_FAMILY_OPTIONS = [
  { value: 'Menlo, Monaco, "Courier New", monospace', label: 'Menlo' },
  { value: 'Monaco, Menlo, "Courier New", monospace', label: 'Monaco' },
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' },
  { value: '"Courier New", Courier, monospace', label: 'Courier New' },
  { value: '"Source Code Pro", Menlo, monospace', label: 'Source Code Pro' },
  { value: '"JetBrains Mono", Menlo, monospace', label: 'JetBrains Mono' },
  { value: '"Fira Code", Menlo, monospace', label: 'Fira Code' }
]

// Max terminals per project options
export const MAX_TERMINALS_OPTIONS = [
  { value: 5, label: '5 terminals' },
  { value: 10, label: '10 terminals' },
  { value: 15, label: '15 terminals' },
  { value: 20, label: '20 terminals' },
  { value: 50, label: '50 terminals' }
]

// Orphan detection timeout options
export const ORPHAN_TIMEOUT_OPTIONS = [
  { value: 60000, label: '1 minute' },
  { value: 300000, label: '5 minutes' },
  { value: 600000, label: '10 minutes' },
  { value: 1800000, label: '30 minutes' },
  { value: 3600000, label: '1 hour' }
]

// Default application settings
export const DEFAULT_APP_SETTINGS: AppSettings = {
  terminalFontFamily: 'Menlo, Monaco, "Courier New", monospace',
  terminalFontSize: 14,
  terminalBufferSize: 10000,
  defaultShell: '',
  defaultProjectColor: 'blue',
  maxTerminalsPerProject: 10,
  orphanDetectionEnabled: true,
  orphanDetectionTimeout: 600000 // 10 minutes
}

// Persistence key for app settings
export const APP_SETTINGS_KEY = 'settings/app'

// Keyboard shortcut definition
export interface KeyboardShortcut {
  id: string
  label: string
  description: string
  defaultKey: string // Normalized format: "ctrl+k", "ctrl+shift+p"
  customKey?: string // User's custom binding, undefined = use default
}

// All keyboard shortcuts configuration
export type KeyboardShortcutsConfig = Record<string, KeyboardShortcut>

// Default keyboard shortcuts matching current WorkspaceDashboard handlers
export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutsConfig = {
  commandPalette: {
    id: 'commandPalette',
    label: 'Command Palette',
    description: 'Open the command palette for quick actions',
    defaultKey: 'ctrl+k'
  },
  commandPaletteAlt: {
    id: 'commandPaletteAlt',
    label: 'Command Palette (Alt)',
    description: 'Open command palette (VS Code style)',
    defaultKey: 'ctrl+shift+p'
  },
  terminalSearch: {
    id: 'terminalSearch',
    label: 'Terminal Search',
    description: 'Search within terminal output',
    defaultKey: 'ctrl+f'
  },
  commandHistory: {
    id: 'commandHistory',
    label: 'Command History',
    description: 'Search command history',
    defaultKey: 'ctrl+r'
  },
  newProject: {
    id: 'newProject',
    label: 'New Project',
    description: 'Create a new project',
    defaultKey: 'ctrl+n'
  },
  newTerminal: {
    id: 'newTerminal',
    label: 'New Terminal',
    description: 'Create a new terminal',
    defaultKey: 'ctrl+t'
  },
  nextTerminal: {
    id: 'nextTerminal',
    label: 'Next Tab',
    description: 'Switch to next tab (terminal or editor)',
    defaultKey: 'ctrl+tab'
  },
  prevTerminal: {
    id: 'prevTerminal',
    label: 'Previous Tab',
    description: 'Switch to previous tab (terminal or editor)',
    defaultKey: 'ctrl+shift+tab'
  },
  zoomIn: {
    id: 'zoomIn',
    label: 'Zoom In',
    description: 'Increase terminal font size',
    defaultKey: 'ctrl+='
  },
  zoomOut: {
    id: 'zoomOut',
    label: 'Zoom Out',
    description: 'Decrease terminal font size',
    defaultKey: 'ctrl+-'
  },
  zoomReset: {
    id: 'zoomReset',
    label: 'Reset Zoom',
    description: 'Reset terminal font size to default',
    defaultKey: 'ctrl+0'
  }
}

// Persistence key for keyboard shortcuts
export const KEYBOARD_SHORTCUTS_KEY = 'settings/keyboard-shortcuts'
