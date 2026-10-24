/**
 * The reviewed verdict for each surface, written after looking at its web and
 * GPUIX frames. A review overrides the automatic status; `differences` lists
 * what a user would see or feel, and `cause` and `unit` feed the ranked gap
 * list. Surfaces without a review report their automatic status.
 */

import {
  BACKDROP,
  CHECKBOX,
  LAMP,
  PROSE,
  RUN_ORDER,
  TAB_TITLE,
  TAB_TRUNC,
  TINT,
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
    status: 'ported',
    differences: [
      'Right-click opens the project menu with the same rows, icons, submenu chevrons and red Delete. The menu sits 2 px left of the web one, so every glyph shows in the region diff (4.97% perceptual).'
    ]
  },
  'rail.project-rename': {
    status: 'ported',
    differences: [
      'Rename from the context menu edits the row in place and Enter saves gamma-renamed in both.'
    ]
  },
  'rail.project-remove': {
    status: 'ported',
    differences: [
      'Delete from the context menu asks for confirmation and removes delta in both.',
      BACKDROP
    ]
  },
  'rail.project-colour': {
    status: 'ported',
    differences: [
      'Change Color opens the Select Color popover with the same nine swatches and the current one ringed.'
    ]
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
      'The gear opens Project settings on General with the same fields in both.',
      BACKDROP,
      TINT
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
    differences: [
      'Right-click on a chat card opens the same five-row menu with Delete Chat in red.'
    ]
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
      'The tab title truncates to "guid..." where the web shows "guide.md".',
      TITLE_TIP
    ],
    cause: 'compat translator gap',
    unit: 'C15 tab title width',
    impact: 1
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
    differences: ['The running chat shows the agent chip and composer like the web.', PROSE],
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
    status: 'ported',
    differences: ['The Show in Context Bar popover opens with the same five toggles and states.']
  },
  'statusbar.connection': {
    status: 'partial',
    differences: ['Hovering the connection lamp shows the Connected tooltip in both.', LAMP],
    cause: 'compat translator gap',
    unit: 'C7 svg fill utilities',
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
