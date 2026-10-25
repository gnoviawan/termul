/** Reviews for settings, palette, shortcuts, themes and the long tail (see `review.ts`). */

import type { Review } from './review'
import { BACKDROP, SELECT, SETTINGS_BASE, TOAST } from './review-phrases'

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
          'The differences left are not the theme.'
        ]
      }
    ])
  )
)

export const TAIL_REVIEWS: Record<string, Review> = {
  ...THEME_REVIEWS,
  'palette.type-ahead': {
    status: 'partial',
    differences: [
      'Typing "theme" straight after Ctrl+K filters the palette in both, and the rows rank the same (C16 fixed in G3: the cmdk shim scores with cmdk\'s command-score and sorts as cmdk does), Open Canvas first under Workspace.',
      'The step races in both clients: in some runs the web drops the first key ("heme") and in some GPUIX does (an empty filter); GPUIX failed this check in 5 of 9 G3 runs, 3 of 6 with the C16 change and 2 of 3 without it.',
      'The GPUIX search field has no focus underline.'
    ],
    cause: 'compat translator gap',
    unit: 'focus ring on focused fields (unassigned)',
    impact: 1
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
    differences: ['The Create Snapshot modal matches.', BACKDROP],
    cause: 'missing GPUIX capability',
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
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.app-preferences': {
    status: 'partial',
    differences: ['Preferences opens on Interface.', BACKDROP],
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.switch-project': {
    status: 'ported',
    differences: ['Typing beta filters to the beta row and Enter switches to beta in both.']
  },
  'palette.command-history': {
    status: 'partial',
    differences: [
      'The Command History modal, its scope picker and empty state match.',
      BACKDROP,
      'No focus ring on the search field.'
    ],
    cause: 'missing GPUIX capability',
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
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'palette.report-bug': {
    status: 'partial',
    differences: ['Opens the Report a bug dialog, laid out as in dialogs.bug-report.'],
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
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
    status: 'partial',
    differences: [
      'Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4\'s keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both).',
      'The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window.'
    ],
    cause: 'needs diagnosis',
    unit: 'web zoom overflow (unassigned)',
    impact: 1
  },

  'shortcuts.desktop-keymap': {
    status: 'blocked',
    differences: [
      'No web reference. GPUIX registers a desktop host, which now gets the same Ctrl-based keymap as Tauri (G4): workspace-checks asserts Ctrl+, opens Preferences, Ctrl+R opens command history and Alt+, does nothing.'
    ]
  },

  'notifications.toast': {
    status: 'ported',
    differences: [
      'Typing the branch name and pressing Enter creates toast-branch and shows the success toast in both.',
      TOAST
    ]
  },

  'ssh.workspace': {
    status: 'blocked',
    differences: [
      'No web reference: SSH needs a host-local client and a browser never is one, so the web client shows no SSH section.',
      'R2 drove the GPUIX real shell as a host-local client against a throwaway sshd (reports/r2-shots): the sidebar SSH section, the hosts tab, host-key trust, a connected shell and the SFTP file list all render.',
      'The SFTP Modified column wrapped times such as 12:26 AM onto two lines in gpuix-ssh-connected.png, and Chromium wraps them too: the tabular-figure time is 57 px in a w-14 (56 px) column. G3 widened the shared column to w-16 in SftpEntryRow, a web fix (C14).'
    ]
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
    cause: 'missing GPUIX capability',
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
    unit: 'settings row layout (unassigned)',
    impact: 1
  },
  'settings.editor': {
    status: 'partial',
    differences: [SELECT, ...SETTINGS_BASE.slice(1)],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'settings.appearance': {
    status: 'partial',
    differences: [
      SELECT,
      'Renderer and Scrollback descriptions now wrap normally beside the closed select.',
      ...SETTINGS_BASE.slice(1)
    ],
    cause: 'compat translator gap',
    unit: 'C9 dialog body layout',
    impact: 1
  },
  'settings.shell': {
    status: 'partial',
    differences: [SELECT, ...SETTINGS_BASE.slice(1)],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'settings.terminal-profiles': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'settings.ai-agents': {
    status: 'partial',
    differences: [
      SELECT,
      'The agents list shows No agents match while the web lists the registry.', 'The rows lay out beside their selects once the settings card has measured itself; on a loaded host the frame can be grabbed before that (the first frame lays container queries out narrow), so the Close idle chats after row shows stacked with a full-width select in some runs (2 of 3 in G5).'
    ],
    cause: 'compat translator gap',
    unit: 'C9 dialog body layout',
    impact: 1
  },
  'settings.skills': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'settings.provider': {
    status: 'partial',
    differences: [...SETTINGS_BASE, 'The usage line moves under the account instead of beside it.'],
    cause: 'compat translator gap',
    unit: 'settings row layout (unassigned)',
    impact: 1
  },
  'settings.mcp-servers': {
    status: 'partial',
    differences: [...SETTINGS_BASE, 'The inline code in the footnote breaks onto its own line.'],
    cause: 'compat translator gap',
    unit: 'settings row layout (unassigned)',
    impact: 1
  },
  'settings.shortcuts': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'settings.diagnostics': {
    status: 'partial',
    differences: [
      ...SETTINGS_BASE,
      'Server version reads termul-server v0.4.52 in both: GPUIX asks the server (G4).'
    ],
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },

  'settings.reset': {
    status: 'partial',
    differences: SETTINGS_BASE,
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'shortcuts.menu': {
    status: 'partial',
    differences: [
      'Shortcut Menu rows, descriptions and key chips match, including the blank Command History chip in both.',
      BACKDROP
    ],
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'shortcuts.settings-shortcut': {
    status: 'ported',
    differences: [
      'Each client presses its own key (G3): Alt+, on the web and the desktop Ctrl+, in GPUIX (G4 keymap) open Preferences, and Escape closes it in both.'
    ]
  },

  'theme.picker': {
    status: 'partial',
    differences: [
      'The Color Themes popover, groups, swatches and the current-theme check match, and labels antialias in grayscale as on the web (C8 fixed in G3).',
      'No focus ring on the search field.'
    ],
    cause: 'compat translator gap',
    unit: 'focus ring on focused fields (unassigned)',
    impact: 1
  },
  'dialogs.bug-report': {
    status: 'partial',
    differences: [
      'The Report a bug dialog paints its Title, What happened, Screenshots and Preview sections at the web width and wraps the same lines.',
      'The Title field opens focused with a ring on the web and unringed in GPUIX.',
      'The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp.'
    ],
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
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
      "Not compared: the update toast and the what's new modal render only under isTauriContext(), so neither client shows them (the web hides them by design). GPUIX shows its version like the web (Preferences, Logs: termul-server v0.4.52). A GPUIX update check against the release feed is not built yet."
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
