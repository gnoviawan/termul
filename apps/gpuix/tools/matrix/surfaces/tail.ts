/**
 * Settings sections, themes, command palette commands, shortcuts, and the
 * long tail (browser, canvas, SSH, toasts, update UI, snapshots, bug report,
 * what's new).
 */

import { DEFAULT_KEYBOARD_SHORTCUTS } from '@/types/settings'
import { PAGE_TITLE, PAGE_URL, servePage } from '../../reference/page'
import type { Check, Surface } from '../types'
import { resetAlpha, SHORTCUTS_KEY, seedSshProfiles, setTheme, writeShared } from '../world'
import {
  CANVAS_READY,
  COMPOSER_READY,
  click,
  css,
  DASHBOARD,
  gone,
  label,
  press,
  see,
  step,
  txt,
  type,
  wait
} from './dsl'

const SETTINGS_SECTIONS: Array<[id: string, nav: string, expect: string]> = [
  ['interface', 'Interface', 'Interface zoom'],
  ['notifications', 'Notifications', 'Notify when a terminal agent finishes'],
  ['editor', 'Editor', 'Auto save delay'],
  ['appearance', 'Appearance', 'Font size'],
  ['shell', 'Shell', 'Default shell'],
  ['terminal-profiles', 'Profiles', 'No terminal profiles'],
  ['ai-agents', 'Agent chats', 'Close idle chats after'],
  ['skills', 'Skills', 'Skills'],
  // The nav label alone would pass before the Account list loads.
  ['provider', 'Accounts', '1 account'],
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

const THEME_FAMILIES = [
  'termul',
  'cursor',
  'catppuccin',
  'dracula',
  'nord',
  'gruvbox',
  'tokyonight',
  'ayu',
  'one-dark',
  'github'
]

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
 * focus. The web presses its defaults (settings.ts WEB_DEFAULT_KEY_OVERRIDES);
 * GPUIX, a registered desktop host, has the desktop table (K2), so where the
 * two differ the fifth field is the key GPUIX presses.
 */
const SHORTCUTS: Array<
  [id: string, keys: string, title: string, expect: Check[], gpuixKeys?: string]
> = [
  ['toggle-projects', 'ctrl-shift-b', 'collapse the project rail', [gone('gamma')]],
  ['toggle-side-panel', 'ctrl-b', 'hide the side panel', [gone('Explorer')]],
  ['theme-picker', 'ctrl-alt-t', 'theme picker', see('Color Themes')],
  ['zoom-in', 'alt-=', 'zoom in', see('What should we do in alpha?'), 'ctrl-=']
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
    steps: [
      DASHBOARD,
      step(
        'b-typed',
        [press('ctrl-k'), type('theme')],
        [...see('Change Color Theme'), gone('New Terminal')]
      )
    ]
  },
  ...PALETTE_COMMANDS.map(
    ([commandId, command, expect]): Surface => ({
      id: `palette.${commandId}`,
      area:
        commandId === 'switch-project'
          ? 'rail'
          : commandId.includes('snapshot')
            ? 'snapshots'
            : 'palette',
      title: `Palette command: ${command}`,
      steps: [
        DASHBOARD,
        step(
          'b-filtered',
          [press('ctrl-k'), wait(800), type(command)],
          [...see(command), ...(command === 'New Terminal' ? [] : [gone('New Terminal')])]
        ),
        step(
          'c-run',
          [commandId === 'switch-project' ? press('enter') : click(txt(command)), wait(1200)],
          commandId === 'open-canvas'
            ? [...see(expect), CANVAS_READY]
            : commandId === 'switch-project'
              ? [...see(expect), ...COMPOSER_READY]
              : see(expect)
        )
      ]
    })
  )
]

/** The desktop table's keys for the bindings `shortcuts.desktop-keymap` presses, as custom keys. */
const DESKTOP_BINDINGS = Object.fromEntries(
  ['newTerminal', 'closeTab', 'commandHistory', 'settings', 'zoomIn'].map((id) => [
    id,
    { customKey: DEFAULT_KEYBOARD_SHORTCUTS[id].defaultKey }
  ])
)

/** `[data-pane-content]` on the 1280x800 dashboard, measured in the web client: the pane the browser tab fills. */
const PANE_RECT = { x: 477, y: 9, width: 794, height: 754 }
/** The browser controls' URL field, under the pane's tab bar. */
const URL_BAR = { point: { x: 800, y: 63 } }
const LONG_TAIL: Surface[] = [
  {
    id: 'shortcuts.menu',
    area: 'shortcuts',
    title: 'Keyboard shortcuts popover',
    steps: [
      DASHBOARD,
      step('b-open', [click(label('Open keyboard shortcuts menu'))], see('Shortcut Menu'))
    ]
  },
  {
    id: 'shortcuts.settings-shortcut',
    area: 'shortcuts',
    title: 'Settings shortcut (web Alt+,, desktop Ctrl+,); Escape closes the dialog',
    steps: [
      DASHBOARD,
      step('b-open', [press('alt-,', 'ctrl-,')], see('Interface zoom')),
      step('c-escape', [press('escape'), wait(600)], [gone('Interface zoom')])
    ]
  },
  ...SHORTCUTS.map(
    ([shortcutId, keys, title, expect, gpuixKeys]): Surface => ({
      id: `shortcuts.${shortcutId}`,
      area: 'shortcuts',
      title: `Default shortcut ${keys}: ${title}`,
      steps: [
        DASHBOARD,
        step('b-pressed', [click(txt('Projects')), press(keys, gpuixKeys), wait(1000)], expect)
      ]
    })
  ),
  {
    id: 'shortcuts.desktop-keymap',
    area: 'shortcuts',
    title: 'Desktop key bindings (Ctrl+T, Ctrl+W, Ctrl+R, Ctrl+, and Ctrl+=)',
    // Both press the desktop keys. GPUIX has them as its defaults; the web
    // client gets them as custom bindings, as a web user can set them.
    prepare: (world, client) =>
      client === 'web' ? writeShared(world, SHORTCUTS_KEY, DESKTOP_BINDINGS) : Promise.resolve(),
    steps: [
      DASHBOARD,
      step(
        'b-terminal',
        [click(css('button[aria-label^="Open terminal at"]')), wait(2500)],
        [...see('Terminal 1'), gone('What should we do in alpha?')]
      ),
      step(
        'c-launcher',
        [click(txt('Projects')), press('ctrl-t'), wait(1000)],
        see('What should we do in alpha?')
      ),
      step(
        'd-launcher-again',
        [click(txt('Projects')), press('ctrl-t'), wait(1000)],
        [gone('What should we do in alpha?')]
      ),
      step(
        'e-close-tab',
        [click(txt('Projects')), press('ctrl-w'), wait(1000)],
        see('Close Terminal')
      ),
      step('f-closed', [click(txt('Close')), wait(1000)], [gone('Terminal 1')]),
      step(
        'g-history',
        [click(txt('Projects')), press('ctrl-r'), wait(800)],
        see('Command History')
      ),
      step(
        'h-settings',
        [press('escape'), click(txt('Projects')), press('ctrl-,'), wait(800)],
        see('Interface zoom')
      ),
      step('i-zoom', [press('escape'), click(txt('Projects')), press('ctrl-='), wait(1000)])
    ]
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
    steps: [
      DASHBOARD,
      step('b-open', [click(label('Open canvas'))], [...see('Canvas'), CANVAS_READY])
    ]
  },
  {
    id: 'browser.pane',
    area: 'browser',
    title: 'Browser pane',
    // The web client has no browser tab; the desktop app's is a native WebKitGTK
    // webview, and so is GPUIX's (the termul-webview-host helper).
    reference: 'tauri',
    roiRect: PANE_RECT,
    prepare: async () => servePage(),
    steps: [
      step('a-dashboard', [wait(2000)], see('What should we do in alpha?')),
      // A new tab starts on the product's default page (www.google.com, from the network),
      // so the tab is pointed at the local page before the first frame.
      step(
        'b-page',
        [
          press('ctrl-shift-n'),
          wait(2500),
          click(URL_BAR),
          wait(600),
          press('ctrl-a'),
          type(PAGE_URL),
          press('enter'),
          wait(3000)
        ],
        see(PAGE_TITLE)
      )
    ]
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
      step(
        'b-picker',
        [click(label('Switch git branch')), click(txt('Create branch from', false))],
        []
      ),
      step(
        'c-toast',
        [type(TOAST_BRANCH), press('enter'), wait(800)],
        see(`Created and checked out ${TOAST_BRANCH}`)
      )
    ]
  },
  {
    id: 'ssh.workspace',
    area: 'ssh',
    title: 'SSH profiles and sessions',
    reference: 'web-host-local',
    prepare: seedSshProfiles,
    steps: [
      step('a-sidebar', [], see('What should we do in alpha?', 'staging', 'build-box')),
      step('b-hosts', [click(label('Open SSH hosts'))], see('Favorites', 'Servers')),
      step('c-new-host', [click(label('New host'))], see('New host'))
    ]
  },
  {
    id: 'settings.accounts-claude',
    area: 'settings',
    title: 'Claude account sign-in',
    reference: 'web-host-local',
    roi: '[role="dialog"]',
    steps: [
      DASHBOARD,
      step('b-open', [click(label('Settings'))], see('Interface zoom')),
      step('c-section', [click(txt('Accounts'))], see('1 account', 'Keep work and personal apart')),
      // Continue would start a real claude.ai sign-in on the host, so the run stops at the name.
      step(
        'd-add',
        [click(txt('Add account')), wait(800), type('Work')],
        see('Give it a short name. Termul shows this name, never the email.')
      )
    ]
  },
  {
    id: 'update.toast',
    area: 'notifications',
    title: "Update available toast and what's new modal",
    blocked:
      'Both render only when isTauriContext() is true (App.tsx WhatsNewModal, UpdateAvailableToast); the web client never shows them, so there is no reference to compare against',
    steps: []
  },
  {
    id: 'snapshots.page',
    area: 'snapshots',
    title: 'Snapshots page (#/snapshots)',
    // No desktop shell links to the route (only the mobile drawer does), so both start on it.
    start: { hash: '#/snapshots', ready: 'Workspace Snapshots' },
    steps: [
      step('a-page', [], see('Workspace Snapshots', 'Create New Snapshot', 'No snapshots yet')),
      step('b-create', [click(txt('Create New Snapshot'))], see('Create Snapshot'))
    ]
  }
]

export const TAIL: Surface[] = [...SETTINGS, ...PALETTE, ...LONG_TAIL, ...THEMES]
