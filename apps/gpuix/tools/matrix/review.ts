/**
 * The reviewed verdict for each surface, written after looking at its web and
 * GPUIX frames. A review overrides the automatic status; `differences` lists
 * what a user would see or feel, and `cause` and `unit` feed the ranked gap
 * list. Surfaces without a review report their automatic status.
 */

import {
  BAND_FOCUS,
  BLUR,
  COMPOSER_FOCUS,
  COMPOSER_PICK,
  COMPOSER_Z,
  CONFIRM_Z,
  LAMP,
  PROSE,
  RUN_ORDER,
  TEXTAREA_LINE,
  TITLE_TIP,
  TOAST,
  TREE_TEXT
} from './review-phrases'
import { TAIL_REVIEWS } from './review-tail'
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

/** Daily-core surfaces; the settings, palette, shortcut, theme and long-tail reviews live in `review-tail.ts`. */
export const REVIEWS: Record<string, Review> = {
  'rail.project-list': {
    status: 'ported',
    differences: [
      'Same layout and order; switching to beta works by click in both (H1 fixed the lost clicks: `bun tools/clickloss/run.ts --trials 20` switched projects 60/60 through automation and XTEST).',
      COMPOSER_PICK,
      LAMP
    ]
  },
  'rail.project-menu': {
    status: 'ported',
    differences: [
      'Right-click opens the project menu with the same rows, icons, submenu chevrons and red Delete, at the same place (G3: Radix opens a context menu 2 px right of the pointer). Row labels sit where the web puts them (G5: the " Label" text in a row\'s nested {icon}{children}{after} array is trimmed like any flex text run; it had kept its leading space, 3 px).',
      "Under the open menu GPUIX keeps the hovered beta row's gear and shortcut; the web hides them, since a modal Radix menu turns pointer events off on the page."
    ]
  },
  'rail.project-rename': {
    status: 'ported',
    differences: [
      'Rename from the context menu edits the row in place and Enter saves gamma-renamed in both.'
    ]
  },
  'rail.project-remove': {
    status: 'partial',
    differences: [
      'Delete from the context menu asks for confirmation and removes delta in both.',
      BLUR,
      CONFIRM_Z
    ],
    cause: 'compat translator gap',
    unit: 'confirm dialog stacking (unassigned)',
    impact: 1
  },
  'rail.project-colour': {
    status: 'ported',
    differences: [
      'Change Color opens the Select Color popover with the same nine swatches and the current one ringed.'
    ]
  },
  'rail.project-reorder': {
    status: 'ported',
    differences: [
      "Dragging gamma onto alpha reorders the list to alpha, gamma, beta in both (C3 fixed in G3: the framer-motion shim drives Reorder from pointer moves with framer's one-neighbour-per-move rule). The dragged row does not follow the pointer in GPUIX, which has no transforms; the list reorders live under it.",
      "After the drop both clients stay on alpha and paint alpha and gamma in their hover state (gear and Ctrl+1/Ctrl+2), with the action strip's fade over alpha's +4 -1 diff stat."
    ]
  },
  'rail.add-menu': {
    status: 'partial',
    differences: [
      'Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both.',
      BLUR,
      'GPUIX paints the + button\'s "Add project or folder group" title tooltip above the modal and its scrim; the web shows none. The footnote wraps "memory-only" at a different word.'
    ],
    cause: 'compat translator gap',
    unit: 'title tooltips (unassigned)',
    impact: 1
  },
  'rail.collapse': {
    status: 'ported',
    differences: [
      "The collapsed rail matches: icons, project letters, Changes badge, and the Open canvas pencil under Search (G6: the action column is `flex-1` above an `mt-auto` footer, and the footer's auto-margin wrapper grew too and took half the free space, so the column clipped the pencil; a column now holds the wrapper back beside a growing sibling, as a row did).",
      LAMP
    ]
  },
  'rail.project-settings': {
    status: 'ported',
    differences: [
      'Clicking the gear opens Project settings with General and the same fields in both.',
      BLUR,
      'H1 fixed the lost gear click: compat keeps an element hovered while a blocking box inside it is hovered (`src/compat/hover.ts`); `bun tools/clickloss/run.ts --trials 20` opened the modal 60/60 through automation and XTEST.'
    ]
  },
  'side.chats': {
    status: 'ported',
    differences: [
      'The card title, agent, branch and age match; with more chats the cards stack one per row (G2 native ChatsList).'
    ]
  },
  'side.chats-search': {
    status: 'ported',
    differences: ['Filtering to no match and back matches, including the No matches. text.']
  },
  'side.chat-card-menu': {
    status: 'ported',
    differences: [
      'Right-click on a chat card opens the same five-row menu with Delete Chat in red.'
    ]
  },
  'side.workspace-switcher': {
    status: 'ported',
    differences: [
      'The Working copies popover matches; GPUIX omits the small terminal glyph on the web row hover.',
      BAND_FOCUS
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
    status: 'ported',
    differences: [
      'Clicking src expands it to app.ts and utils.ts in both, with no tooltip over the row. The web frame also catches the row name hint that FileTreeNode shows after 900 ms of hover; the GPUIX frame is grabbed before it fires.'
    ]
  },
  'explorer.context-menu': {
    status: 'ported',
    differences: ['Right-click on README.md opens the same file menu with Delete in red.']
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
      'Preview has the "On this page" outline (G4) and the heading and paragraph rows land on the web rows; heading sizes follow BlockNote (48/32 px). The heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is about 10 px wider, and the list bullets are larger and brighter, with the items set further right.',
      'The tab reads "guide.md" in full at the web width (C15 fixed in G5).',
      TITLE_TIP
    ],
    cause: 'native override needed',
    unit: 'E2 markdown preview parity',
    impact: 1
  },
  'editor.tabs': {
    status: 'ported',
    differences: [
      'Switching tabs works; the README preview matches the web, outline included. The tabs read README.md and app.ts in full at the web widths (C15 fixed in G5).',
      TREE_TEXT
    ]
  },
  'git.changes': {
    status: 'ported',
    differences: [
      'Sections, rows, counts and history footer match, and the Amend last commit checkbox draws as the Chromium box (C5, G3).',
      TEXTAREA_LINE
    ]
  },
  'git.diff': {
    status: 'ported',
    differences: ['Inline diff, hunk header and STAGE HUNK match closely.', TEXTAREA_LINE]
  },
  'git.amend': {
    status: 'ported',
    differences: [
      'Clicking the Amend last commit label checks the box and the button reads Amend commit with the last message filled in; clicking the box clears it, in both. The box, its check and its colours are sampled from Chromium. The web frames show the box in its hover colour because the pointer rests on it; GPUIX automation clicks without moving the pointer.',
      TEXTAREA_LINE
    ]
  },
  'git.stage': {
    status: 'ported',
    differences: ['Staging README.md moves it to Staged 2 in both.', TEXTAREA_LINE]
  },
  'git.unstage': {
    status: 'ported',
    differences: ['Unstaging app.ts moves it to Changes in both.', TEXTAREA_LINE]
  },
  'git.discard': {
    status: 'partial',
    differences: ['The confirm dialog matches.', BLUR, CONFIRM_Z],
    cause: 'compat translator gap',
    unit: 'confirm dialog stacking (unassigned)',
    impact: 1
  },
  'git.commit': {
    status: 'ported',
    differences: ['The commit lands (4 commits, bump version) in both.', TOAST]
  },
  'git.branch-picker': {
    status: 'ported',
    differences: [
      'Branch popover, Local group, feature/login and Create branch row match.',
      BAND_FOCUS
    ]
  },
  'git.worktree-create': {
    status: 'ported',
    differences: [
      'Typing a new name shows No matching working copies and Create worktree feat-matrix in both.',
      BAND_FOCUS
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
    unit: 'prose remainder: text-wrap pretty, table card (unassigned)',
    impact: 1
  },
  'chat.scroll-top': {
    status: 'partial',
    differences: [
      'One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button.',
      "The table card has the web's copy, download and fullscreen buttons (G7). Its columns start within 6 px of the web's. Each row is 32 px against the web's 30.5 px (native `mdTableCellPadding` is one value for both axes, 5 px around a 21 px line), and the web's header row has a muted fill that GPUIX lacks.",
      PROSE,
      TREE_TEXT
    ],
    cause: 'native override needed',
    unit: 'prose remainder: text-wrap pretty, table card (unassigned)',
    impact: 1
  },
  'chat.table-fullscreen': {
    status: 'partial',
    differences: [
      'View fullscreen fills the window with the table under a copy, download and exit toolbar in both (G7), at 1.02 % full-frame perceptual difference.',
      "The web's toolbar buttons are the larger Streamdown menu triggers, so its three icons sit about 48 px apart against 30 px here, and its table cells are padded wider (Route starts at 33 px against 22 px)."
    ],
    cause: 'native override needed',
    unit: 'prose remainder: text-wrap pretty, table card (unassigned)',
    impact: 1
  },
  'chat.new-chat': {
    status: 'ported',
    differences: ['New chat opens the launcher composer in place.']
  },
  'chat.agent-launcher': {
    status: 'partial',
    differences: [
      'The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the agent chip is narrower and truncates to "Chat Scen…", with the more button beside it.',
      BAND_FOCUS
    ],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 1
  },
  'chat.send': {
    status: 'partial',
    differences: [
      'Typing and Enter start a chat and the scripted reply streams in both.',
      'Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram.',
      PROSE,
      RUN_ORDER
    ],
    cause: 'missing GPUIX capability',
    unit: 'mermaid diagrams (unassigned)',
    impact: 2
  },
  'chat.model-selector': {
    status: 'partial',
    differences: ['The running chat shows the agent chip and composer like the web.', PROSE],
    cause: 'native override needed',
    unit: 'prose remainder: text-wrap pretty, table card (unassigned)',
    impact: 1
  },
  'composer.mention': {
    status: 'partial',
    differences: [
      'Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it).',
      COMPOSER_FOCUS,
      COMPOSER_Z
    ],
    cause: 'compat translator gap',
    unit: 'z-index between in-flow siblings (unassigned)',
    impact: 1
  },
  'composer.slash': {
    status: 'partial',
    differences: ['The Skills menu matches row for row.', COMPOSER_FOCUS, COMPOSER_Z],
    cause: 'compat translator gap',
    unit: 'z-index between in-flow siblings (unassigned)',
    impact: 1
  },
  'composer.attach': {
    status: 'partial',
    differences: [
      'Attach files opens the OS file chooser in both, and the picked matrix-attach.md shows as the same file chip above the prompt (G7: the GPUIX desktop host answers `dialogApi` and the composer picker with GPUI\'s portal dialog; the matrix drives the real GTK chooser with X key events, and the web answers Playwright\'s file chooser). The "Failed to open file picker" toast is gone.',
      'After the pick the web composer shows its focus border (top edge 36 and 58) and GPUIX the resting one (28). The Attach files button sits inside the card, so the web card likely keeps `focus-within:` through the click; GPUIX does not hold focus in the card once the portal dialog closes. Not traced further (I4).',
      COMPOSER_Z
    ],
    cause: 'compat translator gap',
    unit: 'focus after the native file dialog (unassigned)',
    impact: 1
  },
  'terminal.open': {
    status: 'ported',
    differences: [
      'Terminal tab, its full "Terminal 1" title at the web width, and the prompt match (C15 fixed in G5).',
      LAMP,
      'Flake: in the full run the GPUIX frame was grabbed before the prompt painted, with the status-bar title tooltip up; the rerun matched.'
    ]
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
    status: 'ported',
    differences: [
      'Dropping Terminal 2 on the left edge of Terminal 1 moves it first in both, and both clients read Terminal 2, Terminal 1 with full titles at the web widths (C15 fixed in G5).',
      'Flake: the full run failed at the terminal limit (harness leak, fixed); in the first rerun the GPUIX click on Bash in the just-opened New tab menu was lost, so only Terminal 1 opened; the second rerun matched.'
    ]
  },
  'terminal.split': {
    status: 'ported',
    differences: [
      "Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1), and each pane's tab shows its full title with its close button (C15 fixed in G5).",
      "In the full run both clients failed here at the server's terminal limit (10 per project), a harness leak: preserved PTYs from earlier surfaces piled up. The matrix now closes them before each client run (`tools/matrix/terminals.ts`), and the rerun matched."
    ]
  },
  'statusbar.items': {
    status: 'ported',
    differences: [
      'Branch, path, Terminal and settings items line up.',
      LAMP,
      'The rest of the region diff is glyph antialiasing: Chromium draws the status bar text with subpixel (LCD) colour fringes, and GPUIX draws it in grayscale (C8).'
    ]
  },
  'statusbar.context-bar': {
    status: 'ported',
    differences: ['The Show in Context Bar popover opens with the same five toggles and states.']
  },
  'statusbar.connection': {
    status: 'ported',
    differences: ['Hovering the connection lamp shows the Connected tooltip in both.', LAMP]
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
  'chat.plan': {
    status: 'partial',
    differences: [
      'The pinned Plan panel and the inline plan card show the same three entries, Medium chips, the struck-through finished entry and the 1/3 count, and the short transcript starts at the top in both.',
      'The card frames differ. The web card is `bg-card/30` with a `ring-1 ring-border/50` hairline and a divider under its header; GPUIX fills it lighter, with no ring and no divider, and its collapse chevron points down because GPUIX draws no `rotate-180`.',
      RUN_ORDER
    ],
    cause: 'compat translator gap',
    unit: 'plan card ring and rotate (unassigned)',
    impact: 1
  },
  'chat.permission': {
    status: 'ported',
    differences: [
      'The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both. The short transcript starts at the top in both.',
      'The tab title reads in full at the web width (C15 fixed in G5).',
      RUN_ORDER
    ]
  },
  'chat.queue': {
    status: 'partial',
    differences: [
      'The matrix hold bubble, the Working row with "Holding this turn open for the queue." and its block caret, the 1 Queued panel with queued follow-up, and the stop button match. G7 traced the empty transcript of 3 of 3 earlier runs: virtual-list rows were laid out at their fit width, and a row whose only text is a <markdown> (the live narration under Working…) took the markdown\'s 0 max-content width, wrapped each character onto its own line (a 76 by 809 px row) and pushed the other rows out of view. Rows now span the list.',
      'The Working chevron points right in GPUIX while the web turns it down for the open group: `TurnActivityTrigger` rotates it with a motion `rotate`, which GPUIX does not paint.',
      'The narration check fails only because natively painted markdown text is not in the automation tree.',
      RUN_ORDER
    ],
    cause: 'compat translator gap',
    unit: 'plan card ring and rotate (unassigned)',
    impact: 1
  },
  'terminal.vim-replies': {
    status: 'ported',
    differences: [
      "With the O1 fixture's command (vim -u NONE -N notes.txt, then :q!) typed into the full app, both clients return to a clean prompt; neither echoes ^[[>0;276;0c or rgb: replies.",
      "So the echo in O1's GPUIX shot does not reproduce in the full app with typed input: it belongs to the fixture, which writes its inputs to the PTY back to back, not to GPUIX (inferred; the fixture itself was not rerun here)."
    ]
  },
  ...TAIL_REVIEWS
}
