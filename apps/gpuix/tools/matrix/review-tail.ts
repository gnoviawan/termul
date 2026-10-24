/** Reviews for settings, palette, shortcuts, themes and the long tail (see `review.ts`). */

import type { Review } from './review'
import { BACKDROP, ENTER, SELECT, SETTINGS_BASE, TINT } from './review-phrases'

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
const THEME_REVIEWS: Record<string, Review> = Object.fromEntries(
  THEME_FAMILIES.flatMap((family) =>
    (['dark', 'light'] as const).map((mode): [string, Review] => [
      `theme.${family}-${mode}`,
      {
        status: 'ported',
        differences: [
          'Background, panel, card, border, text and accent colours match the web dashboard.',
          'The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items).'
        ]
      }
    ])
  )
)

export const TAIL_REVIEWS: Record<string, Review> = {
  ...THEME_REVIEWS,
  'palette.type-ahead': {
    status: 'broken',
    differences: [
      'Typing "theme" straight after Ctrl+K filters the web palette; GPUIX opens the palette with an empty search field, so the keystrokes typed before focus moved are lost.',
      'The web ranks Open Canvas first for "theme" and GPUIX ranks Agent Launcher first (seen when the filter is typed after the palette opens).'
    ],
    cause: 'needs diagnosis',
    unit: 'C11 focus on open',
    impact: 2
  },
  'palette.new-terminal': {
    status: 'ported',
    differences: ['New Terminal opens Terminal 1 in both.']
  },
  'palette.agent-launcher': {
    status: 'ported',
    differences: ['Agent Launcher shows the launcher with its close button in both.']
  },
  'palette.save-snapshot': {
    status: 'partial',
    differences: ['The Create Snapshot modal matches.', BACKDROP, TINT],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.open-canvas': {
    status: 'blocked',
    differences: [
      'Opens the canvas tab in both; see canvas.open for why the canvas itself is not compared.'
    ],
    cause: 'missing GPUIX capability',
    unit: 'V1 canvas host',
    impact: 1
  },
  'palette.project-settings': {
    status: 'partial',
    differences: ['Project settings opens on General with the same fields.', BACKDROP],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.app-preferences': {
    status: 'partial',
    differences: ['Preferences opens on Interface.', BACKDROP],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.switch-project': {
    status: 'broken',
    differences: [
      'Typing beta filters to the beta row in both, but Enter switches the web to beta and leaves the GPUIX palette open on alpha.',
      ENTER
    ],
    cause: 'needs diagnosis',
    unit: 'C12 Enter in fields and lists',
    impact: 2
  },
  'palette.command-history': {
    status: 'partial',
    differences: [
      'The Command History modal, its scope picker and empty state match.',
      BACKDROP,
      'No focus ring on the search field.'
    ],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.color-theme': {
    status: 'ported',
    differences: [
      'Change Color Theme opens the Color Themes popover in both; see theme.picker for its tint.'
    ]
  },
  'palette.shortcut-menu': {
    status: 'partial',
    differences: ['Opens the Shortcut Menu in both.', BACKDROP],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.report-bug': {
    status: 'broken',
    differences: ['Opens the Report a bug dialog, collapsed the same way as dialogs.bug-report.'],
    cause: 'compat translator gap',
    unit: 'C9 dialog body layout',
    impact: 1
  },
  'shortcuts.toggle-projects': {
    status: 'ported',
    differences: ['Ctrl+Shift+B collapses the rail in both.']
  },
  'shortcuts.toggle-side-panel': {
    status: 'ported',
    differences: ['Ctrl+B hides the side panel in both.']
  },
  'shortcuts.theme-picker': {
    status: 'ported',
    differences: ['Ctrl+Alt+T opens the Color Themes popover in both.']
  },
  'shortcuts.zoom-in': {
    status: 'broken',
    differences: [
      'Alt+= zooms the web UI to 110 %; GPUIX does not change scale. The UI zoom hook (hooks/use-ui-zoom.ts) is on the compat needs-override list.'
    ],
    cause: 'native override needed',
    unit: 'O10 UI zoom',
    impact: 2
  },
  'shortcuts.desktop-keymap': {
    status: 'blocked',
    differences: [
      'GPUIX boots without __TAURI_INTERNALS__, so getDefaultKeyboardShortcuts() hands it the web keymap: Alt+T, Alt+W, Alt+, and Alt+= instead of the desktop Ctrl+T, Ctrl+W, Ctrl+, and Ctrl+=, and no Ctrl+R command history. A desktop user who moves to GPUIX loses those keys.'
    ],
    cause: 'native override needed',
    unit: 'K2 desktop keymap for GPUIX',
    impact: 2
  },
  'notifications.toast': {
    status: 'broken',
    differences: [
      'Create branch from main opens the name field in both. Typing the name and pressing Enter creates the branch and shows the success toast on the web; in GPUIX the name sits in the field and nothing happens.',
      ENTER,
      'Toast styling itself is compared on git.commit.'
    ],
    cause: 'needs diagnosis',
    unit: 'C12 Enter in fields and lists',
    impact: 2
  },
  'ssh.workspace': {
    status: 'blocked',
    differences: [
      'No web reference: SSH needs a host-local client and a browser never is one, so the web client shows no SSH section.',
      'R2 drove the GPUIX real shell as a host-local client against a throwaway sshd (reports/r2-shots): the sidebar SSH section, the hosts tab, host-key trust, a connected shell and the SFTP file list all render. In gpuix-ssh-connected.png the SFTP Modified column wraps times such as 12:26 AM onto two lines.'
    ],
    cause: 'compat translator gap',
    unit: 'C14 SFTP table column widths',
    impact: 1
  },
  'settings.accounts-claude': {
    status: 'blocked',
    differences: [
      'No web reference: Claude account management needs a host-local client. The R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path; no GPUIX pixel check of the sign-in flow exists yet.'
    ]
  },
  'settings.interface': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'settings.notifications': {
    status: 'partial',
    differences: [
      ...SETTINGS_BASE,
      'Row dividers inside a group are missing and rows sit tighter.'
    ],
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'settings.editor': {
    status: 'broken',
    differences: [SELECT, ...SETTINGS_BASE.slice(1)],
    cause: 'native override needed',
    unit: 'O8 native select',
    impact: 2
  },
  'settings.appearance': {
    status: 'broken',
    differences: [
      SELECT,
      'Renderer and Scrollback rows wrap their descriptions one word per line.',
      ...SETTINGS_BASE.slice(1)
    ],
    cause: 'native override needed',
    unit: 'O8 native select',
    impact: 2
  },
  'settings.shell': {
    status: 'broken',
    differences: [SELECT, ...SETTINGS_BASE.slice(1)],
    cause: 'native override needed',
    unit: 'O8 native select',
    impact: 2
  },
  'settings.terminal-profiles': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'settings.ai-agents': {
    status: 'broken',
    differences: [
      SELECT,
      'The Close idle chats after label wraps one or two letters per line, filling the pane; the agents list below is pushed out of view.'
    ],
    cause: 'native override needed',
    unit: 'O8 native select',
    impact: 2
  },
  'settings.skills': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'settings.provider': {
    status: 'partial',
    differences: [...SETTINGS_BASE, 'The usage line moves under the account instead of beside it.'],
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'settings.mcp-servers': {
    status: 'partial',
    differences: [...SETTINGS_BASE, 'The inline code in the footnote breaks onto its own line.'],
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'settings.shortcuts': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'settings.diagnostics': {
    status: 'partial',
    differences: [
      ...SETTINGS_BASE,
      'Server version reads termul-server v0.1.0 in GPUIX and v0.4.52 on the web against the same server.'
    ],
    cause: 'needs diagnosis',
    unit: 'O9 server version source',
    impact: 1
  },
  'settings.reset': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'shortcuts.menu': {
    status: 'partial',
    differences: [
      'Shortcut Menu rows, descriptions and key chips match, including the blank Command History chip in both.',
      BACKDROP
    ],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'shortcuts.settings-shortcut': {
    status: 'partial',
    differences: [
      'Alt+, opens Preferences in both. Escape then closes the dialog in GPUIX, where the web keeps it open.'
    ],
    cause: 'needs diagnosis',
    unit: 'C10 dialog Escape routing',
    impact: 1
  },
  'theme.picker': {
    status: 'partial',
    differences: [
      'The Color Themes popover, groups, swatches and the current-theme check match.',
      TINT,
      'No focus ring on the search field.'
    ],
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'dialogs.bug-report': {
    status: 'broken',
    differences: [
      'The Report a bug dialog collapses to its header and footer: the Title field is cut off and the What happened, Screenshots and Preview sections are not painted, so no report can be written.'
    ],
    cause: 'compat translator gap',
    unit: 'C9 dialog body layout',
    impact: 3
  },
  'canvas.open': {
    status: 'blocked',
    differences: [
      'This server build ships no figcraft bundle, so the web tab shows the BUNDLE_MISSING error JSON; GPUIX stays on Loading editor... and paints neither that error nor an editor.',
      'The canvas is a figcraft iframe (CanvasMountLayer), which GPUIX 0.11 cannot host.'
    ],
    cause: 'missing GPUIX capability',
    unit: 'V1 canvas host',
    impact: 2
  },
  'browser.pane': {
    status: 'blocked',
    differences: [
      'Not compared: browser tabs are Tauri webviews with no web-client reference, and GPUIX 0.11 has no webview element. Replacing Tauri loses the browser pane until a native webview exists.'
    ],
    cause: 'missing GPUIX capability',
    unit: 'V2 native webview',
    impact: 2
  },
  'update.toast': {
    status: 'blocked',
    differences: [
      "Not compared: the update toast and the what's new modal render only under isTauriContext(). GPUIX needs its own updater path to show them at all."
    ],
    cause: 'native override needed',
    unit: "U1 GPUIX updater and what's new",
    impact: 1
  },
  'theme.tokyonight-light': {
    status: 'ported',
    differences: [
      'Colours match the web dashboard.',
      'In the first full run this GPUIX launch crashed to "Uncaught runtime errors: Timed out after 2 seconds waiting for the automation bounds query" (compat live-reads from a tanstack-virtual resize); the rerun booted cleanly, so the crash is intermittent.'
    ],
    cause: 'needs diagnosis',
    unit: 'C13 live-read timeout under load',
    impact: 1
  }
}
