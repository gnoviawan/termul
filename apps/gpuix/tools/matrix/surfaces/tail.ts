/**
 * Settings sections, themes, command palette commands, shortcuts, and the
 * long tail (browser, canvas, SSH, toasts, update UI, snapshots, bug report,
 * what's new).
 */

import type { Surface } from '../types'
import { setTheme } from '../world'
import { click, DASHBOARD, gone, label, press, see, step, txt, type, wait } from './dsl'

const SETTINGS_SECTIONS: Array<[id: string, nav: string, expect: string]> = [
  ['interface', 'Interface', 'Interface zoom'],
  ['notifications', 'Notifications', 'Notify when a terminal agent finishes'],
  ['editor', 'Editor', 'Auto save delay'],
  ['appearance', 'Appearance', 'Font size'],
  ['shell', 'Shell', 'Default shell'],
  ['terminal-profiles', 'Profiles', 'No terminal profiles'],
  ['ai-agents', 'Agent chats', 'Close idle chats after'],
  ['skills', 'Skills', 'Skills'],
  ['provider', 'Accounts', 'Accounts'],
  ['mcp-servers', 'MCP servers', 'MCP servers'],
  ['shortcuts', 'Keyboard shortcuts', 'Command Palette'],
  ['diagnostics', 'Logs', 'Application log'],
  ['reset', 'Reset', 'Reset all settings']
]

const SETTINGS: Surface[] = SETTINGS_SECTIONS.map(([sectionId, nav, expect]) => ({
  id: `settings.${sectionId}`,
  area: 'settings',
  title: `Settings: ${nav}`,
  roi: '[role="dialog"]',
  steps: [
    DASHBOARD,
    step('b-open', [click(label('Settings'))], see('Interface zoom')),
    step('c-section', [click(txt(nav))], see(expect))
  ]
}))

const THEME_FAMILIES = ['termul', 'cursor', 'catppuccin', 'dracula', 'nord', 'gruvbox', 'tokyonight', 'ayu', 'one-dark', 'github']

const THEMES: Surface[] = THEME_FAMILIES.flatMap((family) =>
  (['dark', 'light'] as const).map(
    (mode): Surface => ({
      id: `theme.${family}-${mode}`,
      area: 'theme',
      title: `Theme ${family} (${mode})`,
      prepare: (world) => setTheme(world, family, mode),
      steps: [step('a-dashboard', [wait(800)], see('What should we do in alpha?'))]
    })
  )
)

const PALETTE_COMMANDS: Array<[id: string, command: string, expect: string]> = [
  ['new-terminal', 'New Terminal', 'Terminal'],
  ['agent-launcher', 'Agent Launcher', 'Chat Scenario Agent'],
  ['save-snapshot', 'Save Workspace Snapshot', 'Snapshot'],
  ['open-canvas', 'Open Canvas', 'Canvas'],
  ['project-settings', 'Project Settings', 'Basic project identification and location.'],
  ['app-preferences', 'App Preferences', 'Interface zoom'],
  ['switch-project', 'beta', 'What should we do in beta?'],
  ['command-history', 'Command History', 'Command History'],
  ['color-theme', 'Change Color Theme', 'Dracula'],
  ['shortcut-menu', 'Open Shortcut Menu', 'Shortcut Menu'],
  ['report-bug', 'Report a Bug', 'Report a bug']
]

const PALETTE: Surface[] = [
  {
    id: 'palette.open',
    area: 'palette',
    title: 'Command palette (Ctrl+K) and filtering',
    roi: '[role="dialog"]',
    steps: [
      DASHBOARD,
      step('b-open', [press('ctrl-k')], see('App Preferences', 'New Terminal')),
      step('c-filter', [type('theme')], [...see('Change Color Theme'), gone('New Terminal')]),
      step('d-escape', [press('escape')], [{ text: 'Change Color Theme', gone: true }])
    ]
  },
  ...PALETTE_COMMANDS.map(
    ([commandId, command, expect]): Surface => ({
      id: `palette.${commandId}`,
      area: commandId === 'switch-project' ? 'rail' : commandId.includes('snapshot') ? 'snapshots' : 'palette',
      title: `Palette command: ${command}`,
      steps: [
        DASHBOARD,
        step('b-filtered', [press('ctrl-k'), type(command)], [...see(command), ...(command === 'New Terminal' ? [] : [gone('New Terminal')])]),
        step('c-run', [commandId === 'switch-project' ? press('enter') : click(txt(command)), wait(1200)], see(expect))
      ]
    })
  )
]

const LONG_TAIL: Surface[] = [
  {
    id: 'shortcuts.menu',
    area: 'shortcuts',
    title: 'Keyboard shortcuts popover',
    steps: [DASHBOARD, step('b-open', [click(label('Open keyboard shortcuts menu'))], see('Shortcut Menu'))]
  },
  {
    id: 'shortcuts.settings-shortcut',
    area: 'shortcuts',
    title: 'Settings shortcut (Alt+,); Escape leaves the web dialog open',
    steps: [DASHBOARD, step('b-open', [press('alt-,')], see('Interface zoom')), step('c-escape', [press('escape'), wait(600)], see('Interface zoom'))]
  },
  {
    id: 'theme.picker',
    area: 'theme',
    title: 'Theme picker',
    steps: [DASHBOARD, step('b-open', [click(label('Color themes'))], see('Dracula', 'Nord'))]
  },
  {
    id: 'dialogs.bug-report',
    area: 'dialogs',
    title: 'Report a bug dialog',
    steps: [DASHBOARD, step('b-open', [click(label('Report a bug'))], see('Report a bug'))]
  },
  {
    id: 'canvas.open',
    area: 'canvas',
    title: 'Canvas',
    steps: [DASHBOARD, step('b-open', [click(label('Open canvas')), wait(2000)], see('Canvas'))]
  },
  {
    id: 'browser.pane',
    area: 'browser',
    title: 'Browser pane',
    blocked: 'Browser tabs are Tauri native webviews; the web client offers no New Browser Tab, so there is no reference, and GPUIX 0.11 has no webview element',
    steps: []
  },
  {
    id: 'notifications.toast',
    area: 'notifications',
    title: 'Toast after saving a snapshot',
    steps: [
      DASHBOARD,
      step('b-modal', [press('ctrl-k'), type('Save Workspace Snapshot'), press('enter'), wait(800)], see('Snapshot')),
      step('c-toast', [type('matrix snapshot'), press('enter'), wait(800)], see('Snapshot'))
    ]
  },
  {
    id: 'ssh.workspace',
    area: 'ssh',
    title: 'SSH profiles and sessions',
    pending: { unit: 'R1', reason: 'SSH server routes are on gpuix/r1, in review' },
    steps: []
  },
  {
    id: 'settings.accounts-claude',
    area: 'settings',
    title: 'Claude account sign-in',
    pending: { unit: 'R1', reason: 'Claude-account server routes are on gpuix/r1, in review' },
    steps: []
  },
  {
    id: 'update.toast',
    area: 'notifications',
    title: 'Update available toast and what\'s new modal',
    blocked: 'Both render only when isTauriContext() is true (App.tsx WhatsNewModal, UpdateAvailableToast); the web client never shows them, so there is no reference to compare against',
    steps: []
  },
  {
    id: 'snapshots.page',
    area: 'snapshots',
    title: 'Snapshots page (#/snapshots)',
    blocked: 'The desktop shell has no link to the route; only the mobile drawer navigates to it, and GPUIX cannot start on a hash route yet',
    steps: []
  }
]

export const TAIL: Surface[] = [...SETTINGS, ...PALETTE, ...LONG_TAIL, ...THEMES]
