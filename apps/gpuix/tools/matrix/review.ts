/**
 * The reviewed verdict for each surface, written after looking at its web and
 * GPUIX frames. A review overrides the automatic status; `differences` lists
 * what a user would see or feel, and `cause` and `unit` feed the ranked gap
 * list. Surfaces without a review report their automatic status.
 */

import type { Status } from './weights'

export type GapClass =
  | 'compat translator gap'
  | 'missing GPUIX capability'
  | 'native override needed'
  | 'server route needed'
  | 'blocked upstream'
  | 'needs diagnosis'

export interface Review {
  status: Status
  differences: string[]
  cause?: GapClass
  unit?: string
  /** 3: blocks the task or looks broken; 2: visibly off or slower to use; 1: cosmetic. */
  impact?: 1 | 2 | 3
}

const LAMP =
  'The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored).'
const RIGHT_CLICK =
  'Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike.'

const TITLE_TIP =
  'A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame.'
const CHECKBOX =
  'The Amend last commit checkbox box is not drawn (native checkbox input), only its label.'
const BACKDROP =
  'The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable.'
const OVERLAY =
  'the modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable.'
const OVERLAP =
  'In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three.'
const PROSE =
  'Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule.'
const TREE_TEXT =
  'The text check fails only because natively painted text is not in the automation tree.'
const TINT =
  'Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have).'
const SELECT =
  'Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown.'
const TAB_TRUNC =
  'Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart.'
const SHORT_TRANSCRIPT =
  'A short transcript sits at the bottom of the GPUIX pane, leaving the space above it empty, where the web starts it at the top.'
const TAB_TITLE =
  'The GPUIX tab title truncates to a few letters ("matr...") where the web shows the whole title.'
const ENTER =
  "Enter in a text field or list does not run the field's action in GPUIX (form submit, command palette selection), while Enter in the chat composer does."
const SETTINGS_BASE = [
  'The section content and navigation match.',
  'The modal backdrop is far lighter than the web bg-overlay.',
  TINT
]
const TOAST =
  'The toast is the sonner shim: a flat green box at the window edge with the close button on the right, where the web shows a card with a check icon and the close button at its top-left.'

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

export const REVIEWS: Record<string, Review> = {
  'rail.project-list': {
    status: 'ported',
    differences: ['Same layout and order; switching to beta works by click.', LAMP]
  },
  'rail.project-menu': {
    status: 'broken',
    differences: [RIGHT_CLICK],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 3
  },
  'rail.project-rename': {
    status: 'broken',
    differences: [
      RIGHT_CLICK,
      'With no menu, the replayed clicks land on the row and the typed name goes into the composer instead.'
    ],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 2
  },
  'rail.project-remove': {
    status: 'broken',
    differences: [RIGHT_CLICK, 'No delete confirmation, so the project stays.'],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 2
  },
  'rail.project-colour': {
    status: 'broken',
    differences: [RIGHT_CLICK, 'The Select Color popover never appears.'],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 1
  },
  'rail.project-reorder': {
    status: 'broken',
    differences: [
      'Dragging gamma onto alpha reorders the web list to alpha, gamma, beta; GPUIX keeps alpha, beta, gamma. D1 emulates HTML5 drag and drop, but the rail reorders through framer-motion Reorder pointer gestures, which the framer-motion shim does not drive.'
    ],
    cause: 'compat translator gap',
    unit: 'C3 framer-motion Reorder drag',
    impact: 1
  },
  'rail.add-menu': {
    status: 'broken',
    differences: [
      'Clicking + shows only its tooltip; the New project / New folder group dropdown does not open, so the new project modal is unreachable from the rail.'
    ],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 3
  },
  'rail.collapse': {
    status: 'ported',
    differences: ['Collapsed rail matches: icons, project letters, Changes badge.', LAMP]
  },
  'rail.project-settings': {
    status: 'broken',
    differences: [
      'The gear on the hovered row shows, but clicking it does not open Project settings (also fails with real X input).'
    ],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 2
  },
  'side.chats': {
    status: 'partial',
    differences: [
      'With the one seeded chat, the card title, agent, branch and age match.',
      'Every later frame, once chat.send has started more chats, shows the overlap: ' + OVERLAP
    ],
    cause: 'needs diagnosis',
    unit: 'O7 chat list sync and layout',
    impact: 3
  },
  'side.chats-search': {
    status: 'ported',
    differences: ['Filtering to no match and back matches, including the No matches. text.']
  },
  'side.chat-card-menu': {
    status: 'broken',
    differences: [RIGHT_CLICK],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 2
  },
  'side.workspace-switcher': {
    status: 'ported',
    differences: [
      'The Working copies popover matches; GPUIX omits the small terminal glyph on the web row hover.'
    ]
  },
  'side.hide': {
    status: 'ported',
    differences: ['Side panel hides; the expand chevron sits in the same place.']
  },
  'explorer.tree': {
    status: 'ported',
    differences: ['Tree, git colours and status letters match.']
  },
  'explorer.expand': {
    status: 'partial',
    differences: [
      TITLE_TIP + ' It covers the chevron and the open-folder icon of the expanded row.'
    ],
    cause: 'compat translator gap',
    unit: 'C4 tooltips',
    impact: 1
  },
  'explorer.context-menu': {
    status: 'broken',
    differences: [RIGHT_CLICK],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 2
  },
  'explorer.drag': {
    status: 'ported',
    differences: [
      'Dragging notes.txt from the tree into the pane opens it in an editor tab in both (D1 compat drag and drop).'
    ]
  },
  'editor.code': {
    status: 'ported',
    differences: [
      'The native editor (E1) paints the same highlighted text, line numbers and active line; the text checks fail only because native text is painted inside GPUI and is not in the automation tree.'
    ]
  },
  'editor.code-edit': {
    status: 'ported',
    differences: [
      'Click, End and typing put "// edited" on line 5 in both; the dirty dot shows on the tab. Same tree-text caveat as editor.code.'
    ]
  },
  'editor.markdown': {
    status: 'partial',
    differences: [
      'Preview renders, but the "On this page" outline column is missing (still missing at fce9a3e2, after D1 brought EditorTocLayout back), headings are smaller and paragraph spacing is tighter.',
      'The tab title truncates to "guid..." where the web shows "guide.md".',
      TITLE_TIP
    ],
    cause: 'native override needed',
    unit: 'E2 markdown preview parity',
    impact: 2
  },
  'editor.tabs': {
    status: 'partial',
    differences: [
      'Switching tabs works; README preview shows the same outline and typography gaps as editor.markdown, and the tab title truncates to "READ...".'
    ],
    cause: 'native override needed',
    unit: 'E2 markdown preview parity',
    impact: 1
  },
  'git.changes': {
    status: 'partial',
    differences: ['Sections, rows, counts and history footer match.', CHECKBOX],
    cause: 'compat translator gap',
    unit: 'C5 form controls',
    impact: 1
  },
  'git.diff': {
    status: 'partial',
    differences: ['Inline diff, hunk header and STAGE HUNK match closely.', CHECKBOX],
    cause: 'compat translator gap',
    unit: 'C5 form controls',
    impact: 1
  },
  'git.stage': {
    status: 'partial',
    differences: ['Staging README.md moves it to Staged 2 in both.', CHECKBOX]
  },
  'git.unstage': {
    status: 'partial',
    differences: ['Unstaging app.ts moves it to Changes in both.', CHECKBOX]
  },
  'git.discard': {
    status: 'partial',
    differences: ['The confirm dialog matches, but ' + OVERLAY],
    cause: 'compat translator gap',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'git.commit': {
    status: 'partial',
    differences: ['The commit lands (4 commits, bump version) in both.', TOAST],
    cause: 'native override needed',
    unit: 'O4 toasts',
    impact: 1
  },
  'git.branch-picker': {
    status: 'ported',
    differences: ['Branch popover, Local group, feature/login and Create branch row match.']
  },
  'git.worktree-create': {
    status: 'ported',
    differences: [
      'Typing a new name shows No matching working copies and Create worktree feat-matrix in both.'
    ]
  },
  'chat.transcript': {
    status: 'partial',
    differences: [
      'The transcript, code card, task list, Worked for row and Changed files bar all render.',
      PROSE,
      TREE_TEXT
    ],
    cause: 'native override needed',
    unit: 'O5 native prose styling',
    impact: 3
  },
  'chat.scroll-top': {
    status: 'broken',
    differences: [
      'One wheel event of -20000 px over the transcript scrolls the web to the first turn; GPUIX stays at the bottom. chat:check scrolls through its control file, so wheel scrolling in the full app is not covered elsewhere.'
    ],
    cause: 'needs diagnosis',
    unit: 'O6 transcript scroll and anchoring',
    impact: 3
  },
  'chat.new-chat': {
    status: 'ported',
    differences: ['New chat opens the launcher composer in place.']
  },
  'chat.agent-launcher': {
    status: 'broken',
    differences: [
      'Opening the agent and model popover crashes the pane: its error boundary shows "Something went wrong in Terminal Pane: GPUIX host node does not belong to a root". The web shows the model search popover.'
    ],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 3
  },
  'chat.send': {
    status: 'partial',
    differences: [
      'Typing and Enter start a chat and the scripted reply streams in both.',
      'Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram.',
      PROSE,
      OVERLAP
    ],
    cause: 'needs diagnosis',
    unit: 'O7 chat list sync and layout',
    impact: 3
  },
  'chat.model-selector': {
    status: 'partial',
    differences: [
      'The running chat shows the agent chip and composer like the web.',
      OVERLAP,
      PROSE
    ],
    cause: 'needs diagnosis',
    unit: 'O7 chat list sync and layout',
    impact: 2
  },
  'composer.mention': {
    status: 'ported',
    differences: [
      'Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it).',
      'The web draws a focus ring on the composer; GPUIX does not.'
    ]
  },
  'composer.slash': {
    status: 'ported',
    differences: ['The Skills menu matches row for row.', 'No focus ring on the GPUIX composer.']
  },
  'composer.attach': {
    status: 'ported',
    differences: [
      'Clicking Attach files opens nothing visible in either client in this headless run (the web file chooser is a native dialog Playwright does not paint).'
    ]
  },
  'terminal.open': {
    status: 'partial',
    differences: ['Terminal tab and prompt match.', TAB_TRUNC],
    cause: 'compat translator gap',
    unit: 'C15 tab title width',
    impact: 2
  },
  'terminal.type': { status: 'ported', differences: ['echo output matches cell for cell.'] },

  'terminal.file-link': {
    status: 'ported',
    differences: [
      'Ctrl+click on src/app.ts in terminal output opens app.ts in a new tab in both.',
      TREE_TEXT
    ]
  },
  'terminal.new-tab-menu': { status: 'ported', differences: ['The new tab menu matches.'] },
  'terminal.tab-reorder': {
    status: 'partial',
    differences: [
      'Dropping Terminal 2 on the left edge of Terminal 1 moves it first in both; in GPUIX the active tab moves to the front, but both titles read "Ter...", so the order is inferred from the active tab, not read.',
      TAB_TRUNC
    ],
    cause: 'compat translator gap',
    unit: 'C15 tab title width',
    impact: 1
  },
  'terminal.split': {
    status: 'partial',
    differences: [
      "Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1).",
      TAB_TRUNC
    ],
    cause: 'compat translator gap',
    unit: 'C15 tab title width',
    impact: 1
  },
  'statusbar.items': {
    status: 'partial',
    differences: ['Branch, path, Terminal and settings items line up.', LAMP],
    cause: 'compat translator gap',
    unit: 'C7 svg fill utilities',
    impact: 1
  },
  'statusbar.context-bar': {
    status: 'broken',
    differences: ['The Show in Context Bar popover (five toggles) does not open on click.'],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 1
  },
  'statusbar.connection': {
    status: 'partial',
    differences: [
      'Hovering the connection lamp shows a Connected tooltip on the web; GPUIX shows none.',
      LAMP
    ],
    cause: 'compat translator gap',
    unit: 'C4 tooltips',
    impact: 1
  },
  'remote.access-popover': {
    status: 'blocked',
    differences: [
      'Not compared: the popover renders only under isTauriContext(), so the web client has no reference.'
    ],
    cause: 'server route needed',
    unit: 'R4 desktop host role over the server',
    impact: 1
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
  ...THEME_REVIEWS,
  'theme.tokyonight-light': {
    status: 'ported',
    differences: [
      'Colours match the web dashboard.',
      'In the first full run this GPUIX launch crashed to "Uncaught runtime errors: Timed out after 2 seconds waiting for the automation bounds query" (compat live-reads from a tanstack-virtual resize); the rerun booted cleanly, so the crash is intermittent.'
    ],
    cause: 'needs diagnosis',
    unit: 'C13 live-read timeout under load',
    impact: 1
  },
  'chat.plan': {
    status: 'partial',
    differences: [
      'The pinned Plan panel and the inline plan card match: three entries, Medium chips, the struck-through finished entry and the 1/3 count.',
      SHORT_TRANSCRIPT,
      TAB_TITLE
    ],
    cause: 'native override needed',
    unit: 'O6 transcript scroll and anchoring',
    impact: 1
  },
  'chat.permission': {
    status: 'partial',
    differences: [
      'The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both.',
      SHORT_TRANSCRIPT
    ],
    cause: 'native override needed',
    unit: 'O6 transcript scroll and anchoring',
    impact: 1
  },
  'chat.queue': {
    status: 'partial',
    differences: [
      'A prompt sent while the turn runs shows under 1 Queued in both, and the stop button replaces send.',
      SHORT_TRANSCRIPT,
      PROSE
    ],
    cause: 'native override needed',
    unit: 'O5 native prose styling',
    impact: 1
  },
  'terminal.vim-replies': {
    status: 'ported',
    differences: [
      "With the O1 fixture's command (vim -u NONE -N notes.txt, then :q!) typed into the full app, both clients return to a clean prompt; neither echoes ^[[>0;276;0c or rgb: replies.",
      "So the echo in O1's GPUIX shot does not reproduce in the full app with typed input: it belongs to the fixture, which writes its inputs to the PTY back to back, not to GPUIX (inferred; the fixture itself was not rerun here)."
    ]
  },
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
  }
}
