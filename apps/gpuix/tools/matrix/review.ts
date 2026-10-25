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
  TEXTAREA_GAP,
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
      'Same layout and order; switching to beta works by click, with GPUIX automation and with real X input (--x11-input). H1 fixed the lost clicks: `bun tools/clickloss/run.ts --trials 20` switches projects 60/60 by row click through automation and XTEST, against 41/60 on exp/gpuix-client at 9747b6c2.',
      LAMP
    ]
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
    status: 'partial',
    differences: [
      'Dragging gamma onto alpha reorders the list to alpha, gamma, beta in both (C3 fixed in G3: the framer-motion shim drives Reorder from pointer moves with framer\'s one-neighbour-per-move rule). The dragged row does not follow the pointer in GPUIX, which has no transforms; the list reorders live under it.',
      'After the drop the web opens gamma, the dragged row, and paints alpha and gamma in their hover state (gear and Ctrl+1/Ctrl+2). GPUIX stays on alpha: D1 withholds the click that ends a drag. GPUIX paints alpha hovered, but its +4 -1 diff stat shows through the action strip\'s fade (bg-gradient-to-l from-[var(--rail-keycap)] from-60%), so Ctrl+1 is drawn over it.'
    ],
    cause: 'compat translator gap',
    unit: 'click after a Reorder drag; strip fade over the diff stat (unassigned)',
    impact: 1
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
    status: 'partial',
    differences: [
      'Clicking the gear opens Project settings with General and the same fields in both, with GPUIX automation and with real X input (--x11-input).',
      BACKDROP,
      'H1 fixed the lost gear click. GPUIX ends a hit test at the first absolutely placed or filled interactive box, and that box also blocks its own ancestors, so the row lost its hover as soon as its hover-revealed action strip painted under the pointer, hid the strip and the gear, and looped. The press landed on whichever frame was up. Compat now keeps an element hovered while a blocking box inside it is hovered (`src/compat/hover.ts`). `bun tools/clickloss/run.ts --trials 20` opens the modal 60/60 through automation and XTEST, against 27/60 on exp/gpuix-client at 9747b6c2.',
      'In the --x11-input frame the gear and its Project settings tooltip still paint above the modal. The automation frame has neither, and in clickloss traces the row, rail and gear get their leave once the scrim paints, so this is the hover settle catching up after the modal mounts (inferred).'
    ],
    cause: 'missing GPUIX capability',
    unit: 'C6 overlay backdrop',
    impact: 1
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
      'Preview has the "On this page" outline (G4): the heading and paragraph rows land on the web rows (126, 195, 257 px), heading sizes follow BlockNote (48/32 px). List items sit 1 px off and the bullet is the native one; the heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is 10 px wider.',
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
    status: 'ported',
    differences: ['The commit lands (4 commits, bump version) in both.', TOAST]
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
      'Terminal tab, its full "Terminal 1" title at the web width, and the prompt match (C15 fixed in G5).',
      LAMP,
      'The status-bar Terminal button\'s title tooltip paints under the pointer after the click; the web frame shows none.'
    ],
    cause: 'compat translator gap',
    unit: 'title tooltips (unassigned)',
    impact: 1
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
      'Pane tabs read "Terminal 1" in full at the web width (C15 fixed in G5).',
      'In GPUIX the click on Bash in the open New tab menu was lost in 2 of 2 G5 runs (before and after the C15 change), so no second terminal opened and nothing was reordered; terminal.split runs the same steps and opened it.'
    ],
    cause: 'needs diagnosis',
    unit: 'click loss on a just-opened menu (unassigned)',
    impact: 1
  },
  'terminal.split': {
    status: 'ported',
    differences: [
      "Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1), and each pane's tab shows its full title with its close button (C15 fixed in G5)."
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
    status: 'ported',
    differences: [
      'The pinned Plan panel and the inline plan card match: three entries, Medium chips, the struck-through finished entry and the 1/3 count. The short transcript starts at the top in both.',
      'The tab title reads in full at the web width (C15 fixed in G5).',
      RUN_ORDER
    ]
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
