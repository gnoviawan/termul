/**
 * Settings sections, themes, command palette commands, shortcuts, and the
 * long tail (browser, canvas, SSH, toasts, update UI, snapshots, bug report,
 * what's new).
 */

import type { Check, Surface } from '../types'
import { resetAlpha, setTheme } from '../world'
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

const TOAST_BRANCH = 'toast-branch'

/**
 * Pressed after a click on the rail's Projects label, so no text field holds
 * focus. Keys are the web defaults (settings.ts WEB_DEFAULT_KEY_OVERRIDES),
 * which GPUIX inherits because it is not a Tauri context.
 */
const SHORTCUTS: Array<[id: string, keys: string, title: string, expect: Check[]]> = [
  ['toggle-projects', 'ctrl-shift-b', 'collapse the project rail', [gone('gamma')]],
  ['toggle-side-panel', 'ctrl-b', 'hide the side panel', [gone('Explorer')]],
  ['theme-picker', 'ctrl-alt-t', 'theme picker', see('Color Themes')],
  ['zoom-in', 'alt-=', 'zoom in', see('What should we do in alpha?')]
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
  {
    id: 'palette.type-ahead',
    area: 'palette',
    title: 'Typing straight after Ctrl+K reaches the palette filter',
    roi: '[role="dialog"]',
    steps: [DASHBOARD, step('b-typed', [press('ctrl-k'), type('theme')], [...see('Change Color Theme'), gone('New Terminal')])]
  },
  ...PALETTE_COMMANDS.map(
    ([commandId, command, expect]): Surface => ({
      id: `palette.${commandId}`,
      area: commandId === 'switch-project' ? 'rail' : commandId.includes('snapshot') ? 'snapshots' : 'palette',
      title: `Palette command: ${command}`,
      steps: [
        DASHBOARD,
        step('b-filtered', [press('ctrl-k'), wait(800), type(command)], [...see(command), ...(command === 'New Terminal' ? [] : [gone('New Terminal')])]),
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
  ...SHORTCUTS.map(
    ([shortcutId, keys, title, expect]): Surface => ({
      id: `shortcuts.${shortcutId}`,
      area: 'shortcuts',
      title: `Default shortcut ${keys}: ${title}`,
      steps: [DASHBOARD, step('b-pressed', [click(txt('Projects')), press(keys), wait(1000)], expect)]
    })
  ),
  {
    id: 'shortcuts.desktop-keymap',
    area: 'shortcuts',
    title: 'Desktop key bindings (Ctrl+T, Ctrl+W, Ctrl+R, Ctrl+, and Ctrl+=)',
    blocked: 'No web reference: the web client swaps browser-reserved keys for Alt combos, and GPUIX inherits that keymap because it is not a Tauri context',
    steps: []
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
    title: 'Toast after creating a branch',
    prepare: async (world) => {
      await resetAlpha(world)
      Bun.spawnSync(['git', 'branch', '-D', TOAST_BRANCH], { cwd: world.dirs.alpha })
    },
    steps: [
      DASHBOARD,
      step('b-picker', [click(label('Switch git branch')), click(txt('Create branch from', false))], []),
      step('c-toast', [type(TOAST_BRANCH), press('enter'), wait(800)], see(`Created and checked out ${TOAST_BRANCH}`))
    ]
  },
  {
    id: 'ssh.workspace',
    area: 'ssh',
    title: 'SSH profiles and sessions',
    blocked:
      'No web reference: SSH needs a host-local client (useHostGate(canUseHostSsh)), which a browser never is; R2 drove the GPUIX flow against a throwaway sshd (reports/r2-shots)',
    steps: []
  },
  {
    id: 'settings.accounts-claude',
    area: 'settings',
    title: 'Claude account sign-in',
    blocked:
      'No web reference: Claude account management needs a host-local client, which a browser never is; the R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path',
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
