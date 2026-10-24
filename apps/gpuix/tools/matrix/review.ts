/**
 * The reviewed verdict for each surface, written after looking at its web and
 * GPUIX frames. A review overrides the automatic status; `differences` lists
 * what a user would see or feel, and `cause` and `unit` feed the ranked gap
 * list. Surfaces without a review report their automatic status.
 */

import {
  BACKDROP,
  LAMP,
  PROSE,
  RUN_ORDER,
  TAB_TRUNC,
  TEXTAREA_GAP,
  TAB_TITLE,
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
    differences: ['Same layout and order; switching to beta works by click.', LAMP]
  },
  'rail.project-menu': {
    status: 'partial',
    differences: [
      'Right-click opens the project menu with the same rows, icons, submenu chevrons and red Delete. The menu box now sits where the web puts it (G3: Radix opens a context menu 2 px right of the pointer).',
      'Every row label sits 3 px right of the web one: a row\'s children reach layout as a nested array ({indicator}{children}{after}), so the " Label" text after the icon keeps its leading space. Laying nested arrays out like the parent\'s own slots fixed the menu (region perceptual 1.75%) but broke the editor check\'s README preview click, so it was reverted.',
      'Under the open menu GPUIX keeps the hovered beta row\'s gear and shortcut; the web hides them, since a modal Radix menu turns pointer events off on the page.'
    ],
    cause: 'compat translator gap',
    unit: 'nested children text runs (unassigned)',
    impact: 1
  },
  'rail.project-rename': {
    status: 'ported',
    differences: ['Rename from the context menu edits the row in place and Enter saves gamma-renamed in both.']
  },
  'rail.project-remove': {
    status: 'ported',
    differences: ['Delete from the context menu asks for confirmation and removes delta in both.', BACKDROP]
  },
  'rail.project-colour': {
    status: 'ported',
    differences: ['Change Color opens the Select Color popover with the same nine swatches and the current one ringed.']
  },
  'rail.project-reorder': {
    status: 'ported',
    differences: [
      'Dragging gamma onto alpha reorders the list to alpha, gamma, beta in both (C3 fixed in G3: the framer-motion shim drives Reorder from pointer moves with framer\'s one-neighbour-per-move rule). The dragged row does not follow the pointer in GPUIX, which has no transforms; the list reorders live under it.',
      'After the drop the web paints alpha and gamma in their hover state (gear and Ctrl+1/Ctrl+2); GPUIX shows alpha\'s diff stat with no hover.'
    ]
  },
  'rail.add-menu': {
    status: 'partial',
    differences: [
      'Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both.',
      BACKDROP
    ],
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
  },
  'rail.collapse': {
    status: 'ported',
    differences: ['Collapsed rail matches: icons, project letters, Changes badge.', LAMP]
  },
  'rail.project-settings': {
    status: 'broken',
    differences: [
      'When the gear opens Project settings, it shows General with the same fields in both.',
      BACKDROP,
      'In GPUIX the click on the gear often does nothing: it failed in 10 of 11 G3 runs, with or without a hover on the row first. The gear shows only while its row is hovered (hidden group-hover:flex), and once the pointer has moved, no mouse-down reaches a compat listener at all. A plain click on a rail row has the same problem with real X input (--x11-input): 4 of 5 runs did not switch projects without the C3 Reorder change, and 2 of 9 with it. Cause not found.'
    ],
    cause: 'needs diagnosis',
    unit: 'press after hover lost (unassigned)',
    impact: 3
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
    differences: ['Right-click on a chat card opens the same five-row menu with Delete Chat in red.']
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
      'Preview renders, but the "On this page" outline column is missing (still missing at fce9a3e2, after D1 brought EditorTocLayout back), headings are smaller and paragraph spacing is tighter.',
      TITLE_TIP
    ],
    cause: 'native override needed',
    unit: 'E2 markdown preview parity',
    impact: 2
  },
  'editor.tabs': {
    status: 'partial',
    differences: [
      'Switching tabs works; the README preview matches the web, outline included. The tab title truncates to "READ...".'
    ],
    cause: 'compat translator gap',
    unit: 'C15 tab title width',
    impact: 1
  },
  'git.changes': {
    status: 'partial',
    differences: [
      'Sections, rows, counts and history footer match, and the Amend last commit checkbox draws as the Chromium box (C5, G3).',
      TEXTAREA_GAP
    ],
    cause: 'compat translator gap',
    unit: 'C5 form controls',
    impact: 1
  },
  'git.diff': {
    status: 'partial',
    differences: ['Inline diff, hunk header and STAGE HUNK match closely.', TEXTAREA_GAP],
    cause: 'compat translator gap',
    unit: 'C5 form controls',
    impact: 1
  },
  'git.amend': {
    status: 'partial',
    differences: [
      'Clicking the Amend last commit label checks the box and the button reads Amend commit with the last message filled in; clicking the box clears it, in both. The box, its check and its colours are sampled from Chromium. The web frames show the box in its hover colour because the pointer rests on it; GPUIX automation clicks without moving the pointer.',
      TEXTAREA_GAP
    ],
    cause: 'compat translator gap',
    unit: 'C5 form controls',
    impact: 1
  },
  'git.stage': {
    status: 'partial',
    differences: ['Staging README.md moves it to Staged 2 in both.', TEXTAREA_GAP]
  },
  'git.unstage': {
    status: 'partial',
    differences: ['Unstaging app.ts moves it to Changes in both.', TEXTAREA_GAP]
  },
  'git.discard': {
    status: 'partial',
    differences: ['The confirm dialog matches.', BACKDROP],
    cause: 'missing GPUIX capability',
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
    cause: 'missing GPUIX capability',
    unit: 'O5 native prose styling',
    impact: 3
  },
  'chat.scroll-top': {
    status: 'partial',
    differences: [
      'One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button.',
      PROSE,
      TREE_TEXT
    ],
    cause: 'missing GPUIX capability',
    unit: 'O5 native prose styling',
    impact: 2
  },
  'chat.new-chat': {
    status: 'ported',
    differences: ['New chat opens the launcher composer in place.']
  },
  'chat.agent-launcher': {
    status: 'partial',
    differences: [
      'The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the chip stretches across the panel and the more button wraps to a second line.'
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
    unit: 'O5 native prose styling',
    impact: 2
  },
  'chat.model-selector': {
    status: 'partial',
    differences: [
      'The running chat shows the agent chip and composer like the web.',
      PROSE
    ],
    cause: 'missing GPUIX capability',
    unit: 'O5 native prose styling',
    impact: 1
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
    differences: [
      'Terminal tab and prompt match.',
      TAB_TRUNC,
      LAMP,
      'The status-bar Terminal button\'s title tooltip paints under the pointer after the click; the web frame shows none.'
    ],
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
      'The pinned Plan panel and the inline plan card match: three entries, Medium chips, the struck-through finished entry and the 1/3 count. The short transcript starts at the top in both.',
      TAB_TITLE,
      RUN_ORDER
    ],
    cause: 'compat translator gap',
    unit: 'C15 tab title width',
    impact: 1
  },
  'chat.permission': {
    status: 'partial',
    differences: [
      'The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both. The short transcript starts at the top in both.',
      TAB_TITLE,
      RUN_ORDER
    ],
    cause: 'compat translator gap',
    unit: 'C15 tab title width',
    impact: 1
  },
  'chat.queue': {
    status: 'partial',
    differences: [
      'A prompt sent while the turn runs shows under 1 Queued in both, and the stop button replaces send.',
      PROSE
    ],
    cause: 'missing GPUIX capability',
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
  ...TAIL_REVIEWS
}
