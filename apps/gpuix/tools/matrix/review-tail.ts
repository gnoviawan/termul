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
    status: 'ported',
    differences: [
      "Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both).",
      "The zoomed web page ends at the window bottom with its status bar in view, as GPUIX does (G17 WEB-ZOOM). The web's CSS zoom fallback had grown `h-screen` with the factor (880 px in the 800 px window) and opened context menus and dropdowns 1.1 times their place (a context menu at 62,259 for a press at 54,235); `applyUiZoom` now publishes `--ui-zoom` and index.css divides it back out of `h-screen`, `h-dvh`, `w-screen` and the Radix popper wrapper. `tools/parity/web-zoom-check.ts` failed 3 of 4 checks before and passes 4 of 4: page 800 px tall, the menu at 56,235, the Workspace dropdown at its trigger's left, 4.4 px under it.",
      LAYOUT_FOCUS
    ]
  },

  'shortcuts.desktop-keymap': {
    status: 'ported',
    differences: [
      'Reference (R5): the web client with the desktop table bound as custom keys, as a web user can set them in Keyboard shortcuts; GPUIX presses the same keys with its default (desktop) keymap. Headless Chromium hands Ctrl+T, Ctrl+W and Ctrl+R to the page.',
      'Every key does the same in both: Ctrl+T shows the agent launcher over Terminal 1 and a second Ctrl+T hides it, Ctrl+W asks to close Terminal 1 and Close removes it, Ctrl+R opens Command History, Ctrl+, opens Preferences and Ctrl+= zooms in.',
      'In the last frame both zoomed pages end at the window bottom with the status bar in view (G17 WEB-ZOOM, see shortcuts.zoom-in).'
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
    status: 'ported',
    differences: [
      'Both clients are host-local, as the launched app is. Both list the two seeded hosts in the sidebar SSH section, with the build-box favourite first.',
      'The Hosts tab matches: the search field, Import and New host, and the Favorites and Servers groups with the same rows.',
      'The New host dialog sets Address and Port on one row in both (G15: compat lays a `grid-cols-[1fr_6rem]` grid out as flex rows with one cell per track). Typing goes to the autofocused Address field and the preview reads user@db.example.com in both.',
      "Each field label sits over its input as on the web (G16 LABEL-STRUT): the Address input's top border is at 241 px in both, and the label's ink 2 px higher than the web's (224 to 232 px against 226 to 234 px); it was 6 px lower, and the Organize section started lower with it. Two causes: `space-y-1.5` gives the label a bottom margin, which CSS ignores on an inline box and compat had kept as the column's gap, and the label's strut line now takes the line height its container inherits (`FontContext`) instead of the root's 24 px. The web also rings the focused Address field; GPUIX lightens its border only.",
      'I6 measured it in the full run on the patched addon (series 2fc3aff4), both clients host-local.'
    ]
  },
  'settings.accounts-claude': {
    status: 'ported',
    differences: [
      'Both clients are host-local. Both show Add account, the Keep work and personal apart card, and the Add a Claude account dialog with the name typed. The run stops before Continue, which would start a real claude.ai sign-in on the host.',
      "The account row lays out as on the web (G16 ACCOUNT-ROW): its grid places its cells (`col-start-*`, `row-start-*`), and the patched addon now draws its `13.75rem minmax(0,1fr) 8.25rem 1.75rem` track list and the placements natively (zed/0008, gpuix/0019). The usage note starts at 637 px and the row menu's dots at 1099 px, as on the web; they were at 584 px and 1029 px on four equal tracks. The row keeps its 70 px height.",
      'The patched addon paints the Add a Claude account dialog over Preferences as on the web (I6: 0.18 % full-frame perceptual on the last step; G15 read 2.88 % on the published addon, which does not paint it).',
      'I6 measured it in the full run on the patched addon (series 2fc3aff4), both clients host-local.'
    ]
  },
  'settings.interface': {
    status: 'ported',
    differences: [
      ...SETTINGS_BASE,
      'The Interface zoom hint wraps one token later in GPUIX ("Alt+- and Alt" / "+0 also work." against the web\'s "Alt+- and" / "Alt+0 also work."): GPUI breaks after a "+", where Chromium keeps "Alt+0" whole (I6 run, cosmetic).'
    ]
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
      ...SETTINGS_BASE,
      SELECT,
      'The agents list shows the registry as on the web, Agoragentic first with its icon, version, Latest and Available. The icon tile draws the catalog SVG: AcpAgentsSettings sets it through `dangerouslySetInnerHTML`, compat paints one `<svg>` of markup as a GPUIX svg, and the DOMPurify stand-in passes an icon of shapes (G16 SVG-HTML).',
      'The list fills in when the section\'s own catalog request returns, 0.42 s after the section mounted in GPUIX on an idle host (D2 run). Until then both clients show the Loading agents… spinner card (L2); before L2 they read `No agents match ""` with a Clear filter button, which the G16 and N3 runs grabbed. A failed catalog request retries after 1, 2, 4, 8 and 16 s, then shows Couldn\'t load agents with Retry (L2). The step waits for Agoragentic (D2).',
      'M5: in 2 of 3 GPUIX runs on the same head (the full run and one of two reruns, load average 8 to 11) the list loaded, the Agoragentic check passed after 1.6 s, and the frame grabbed after it shows the Loading agents… card again. The web frame shows the list in every run. Loading with entries already shown is the retry state of `useResolvedSupportedAcpAgentsState` (86901fef, after L2): a later catalog resolve in GPUIX returned `catalogAvailable: false` and the card waits for the 1 s retry. Why that resolve fails in GPUIX and not on the web is not measured.',
      DIVIDERS,
      LABEL_LINE
    ],
    cause: 'needs diagnosis',
    unit: 'catalog re-resolve failure in GPUIX (unassigned)',
    impact: 1
  },
  'settings.skills': {
    status: 'ported',
    differences: [...SETTINGS_BASE, DIVIDERS, HALF_PX_LINES]
  },
  'settings.provider': {
    status: 'ported',
    differences: [
      'Accounts lists the Default account, Signed in, with "Usage is not available right now", Try again and the `termul-server claude account` hint in both. The skeleton M2 saw was the frame grab racing the list: the step checked for the nav label it had just clicked. It now waits for "1 account", which GPUIX painted 1871 ms after the click and the web 158 ms after (G6 run).',
      'The Claude Code header shows its brand mark as on the web (G16 SVG-HTML: ProviderGroupHeader sets the bundled SVG through `dangerouslySetInnerHTML`).',
      "The account row lays out as on the web (G16 ACCOUNT-ROW): its grid places its cells (`col-start-*`, `row-start-*`), and the patched addon now draws its `13.75rem minmax(0,1fr) 8.25rem 1.75rem` track list and the placements natively (zed/0008, gpuix/0019). The usage note starts at 637 px and the row menu's dots at 1099 px, as on the web; they were at 584 px and 1029 px on four equal tracks. The row keeps its 70 px height.",
      SETTINGS_BASE[1]
    ]
  },
  'settings.mcp-servers': {
    status: 'ported',
    differences: [
      ...SETTINGS_BASE,
      'The footnote reads on one line with its inline `mcpCapabilities.acp` as on the web (G16 CODE-WRAP: SettingsGroup gets the footnote as one fragment, which compat had laid out as a block of three lines; a lone fragment child is now its children, inline content of the paragraph).'
    ]
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
    status: 'ported',
    differences: [
      'Reference: the desktop app (Tauri on WebKitGTK) built from the same checkout, driven with X input at the same 1280x800 (`tools/reference/tauri.ts`). Ctrl+Shift+N opens a browser tab in both and the typed URL loads the local reference page on the same pixels; the pane region reads 0.71 % perceptual.',
      "The URL bar ends with the agentation button only, as in the desktop app: the GPUIX bundle defines Vite's PROD, DEV and MODE (G15), so the dev-only Debug Console is gone.",
      "The agentation toolbar's round button sits at the page's bottom right in both: the webview helper injects the desktop's toolbar bundle when each browsed page has loaded (G15). GPUIX has no annotation service, so its toolbar keeps annotations in the page.",
      "Both tabs read the page title, R5 reference page (G17 DESKTOP-TITLES). The desktop's page poller reports the title over Tauri IPC, which the capability file grants only to the main window, so a remote page's title never arrived and the desktop tab read 127.0.0.1:8289. The tab webview now takes WebKit's title-changed signal in Rust (`on_document_title_changed` in browser_tab_manager.rs, tested in browser_tab_manager_tests.rs) and emits the event the renderer already listens for. Measured with the desktop app built from gpuix/g17 at c12eed3a (`TERMUL_TAURI_BIN`).",
      'The desktop app draws its own window buttons at the right of the tab bar; GPUIX leaves them to the window manager. Both rails show the SSH section now that GPUIX is host-local; the desktop has no seeded chat.',
      'I6 measured it in the full run on the patched addon (series 2fc3aff4), both clients host-local.'
    ]
  },
  'update.toast': {
    status: 'ported',
    differences: [
      "Reference: the desktop app (`tools/reference/tauri.ts`), both clients on the nightly channel against the real release feeds, with a last-seen version of 0.4.51 (`stores` in the surface). Both open What's New for 0.4.52 with its GitHub notes and toast Nightly update available, Version 0.5.0-nightly…, with Remind me tomorrow and Open download page. Remind me tomorrow closes the toast and Got it the modal in both.",
      "GPUIX runs the shared updater through the desktop host seam (U1, `src/renderer/lib/desktop-app.ts`): it reads the channel manifest itself, every channel opens the download page and nothing is downloaded or installed. The notes paint as native markdown (`overrides/components/WhatsNewNotes.tsx`), since the web's sanitized HTML goes through `dangerouslySetInnerHTML`. The desktop reserves a scrollbar beside the notes, so its lines wrap a word earlier.",
      'The toast lays its icon beside the title, as sonner does: the GPUIX toaster resolves the percentage in `basis-[calc(100%-28px)]` against the card (U1; it had dropped the class and put the icon on its own row). Its buttons now close the toast as sonner does. The desktop sets the toast in WebKitGTK\'s system-ui font, where Chromium and GPUIX use Arial (Liberation Sans), so the description wraps after "Open the" on the desktop and after the version in GPUIX; and WebKitGTK paints both toast buttons white (sonner\'s defaults), where the web and GPUIX use the secondary and primary fills.',
      'The desktop composer shows Codex timing out instead of the Chat Scenario Agent, has no seeded chat, and draws its own window buttons (as in browser.pane).'
    ]
  },

  'snapshots.page': {
    status: 'ported',
    differences: [
      'Both clients start on #/snapshots, the web by URL and GPUIX through GPUIX_START_HASH; no desktop shell links to the route (only the mobile drawer). The header, Create New Snapshot and the Create Snapshot dialog match.',
      'The empty state paints as on the web: the camera, No snapshots yet at 271 px against 270 px, and Create First Snapshot (G15). The page\'s `<main className="flex-1 flex flex-col">` sits in a block parent, so CSS sizes it to its content and resolves the list\'s `flex-1` 0% basis as content; GPUIX had taken basis 0 literally and clipped the list to its 48 px padding. Compat now drops the zero basis of a lone growing child in a column with no height, min height or clipping.',
      'I6 measured it in the full run on the patched addon (series 2fc3aff4), both clients host-local.'
    ]
  },
  'theme.tokyonight-light': {
    status: 'ported',
    differences: [
      'Background, panel, card, border, text and accent colours match the web dashboard.',
      'The differences left are not the theme.'
    ]
  }
}
