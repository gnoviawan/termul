import {
  Bot,
  Download,
  FileText,
  Keyboard,
  KeyRound,
  Monitor,
  Network,
  Palette,
  RotateCcw,
  Sliders,
  Terminal
} from '@/components/icons'
import type { SettingsCategory } from '@/components/settings/SettingsLayout'
import type { SettingsSearchEntry } from '@/lib/settings-search'
import { isTauriContext } from '@/lib/tauri-runtime'

// The whole "Updates" category is desktop-only (issue #843): the web client
// updates with the server, so the updater entry points are hidden there.
const ALL_APP_PREF_CATEGORIES: SettingsCategory[] = [
  { id: 'appearance', label: 'Terminal Appearance', icon: <Palette size={16} /> },
  { id: 'shell', label: 'Default Shell', icon: <Terminal size={16} /> },
  { id: 'behavior', label: 'Behavior', icon: <Sliders size={16} /> },
  { id: 'project-defaults', label: 'New Project Defaults', icon: <Monitor size={16} /> },
  { id: 'ai-agents', label: 'AI Agents', icon: <Bot size={16} /> },
  { id: 'provider', label: 'Provider', icon: <KeyRound size={16} /> },
  { id: 'mcp-servers', label: 'MCP Servers', icon: <Network size={16} /> },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: <Keyboard size={16} /> },
  { id: 'updates', label: 'Updates', icon: <Download size={16} /> },
  { id: 'diagnostics', label: 'Diagnostics & Logs', icon: <FileText size={16} /> },
  { id: 'reset', label: 'Reset Settings', icon: <RotateCcw size={16} /> }
]

export const APP_PREF_CATEGORIES: SettingsCategory[] = isTauriContext()
  ? ALL_APP_PREF_CATEGORIES
  : ALL_APP_PREF_CATEGORIES.filter((category) => category.id !== 'updates')

// The updates search entries are desktop-only with the category itself;
// web keeps one entry that lands on the server-version note.
const ALL_APP_PREF_SEARCH_INDEX: SettingsSearchEntry[] = [
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
    label: 'Terminal Renderer',
    description: 'GPU-accelerated rendering for terminal output.',
    keywords: ['webgl', 'dom', 'gpu']
  },
  {
    categoryId: 'appearance',
    label: 'Screen reader mode',
    description: 'Make terminal output readable by screen readers.',
    keywords: ['accessibility', 'a11y', 'talkback', 'voiceover', 'nvda']
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
    label: 'Close idle chats after',
    description: 'How long a chat stays open after you leave it.',
    keywords: ['timeout', 'session closed', 'idle', 'keep idle chats', 'leave chat']
  },
  {
    categoryId: 'ai-agents',
    label: 'If an answer goes quiet',
    description: 'Cancel an answer that stops sending updates.',
    keywords: ['timeout', 'idle', 'silent', 'turn']
  },
  {
    categoryId: 'ai-agents',
    label: 'Longest one answer',
    description: 'Stop an answer that is still writing.',
    keywords: ['timeout', 'turn', 'long answer']
  },
  {
    categoryId: 'ai-agents',
    label: 'Start a new chat',
    description: 'How long to wait for an agent to start.',
    keywords: ['timeout', 'new chat', 'start']
  },
  {
    categoryId: 'ai-agents',
    label: 'Open a saved chat',
    description: 'How long to wait to open a saved chat.',
    keywords: ['timeout', 'resume', 'reopen', 'history']
  },
  {
    categoryId: 'provider',
    label: 'Claude accounts',
    description: 'Add Claude accounts, sign in, and choose the default account.',
    keywords: ['provider', 'account', 'claude', 'login', 'sign in', 'subscription', 'switch']
  },
  {
    categoryId: 'provider',
    label: 'Usage and limits',
    description: 'See how much of the 5-hour and weekly limits each account has used.',
    keywords: ['usage', 'limit', 'rate limit', 'quota', 'reset']
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

export const APP_PREF_SEARCH_INDEX: SettingsSearchEntry[] = isTauriContext()
  ? ALL_APP_PREF_SEARCH_INDEX
  : [
      ...ALL_APP_PREF_SEARCH_INDEX.filter((entry) => entry.categoryId !== 'updates'),
      {
        categoryId: 'updates',
        label: 'Server Version',
        description: 'The web client updates together with the termul-server.',
        keywords: ['version', 'upgrade', 'server']
      }
    ]
