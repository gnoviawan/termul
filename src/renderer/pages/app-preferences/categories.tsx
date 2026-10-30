import {
  Bell,
  Bot,
  Download,
  FileEdit,
  FileText,
  Globe,
  Keyboard,
  KeyRound,
  Monitor,
  Network,
  Palette,
  RotateCcw,
  Sparkles,
  Terminal,
  TerminalSquare
} from '@/components/icons'
import { BROWSER_ANCHORS } from '@/components/settings/browser-policy-copy'
import { rowId } from '@/components/settings/row-id'
import type { SettingsCategory } from '@/components/settings/SettingsLayout'
import type { SettingsSearchEntry } from '@/lib/settings-search'
import { isTauriContext } from '@/lib/tauri-runtime'

// The whole "Updates" page is desktop-only (issue #843): the web client
// updates with the server, so the updater entry points are hidden there.
const ALL_APP_PREF_CATEGORIES: SettingsCategory[] = [
  {
    id: 'interface',
    group: 'General',
    label: 'Interface',
    description: 'Size of the whole interface and defaults for new projects.',
    icon: <Monitor size={16} />
  },
  {
    id: 'notifications',
    group: 'General',
    label: 'Notifications',
    description: 'Choose when Termul sends you a system notification.',
    icon: <Bell size={16} />
  },
  {
    id: 'editor',
    group: 'General',
    label: 'Editor',
    description: 'How code files save while you work.',
    icon: <FileEdit size={16} />
  },
  {
    id: 'appearance',
    group: 'Terminal',
    label: 'Appearance',
    description: 'How terminals look, draw text and open links.',
    icon: <Palette size={16} />
  },
  {
    id: 'shell',
    group: 'Terminal',
    label: 'Shell',
    description: 'The shell that new terminals start with.',
    icon: <Terminal size={16} />
  },
  {
    id: 'terminal-profiles',
    group: 'Terminal',
    label: 'Profiles',
    description:
      'Saved terminals with their own shell, arguments, folder and variables. Open one from the command palette.',
    icon: <TerminalSquare size={16} />
  },
  {
    id: 'ai-agents',
    group: 'Agents',
    label: 'Agent chats',
    description: 'Time limits for agent chats, and the agents Termul can start.',
    icon: <Bot size={16} />
  },
  {
    id: 'skills',
    group: 'Agents',
    label: 'Skills',
    description:
      'Skills in your home folder and in the open project. The slash menu uses this list.',
    icon: <Sparkles size={16} />
  },
  {
    id: 'provider',
    group: 'Agents',
    label: 'Accounts',
    description: 'Claude accounts that Claude Agent chats use, and how much of each limit is used.',
    icon: <KeyRound size={16} />
  },
  {
    id: 'mcp-servers',
    group: 'Agents',
    label: 'MCP servers',
    description:
      'Servers that new agent chats can use. Each enabled server is offered when a chat starts.',
    icon: <Network size={16} />
  },
  {
    id: 'browser',
    group: 'Agents',
    label: 'Browser',
    description:
      'Which sites agents may browse without asking, and whether they keep logins between chats.',
    icon: <Globe size={16} />
  },
  {
    id: 'shortcuts',
    group: 'App',
    label: 'Keyboard shortcuts',
    description: 'Change the keys for Termul commands. Select a shortcut, then press the new keys.',
    icon: <Keyboard size={16} />
  },
  {
    id: 'updates',
    group: 'App',
    label: 'Updates',
    description: 'Termul version, release channel and automatic checks.',
    icon: <Download size={16} />
  },
  {
    id: 'diagnostics',
    group: 'App',
    label: 'Logs',
    description: 'Copy or export the application log to report a problem.',
    icon: <FileText size={16} />
  },
  {
    id: 'reset',
    group: 'App',
    label: 'Reset',
    description: 'Return settings to their defaults.',
    icon: <RotateCcw size={16} />
  }
]

/** Pages for the current runtime: the web client has no Updates page. */
export function appPrefCategories(): SettingsCategory[] {
  return isTauriContext()
    ? ALL_APP_PREF_CATEGORIES
    : ALL_APP_PREF_CATEGORIES.filter((category) => category.id !== 'updates')
}

// The updates search entries are desktop-only with the page itself; on web
// the server version note lives on the Logs page, so its entry lands there.
const ALL_APP_PREF_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    categoryId: 'interface',
    label: 'Interface zoom',
    description: 'Make everything larger or smaller (50–300%).',
    keywords: ['ui zoom', 'zoom', 'interface scale', 'window zoom', 'magnify'],
    anchorId: rowId('ui-zoom')
  },
  {
    categoryId: 'interface',
    label: 'Default project color',
    description: 'New projects start with this color.',
    keywords: ['theme', 'appearance', 'color', 'new project'],
    anchorId: rowId('default-project-color')
  },
  {
    categoryId: 'notifications',
    label: 'Notify when a terminal agent finishes',
    description: 'Notify when a long-running terminal tab goes quiet.',
    keywords: ['notification', 'terminal', 'idle', 'agent'],
    anchorId: rowId('notify-terminal-idle')
  },
  {
    categoryId: 'notifications',
    label: 'Notify when an agent chat turn finishes',
    description: 'Notify when an agent chat turn ends and nothing is queued.',
    keywords: ['notification', 'chat', 'finished', 'agent'],
    anchorId: rowId('notify-turn-finished')
  },
  {
    categoryId: 'notifications',
    label: 'Notify when an agent chat needs you',
    description: 'Notify when an agent waits for your approval or an answer.',
    keywords: ['notification', 'approval', 'permission', 'question'],
    anchorId: rowId('notify-needs-you')
  },
  {
    categoryId: 'editor',
    label: 'Auto save',
    description: 'Save editor files after you stop typing.',
    keywords: ['editor', 'autosave', 'auto save', 'save'],
    anchorId: rowId('editor-auto-save')
  },
  {
    categoryId: 'editor',
    label: 'Auto save delay',
    description: 'How long to wait after your last edit.',
    keywords: ['editor', 'autosave', 'delay', 'timeout'],
    anchorId: rowId('editor-auto-save-delay')
  },
  {
    categoryId: 'appearance',
    label: 'Font size',
    description: 'Terminal text size.',
    keywords: ['text size', 'zoom'],
    anchorId: rowId('terminal-font-size')
  },
  {
    categoryId: 'appearance',
    label: 'Renderer',
    description: 'GPU-accelerated rendering for terminal output.',
    keywords: ['webgl', 'dom', 'gpu'],
    anchorId: rowId('terminal-renderer')
  },
  {
    categoryId: 'appearance',
    label: 'Scrollback',
    description: 'Number of lines to keep in terminal history.',
    keywords: ['history', 'lines', 'memory', 'buffer'],
    anchorId: rowId('terminal-scrollback')
  },
  {
    categoryId: 'appearance',
    label: 'Screen reader mode',
    description: 'Make terminal output readable by screen readers.',
    keywords: ['accessibility', 'a11y', 'talkback', 'voiceover', 'nvda'],
    anchorId: rowId('terminal-screen-reader-mode')
  },
  {
    categoryId: 'appearance',
    label: 'Automatic completion refresh',
    description: 'Updates command suggestions while you type.',
    keywords: ['completion', 'suggestions', 'tab', 'autocomplete'],
    anchorId: rowId('terminal-automatic-completion-refresh')
  },
  {
    categoryId: 'appearance',
    label: 'Open links in',
    description: 'Choose where URLs from terminal output open.',
    keywords: ['url', 'links', 'browser'],
    anchorId: rowId('terminal-url-open-mode')
  },
  {
    categoryId: 'shell',
    label: 'Default shell',
    description: 'Set the default shell for new terminals.',
    keywords: ['bash', 'zsh', 'powershell', 'fish'],
    anchorId: rowId('default-shell')
  },
  {
    categoryId: 'terminal-profiles',
    label: 'Terminal profiles',
    description: 'Save a shell with arguments, start folder and environment variables.',
    keywords: ['profile', 'preset', 'shell', 'env', 'environment', 'cwd', 'folder', 'arguments']
  },
  {
    categoryId: 'ai-agents',
    label: 'Available agents',
    description: 'View ACP agent availability and warm/auth status.',
    keywords: ['acp', 'agent', 'coding assistant'],
    anchorId: 'settings-available-agents'
  },
  {
    categoryId: 'ai-agents',
    label: 'Close idle chats after',
    description: 'How long a chat stays open after you leave it.',
    keywords: ['timeout', 'session closed', 'idle', 'keep idle chats', 'leave chat'],
    anchorId: rowId('agent-idle-window')
  },
  {
    categoryId: 'ai-agents',
    label: 'If an answer goes quiet',
    description: 'Cancel an answer that stops sending updates.',
    keywords: ['timeout', 'idle', 'silent', 'turn'],
    anchorId: rowId('acp-turn-idle-timeout')
  },
  {
    categoryId: 'ai-agents',
    label: 'Longest one answer',
    description: 'Stop an answer that is still writing.',
    keywords: ['timeout', 'turn', 'long answer'],
    anchorId: rowId('acp-turn-timeout')
  },
  {
    categoryId: 'ai-agents',
    label: 'Start a new chat',
    description: 'How long to wait for an agent to start.',
    keywords: ['timeout', 'new chat', 'start'],
    anchorId: rowId('acp-session-new-timeout')
  },
  {
    categoryId: 'ai-agents',
    label: 'Open a saved chat',
    description: 'How long to wait to open a saved chat.',
    keywords: ['timeout', 'resume', 'reopen', 'history'],
    anchorId: rowId('acp-session-reopen-timeout')
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
    categoryId: 'skills',
    label: 'Skills',
    description: 'See skills installed for every project and for the open project.',
    keywords: ['skill', 'agents', 'SKILL.md', 'slash']
  },
  {
    categoryId: 'mcp-servers',
    label: 'MCP servers',
    description: 'Manage global stdio, HTTP, and SSE servers, or browse the MCP catalog.',
    keywords: [
      'mcp',
      'model context protocol',
      'stdio',
      'http',
      'sse',
      'catalog',
      'registry',
      'browse',
      'discover',
      'marketplace'
    ]
  },
  {
    categoryId: 'browser',
    label: 'Shared agent profile',
    description: 'Keep agent logins between chats, in every project.',
    keywords: ['browser', 'profile', 'cookies', 'login', 'sign in', 'incognito', 'logged out'],
    anchorId: BROWSER_ANCHORS.appProfile
  },
  {
    categoryId: 'browser',
    label: 'Ask before an agent submits a password',
    description: 'Have agents ask you before they sign in to a site.',
    keywords: ['browser', 'password', 'sign in', 'login', 'prompt', 'ask', 'automation'],
    anchorId: BROWSER_ANCHORS.appPasswordPrompt
  },
  {
    categoryId: 'browser',
    label: 'Clear agent profile',
    description: 'Delete the shared agent profile logins and site data.',
    keywords: ['browser', 'cookies', 'sign out', 'logins', 'wipe', 'reset'],
    anchorId: BROWSER_ANCHORS.appClear
  },
  {
    categoryId: 'browser',
    label: 'Pre-approved actions in every project',
    description: 'Actions agents may take on the shared agent profile without asking.',
    keywords: ['browser', 'upload', 'download', 'approve', 'automation'],
    anchorId: BROWSER_ANCHORS.appPreapprovals
  },
  {
    categoryId: 'shortcuts',
    label: 'Keyboard shortcuts',
    description: 'Customize keyboard shortcuts to match your workflow.',
    keywords: ['hotkeys', 'bindings', 'keybindings']
  },
  {
    categoryId: 'updates',
    label: 'Check for updates',
    description: 'Manage application updates and version information.',
    keywords: ['version', 'upgrade'],
    anchorId: rowId('check-updates')
  },
  {
    categoryId: 'updates',
    label: 'Check for updates automatically',
    description: 'Automatically check for updates.',
    keywords: ['automatic', 'version', 'auto-update'],
    anchorId: rowId('auto-update')
  },
  {
    categoryId: 'updates',
    label: 'Release channel',
    description: 'Choose Stable, Insider, or Nightly update track.',
    keywords: ['insider', 'nightly', 'stable', 'prerelease', 'beta', 'channel'],
    anchorId: rowId('release-channel')
  },
  {
    categoryId: 'diagnostics',
    label: 'Logs',
    description: 'Export or copy application logs to troubleshoot issues.',
    keywords: ['logs', 'export', 'troubleshoot', 'debug', 'diagnostics']
  },
  {
    categoryId: 'reset',
    label: 'Reset all settings',
    description: 'Restore all settings to their default values.',
    keywords: ['restore', 'defaults', 'clear'],
    anchorId: rowId('reset-settings')
  }
]

/** Search entries for the current runtime. */
export function appPrefSearchIndex(): SettingsSearchEntry[] {
  return isTauriContext()
    ? ALL_APP_PREF_SEARCH_INDEX
    : [
        ...ALL_APP_PREF_SEARCH_INDEX.filter((entry) => entry.categoryId !== 'updates'),
        {
          categoryId: 'diagnostics',
          label: 'Server version',
          description: 'The web client updates together with the termul-server.',
          keywords: ['version', 'upgrade', 'server'],
          anchorId: rowId('server-version')
        }
      ]
}
