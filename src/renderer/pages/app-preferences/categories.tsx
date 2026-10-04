import {
  Bot,
  Download,
  FileText,
  Keyboard,
  Monitor,
  Network,
  Palette,
  RotateCcw,
  Sliders,
  Terminal
} from '@/components/icons'
import type { SettingsCategory } from '@/components/settings/SettingsLayout'
import type { SettingsSearchEntry } from '@/lib/settings-search'

export const APP_PREF_CATEGORIES: SettingsCategory[] = [
  { id: 'appearance', label: 'Terminal Appearance', icon: <Palette size={16} /> },
  { id: 'shell', label: 'Default Shell', icon: <Terminal size={16} /> },
  { id: 'behavior', label: 'Behavior', icon: <Sliders size={16} /> },
  { id: 'project-defaults', label: 'New Project Defaults', icon: <Monitor size={16} /> },
  { id: 'ai-agents', label: 'AI Agents', icon: <Bot size={16} /> },
  { id: 'mcp-servers', label: 'MCP Servers', icon: <Network size={16} /> },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: <Keyboard size={16} /> },
  { id: 'updates', label: 'Updates', icon: <Download size={16} /> },
  { id: 'diagnostics', label: 'Diagnostics & Logs', icon: <FileText size={16} /> },
  { id: 'reset', label: 'Reset Settings', icon: <RotateCcw size={16} /> }
]

export const APP_PREF_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    categoryId: 'appearance',
    label: 'Font Family',
    description: 'Choose a monospace font for terminal text.',
    keywords: ['typeface', 'monospace']
  },
  {
    categoryId: 'appearance',
    label: 'Font Size',
    description: 'Adjust terminal text size.',
    keywords: ['text size', 'zoom']
  },
  {
    categoryId: 'appearance',
    label: 'UI Zoom Level',
    description: 'Zoom the entire interface (50–300%).',
    keywords: ['ui zoom', 'zoom', 'interface scale', 'window zoom', 'magnify']
  },
  {
    categoryId: 'appearance',
    label: 'Scrollback Buffer Size',
    description: 'Number of lines to keep in terminal history.',
    keywords: ['history', 'lines', 'memory']
  },
  {
    categoryId: 'appearance',
    label: 'Max Terminals Per Project',
    description: 'Maximum number of terminal tabs allowed per project.',
    keywords: ['tabs', 'limit']
  },
  {
    categoryId: 'appearance',
    label: 'Terminal Renderer',
    description: 'GPU-accelerated rendering for terminal output.',
    keywords: ['webgl', 'dom', 'gpu']
  },
  {
    categoryId: 'shell',
    label: 'Default Shell',
    description: 'Set the default shell for new terminals.',
    keywords: ['bash', 'zsh', 'powershell', 'fish']
  },
  {
    categoryId: 'behavior',
    label: 'Open Terminal Links In',
    description: 'Choose how URLs from terminal output open.',
    keywords: ['url', 'links', 'browser']
  },
  {
    categoryId: 'behavior',
    label: 'Orphan Detection',
    description: 'Automatically clean up terminals that have been inactive.',
    keywords: ['cleanup', 'inactive', 'timeout']
  },
  {
    categoryId: 'behavior',
    label: 'Timeout Before Cleanup',
    description: 'Duration before inactive terminals are cleaned up.',
    keywords: ['orphan', 'inactive']
  },
  {
    categoryId: 'behavior',
    label: 'Auto Save',
    description: 'Automatically save editor files after you stop typing.',
    keywords: ['editor', 'autosave', 'auto save', 'save']
  },
  {
    categoryId: 'behavior',
    label: 'Auto Save Delay',
    description: 'Idle time before editor files are saved automatically.',
    keywords: ['editor', 'autosave', 'delay', 'timeout']
  },
  {
    categoryId: 'behavior',
    label: 'Notify when a terminal agent finishes',
    description: 'Ping when a long-running terminal tab goes quiet.',
    keywords: ['notification', 'terminal', 'idle', 'agent']
  },
  {
    categoryId: 'behavior',
    label: 'Notify when an agent chat turn finishes',
    description: 'Ping when an Agent Chat turn ends and nothing is queued.',
    keywords: ['notification', 'chat', 'finished', 'agent']
  },
  {
    categoryId: 'behavior',
    label: 'Notify when an agent chat needs you',
    description: 'Ping when an Agent Chat waits for approval or an answer.',
    keywords: ['notification', 'approval', 'permission', 'question']
  },
  {
    categoryId: 'project-defaults',
    label: 'Default Color',
    description: 'New projects will use this color by default.',
    keywords: ['theme', 'appearance']
  },
  {
    categoryId: 'ai-agents',
    label: 'AI Agents',
    description: 'View ACP agent availability and warm/auth status.',
    keywords: ['acp', 'agent', 'coding assistant']
  },
  {
    categoryId: 'ai-agents',
    label: 'Turn Timeout',
    description: 'Maximum wall-clock duration for a single agent turn (hard cap).',
    keywords: ['acp', 'timeout', 'turn', 'hard cap', 'unlimited', 'wedge']
  },
  {
    categoryId: 'mcp-servers',
    label: 'MCP Servers',
    description: 'Manage global stdio, HTTP, and SSE servers for new agent sessions.',
    keywords: ['mcp', 'model context protocol', 'stdio', 'http', 'sse']
  },
  {
    categoryId: 'shortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Customize keyboard shortcuts to match your workflow.',
    keywords: ['hotkeys', 'bindings', 'keybindings']
  },
  {
    categoryId: 'updates',
    label: 'Check for Updates',
    description: 'Manage application updates and version information.',
    keywords: ['version', 'upgrade']
  },
  {
    categoryId: 'updates',
    label: 'Auto-update',
    description: 'Automatically check for updates.',
    keywords: ['automatic', 'version']
  },
  {
    categoryId: 'updates',
    label: 'Release Channel',
    description: 'Choose Stable, Insider, or Nightly update track.',
    keywords: ['insider', 'nightly', 'stable', 'prerelease', 'beta', 'channel']
  },
  {
    categoryId: 'diagnostics',
    label: 'Diagnostics & Logs',
    description: 'Export or copy application logs to troubleshoot issues.',
    keywords: ['logs', 'export', 'troubleshoot', 'debug']
  },
  {
    categoryId: 'reset',
    label: 'Reset Settings',
    description: 'Restore all settings to their default values.',
    keywords: ['restore', 'defaults', 'clear']
  }
]
