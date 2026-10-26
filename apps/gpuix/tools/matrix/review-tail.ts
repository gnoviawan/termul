/** Reviews for settings, palette, shortcuts, themes and the long tail (see `review.ts`). */

import type { Review } from './review'
import {
  BLUR,
  COMPOSER_PICK,
  DIVIDERS,
  FIELD_FOCUS,
  HALF_PX_LINES,
  LABEL_LINE,
  LAYOUT_FOCUS,
  SELECT,
  SETTINGS_BASE,
  TOAST
} from './review-phrases'

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
    status: 'ported',
    differences: [
      'Typing "theme" straight after Ctrl+K filters the palette in both, and the rows rank the same (C16 fixed in G3: the cmdk shim scores with cmdk\'s command-score and sorts as cmdk does), Open Canvas first under Workspace.',
      'GPUIX is deterministic (G5): keys typed after the palette input took focus but before it first painted focused, which GPUI drops for want of a text input handler, are held and given to the field on its focus event. It passed 7 of 7 G5 runs, where it had failed 3 of 5 with the window active (an empty filter).',
      'The web still races: CommandPalette blurs the active element and focuses its input in a setTimeout(0), so keys that beat that timeout are dropped ("eme" in 2 of 12 G5 runs). That is a real web bug a fast typist can hit, not a harness artifact.',
      'The search field shows its focus underline as on the web (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events).'
    ]
  },
  'palette.new-terminal': {
    status: 'ported',
    differences: [
      'New Terminal opens Terminal 1 in both.',
      'A focused terminal blinks its cursor in both, so a frame shows the block or not by timing.',
      "M2's terminal-limit frame showed the GPUIX error toast too narrow for its message: the text runs past the window edge, where the web toast wraps to two lines. M3 hit no limit, so that toast was not seen again."
    ]
  },
  'palette.open': {
    status: 'ported',
    differences: [
      'Ctrl+K opens the palette, typing "theme" filters it to the same groups and rows in both, and Escape closes it.',
      "The Agent Launcher row's chip reads ctrl+t in GPUIX and alt+t on the web (the G4 desktop keymap).",
      BLUR
    ]
  },
  'palette.agent-launcher': {
    status: 'ported',
    differences: ['Agent Launcher shows the launcher with its close button in both.']
  },
  'palette.save-snapshot': {
    status: 'ported',
    differences: ['The Create Snapshot modal matches.', BLUR]
  },
  'palette.open-canvas': {
    status: 'ported',
    differences: [
      'Open Canvas opens design.figcraft in both, and the FigCraft editor reaches Ready in GPUIX through the browser-pane webview (V1) with the pinned bundle (run with `tools/canvas/server-with-bundle.ts`).',
      'The editor is dark in both, page colour 1E1E1E (G6: the webview helper starts on the dark GTK theme while Termul is dark, so WebKitGTK reports prefers-color-scheme dark before host.theme arrives).'
    ]
  },
  'palette.project-settings': {
    status: 'ported',
    differences: ['Project settings opens on General with the same fields.', BLUR]
  },
  'palette.app-preferences': {
    status: 'ported',
    differences: [
      'Preferences opens on Interface in both, laid out wide.',
      BLUR,
      'M3 matched in its full run. M2 saw two flakes here: the automation bounds-query timeout (C13) and a frame grabbed at the container-query first layout, before the card measured itself.'
    ]
  },
  'palette.switch-project': {
    status: 'ported',
    differences: [
      'Typing beta filters to the beta row and Enter switches to beta in both.',
      COMPOSER_PICK
    ]
  },
  'palette.command-history': {
    status: 'ported',
    differences: [
      'The Command History modal, its scope picker and empty state match, and the search field shows its focus border in both.',
      BLUR
    ]
  },
  'palette.color-theme': {
    status: 'ported',
    differences: ['Change Color Theme opens the Color Themes popover in both.', FIELD_FOCUS]
  },
  'palette.shortcut-menu': {
    status: 'ported',
    differences: [
      'Opens the Shortcut Menu in both; GPUIX shows the desktop keymap chips (see shortcuts.menu).',
      BLUR
    ]
  },
  'palette.report-bug': {
    status: 'ported',
    differences: [
      'Opens the Report a bug dialog, laid out as in dialogs.bug-report.',
      BLUR,
      FIELD_FOCUS
    ]
  },
  'shortcuts.toggle-projects': {
    status: 'ported',
    differences: [
      'Ctrl+Shift+B collapses the rail in both, with the Open canvas pencil under Search (see rail.collapse).',
      LAYOUT_FOCUS
    ]
  },
  'shortcuts.toggle-side-panel': {
    status: 'ported',
    differences: ['Ctrl+B hides the side panel in both.', LAYOUT_FOCUS]
  },
  'shortcuts.theme-picker': {
    status: 'ported',
    differences: ['Ctrl+Alt+T opens the Color Themes popover in both.', FIELD_FOCUS]
  },
  'shortcuts.zoom-in': {
    status: 'partial',
    differences: [
      "Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both).",
      'The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window.',
      LAYOUT_FOCUS
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
      TOAST,
      'After Enter the status-bar branch button holds focus and both draw a 1 px ring around "toast-branch" (G6: an outer ring paints as an outline; GPUI had painted the spread shadow under the whole transparent button, a light wash over the label).'
    ]
  },

  'ssh.workspace': {
    status: 'blocked',
    differences: [
      'No web reference: SSH needs a host-local client and a browser never is one, so the web client shows no SSH section.',
      'R2 drove the GPUIX real shell as a host-local client against a throwaway sshd (reports/r2-shots): the sidebar SSH section, the hosts tab, host-key trust, a connected shell and the SFTP file list all render. Not rerun here.'
    ]
  },
  'settings.accounts-claude': {
    status: 'blocked',
    differences: [
      'No web reference: Claude account management needs a host-local client. The R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path; no GPUIX pixel check of the sign-in flow exists yet.'
    ]
  },
  'settings.interface': {
    status: 'ported',
    differences: SETTINGS_BASE
  },
  'settings.notifications': {
    status: 'ported',
    differences: [...SETTINGS_BASE, DIVIDERS, LABEL_LINE]
  },
  'settings.editor': {
    status: 'ported',
    differences: [SELECT, SETTINGS_BASE[1], DIVIDERS, LABEL_LINE]
  },
  'settings.appearance': {
    status: 'ported',
    differences: [SELECT, SETTINGS_BASE[1], DIVIDERS, LABEL_LINE]
  },
  'settings.shell': {
    status: 'ported',
    differences: [SELECT, SETTINGS_BASE[1]]
  },
  'settings.terminal-profiles': {
    status: 'ported',
    differences: SETTINGS_BASE
  },
  'settings.ai-agents': {
    status: 'partial',
    differences: [
      SELECT,
      'The agents list shows No agents match "" while the web lists the registry (Agoragentic first).',
      DIVIDERS,
      LABEL_LINE,
      SETTINGS_BASE[1]
    ],
    cause: 'needs diagnosis',
    unit: 'agent registry list in settings (unassigned)',
    impact: 2
  },
  'settings.skills': {
    status: 'ported',
    differences: [...SETTINGS_BASE, DIVIDERS, HALF_PX_LINES]
  },
  'settings.provider': {
    status: 'partial',
    differences: [
      'Accounts lists the Default account, Signed in, with "Usage is not available right now", Try again and the `termul-server claude account` hint in both. The skeleton M2 saw was the frame grab racing the list: the step checked for the nav label it had just clicked. It now waits for "1 account", which GPUIX painted 1871 ms after the click and the web 158 ms after (G6 run).',
      'GPUIX puts the usage note under the account name, where the web sets it beside the name in the wide layout.',
      SETTINGS_BASE[1]
    ],
    cause: 'compat translator gap',
    unit: 'account row wide layout (unassigned)',
    impact: 1
  },
  'settings.mcp-servers': {
    status: 'partial',
    differences: [...SETTINGS_BASE, 'The inline code in the footnote breaks onto its own line.'],
    cause: 'compat translator gap',
    unit: 'inline code wrap in settings text (unassigned)',
    impact: 1
  },
  'settings.shortcuts': {
    status: 'ported',
    differences: [
      ...SETTINGS_BASE,
      DIVIDERS,
      HALF_PX_LINES,
      'GPUIX lists the desktop keymap (Ctrl+R, Ctrl+T, Ctrl+,) where the web lists its defaults (Press keys…, Alt+T, Alt+,), by design since G4.'
    ]
  },
  'settings.diagnostics': {
    status: 'ported',
    differences: [
      ...SETTINGS_BASE,
      DIVIDERS,
      HALF_PX_LINES,
      'Server version reads termul-server v0.4.52 in both: GPUIX asks the server (G4).'
    ]
  },

  'settings.reset': {
    status: 'ported',
    differences: SETTINGS_BASE
  },
  'shortcuts.menu': {
    status: 'ported',
    differences: [
      'Shortcut Menu rows, descriptions and key chips line up. GPUIX shows the desktop keymap chips (Ctrl+R, Ctrl+,, Ctrl+=) where the web shows its Alt defaults and a blank Command History chip (G4, by design).',
      BLUR
    ]
  },
  'shortcuts.settings-shortcut': {
    status: 'ported',
    differences: [
      'Each client presses its own key (G3): Alt+, on the web and the desktop Ctrl+, in GPUIX (G4 keymap) open Preferences, and Escape closes it in both.'
    ]
  },

  'theme.picker': {
    status: 'ported',
    differences: [
      'The Color Themes popover, groups, swatches and the current-theme check match, and labels antialias in grayscale as on the web (C8 fixed in G3).',
      FIELD_FOCUS
    ]
  },
  'dialogs.bug-report': {
    status: 'ported',
    differences: [
      'The Report a bug dialog paints its Title, What happened, Screenshots and Preview sections at the web width and wraps the same lines. The web draws a resize grip in the What happened corner; GPUIX has none.',
      FIELD_FOCUS,
      BLUR
    ]
  },
  'canvas.open': {
    status: 'ported',
    differences: [
      'Clicking Canvas opens design.figcraft and the FigCraft editor reaches Ready in both: pages, layers, design panel, toolbar and Save (V1: the editor runs in a `termul-webview-host` webview placed over the pane; this run used the pinned bundle, sha256 verified against canvas/figcraft.pin).',
      'Panels and page are dark in both, page colour 1E1E1E (G6, see palette.open-canvas).'
    ]
  },
  'browser.pane': {
    status: 'blocked',
    differences: [
      'Not compared: the web client offers no browser tab, so there is no reference. GPUIX does have browser panes, a WebKitGTK webview in the `termul-webview-host` helper placed as an X11 child window (README, Browser panes), and `bun run package:verify` loads a local page in one from the .deb; neither was rerun here.'
    ]
  },
  'update.toast': {
    status: 'blocked',
    differences: [
      "Not compared: the update toast and the what's new modal render only under isTauriContext(), so neither client shows them (the web hides them by design). The packaged GPUIX app has a command-line check, `termul-gpuix --check-update`, against the release feed, but no in-app toast."
    ],
    cause: 'native override needed',
    unit: "U1 GPUIX updater and what's new",
    impact: 1
  },

  'theme.tokyonight-light': {
    status: 'ported',
    differences: [
      'Background, panel, card, border, text and accent colours match the web dashboard.',
      'The differences left are not the theme.'
    ]
  }
}
