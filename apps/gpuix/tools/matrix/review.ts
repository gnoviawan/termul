/**
 * The reviewed verdict for each surface, written after looking at its web and
 * GPUIX frames. A review overrides the automatic status; `differences` lists
 * what a user would see or feel, and `cause` and `unit` feed the ranked gap
 * list. Surfaces without a review report their automatic status.
 */

import {
  BAND_FOCUS,
  BLUR,
  CODE_CARD,
  COMPOSER_FOCUS,
  COMPOSER_PICK,
  COMPOSER_Z,
  CONFIRM_Z,
  LAMP,
  PROSE,
  RUN_ORDER,
  TAIL_OFFSET,
  TEXTAREA_LINE,
  TITLE_TIP,
  TOAST,
  TREE_TEXT,
  WASH
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
    status: 'ported',
    differences: [
      'Delete from the context menu asks for confirmation and removes delta in both.',
      BLUR,
      CONFIRM_Z
    ]
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
      'Both clients show the + button\'s "Add project or folder group" tooltip after the menu closes (focus returns to the button). The web paints it under the modal\'s scrim, blurred, and GPUIX above it (G14 diagnosis): the web\'s TooltipContent has no portal, so it is a `z-50` box in the rail, under the later `fixed inset-0 z-50` NewProjectModal, while GPUIX gives every tooltip `LAYER.tooltip`, above all `z-50` layers. The footnote wraps "memory-only" at a different word.'
    ],
    cause: 'compat translator gap',
    unit: 'tooltip stacking under later z-50 overlays (unassigned)',
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
      'Clicking src expands it to app.ts and utils.ts in both. Both clients show the row name hint FileTreeNode raises after 900 ms of hover, so a frame catches it or not by timing: in M3 the full run caught it in GPUIX only and the rerun in neither.'
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
    differences: [
      'Staging README.md moves it to Staged 2 in both.',
      TEXTAREA_LINE,
      "In 1 of 3 M3 runs the GPUIX click on the row's Stage changes button also opened README.md's working-tree diff. G12 traced it to compat's gesture grouping: GPUIX delivers the click to the button and then to the row, one handler run apart (11 ms on a quiet host), and deliveries more than 100 ms after the first started a new gesture, so a slow Stage handler let the row's delivery past RowAction's stopPropagation. A delivery now belongs to the gesture of the press at its point until the next press (a unit test with a 150 ms handler fails before). `tools/clickloss --targets stage` did not reproduce it live (40 of 40 quiet, 20 of 20 on two loaded cores before; 40 of 40 after)."
    ]
  },
  'git.unstage': {
    status: 'ported',
    differences: ['Unstaging app.ts moves it to Changes in both.', TEXTAREA_LINE]
  },
  'git.discard': {
    status: 'ported',
    differences: ['The confirm dialog matches.', BLUR, CONFIRM_Z]
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
    status: 'ported',
    differences: [
      'The transcript, code card, task list, Worked for row and Changed files bar all render.',
      CODE_CARD,
      TAIL_OFFSET,
      PROSE,
      WASH
    ]
  },
  'chat.scroll-top': {
    status: 'ported',
    differences: [
      'One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button.',
      "The table card has the web's copy, download and fullscreen buttons (G7). Its header labels start at 517, 737 and 1077 px in both (N4: cells take their max-content width as flex basis, gpuix/0012). Its rules sit on rows 402, 432, 463 and 493 and the card ends at 524 px in both (G14 native patch gpuix/0014-table-fractional-cell-padding: the 4.8 px cell padding is laid out as fractional struts, so rows are 30.6 px apart as on the web; GPUI had rounded it to 5 px, 31 px rows, and the rules sat at 402, 433, 464 and 495). The semibold header sits on the web's muted fill (G8 gpuix/0010).",
      "The table card's Copy, Download and View fullscreen icons sit at the web's x (1161, 1190 and 1217 px, G13). Its rules are the web's `border` colour (rgb 36, N4).",
      "An ordered item sets its number inline, as Streamdown's `list-inside` marker does (N4), and in tabular figures, as Chromium draws list markers (G14 native patch gpuix/0015-markdown-lead-tabular-nums, theme `orderedItem`): the first chip's wash starts at 545 px on all three items against the web's 546 (542, 545 and 544 before; Inter's proportional 1 is 3.39 px narrower at 14 px).",
      PROSE,
      WASH
    ]
  },
  'chat.table-fullscreen': {
    status: 'ported',
    differences: [
      'View fullscreen fills the window with the table under a copy, download and exit toolbar in both (G7).',
      "The view paints over the chat composer card and the status bar, as on the web (G12: its `<anchored>` layer takes `LAYER.dialog`; with no priority it had sorted at 0 under the composer's `relative z-10` and the bar's `z-50` since gpuix/0011, 1.28 % full-frame perceptual in M3, 1.01 % after). A test fails when any `<anchored>` in apps/gpuix/src names no priority.",
      "The web portals the view outside `.chat-streamdown`, so Streamdown's utilities apply unscaled (`tools/chat/table-probe.ts`). G13 gives the fullscreen `<markdown>` its own theme from `TableCard.tsx`: 16 by 8 px cells on a 20 px line, the `bg-muted/80` header, and 14 px inline code on `bg-muted` with 6 px side padding. Copy, Download and Exit are 44 px squares 4 px apart at x 1117, 1165 and 1213 in both (they were 24 px Copy and Download), and rows are 37 px apart in both (31 before). The toolbar crop's perceptual diff fell from 1.03 to 0.26 %.",
      "N4 closed the three native differences G13 left: the inline-code washes start at the web's x (zed/0006; they sat 6 px left, because GPUI measured a line that opens with a padded chip from its first glyph), the columns share the width as CSS auto layout does (gpuix/0012: max-content as flex basis; columns 2 and 3 started 2 px right), and the rules are `border-border` (rgb 36) under body rows only, with no rule under the header (gpuix/0012 `tableRule` and `mdTableHeaderRule: 0`). The rules sit on rows 86, 159, 196, 233 and 270 in both frames; full-frame perceptual 0.08 % (1.01 % before)."
    ]
  },
  'chat.new-chat': {
    status: 'ported',
    differences: ['New chat opens the launcher composer in place.']
  },
  'chat.agent-launcher': {
    status: 'partial',
    differences: [
      "The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. The agent chip spans two of the track's three columns and reads Chat Scenario Agent in full, as on the web (G14: native patch gpuix/0016-grid-span and compat's `gridColumn: span 2 / span 2`; it had taken one column and truncated to \"Chat Scen…\").",
      "The hairline under the search band stays `border` while the field has focus; the web turns it `ring` through `peer-focus-within:`, a variant compat does not translate."
    ],
    cause: 'compat translator gap',
    unit: 'peer-* variants (unassigned)',
    impact: 1
  },
  'chat.send': {
    status: 'partial',
    differences: [
      'Typing and Enter start a chat and the scripted reply streams in both.',
      "The chat starts on the device's picked agent even when Enter comes before the launcher has restored that pick: the send waits for the pick (G8 AGENT-PICK; `tools/matrix/agent-pick.ts` sends the moment the composer appears and lands 4 of 4 web and 4 of 4 GPUIX chats on the picked agent, 2 of 4 and 1 of 4 before).",
      "The mermaid diagram is drawn as on the web (G10 MERMAID): the webview helper renders it with the web's mermaid 11.16.0 and config and the card fits the PNG to its frame, 714 by 191 px against the web's 714 by 195 px (WebKit measures the monospace labels 2 % wider). The pan and zoom buttons and the fullscreen action are missing; Download saves the source.",
      'The boot launcher stays mounted across the first project commit (G10 BOOT-REMOUNT, re-landed in G11), and the composer pill names the chat\'s agent: the c-reply step checks "Chat Scenario Agent" inside the pill. Before G11 LABEL a boot reopen adopting the host\'s agent took the reuse key from the agent the new chat ran on, and the pill read "Agent" in 2 of 5 GPUIX runs; with the fix 6 of 6 GPUIX and 6 of 6 web runs pass.',
      PROSE,
      RUN_ORDER
    ],
    cause: 'missing GPUIX capability',
    unit: 'mermaid pan, zoom and fullscreen (unassigned)',
    impact: 1
  },
  'chat.model-selector': {
    status: 'ported',
    differences: [
      'The running chat shows the agent chip and composer like the web.',
      CODE_CARD,
      TAIL_OFFSET,
      PROSE,
      WASH
    ]
  },
  'composer.mention': {
    status: 'ported',
    differences: [
      'Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it).',
      COMPOSER_FOCUS,
      COMPOSER_Z
    ]
  },
  'composer.slash': {
    status: 'ported',
    differences: ['The Skills menu matches row for row.', COMPOSER_FOCUS, COMPOSER_Z]
  },
  'composer.attach': {
    status: 'ported',
    differences: [
      'Attach files opens the OS file chooser in both, and the picked matrix-attach.md shows as the same file chip above the prompt (G7: the GPUIX desktop host answers `dialogApi` and the composer picker with GPUI\'s portal dialog; the matrix drives the real GTK chooser with X key events, and the web answers Playwright\'s file chooser). The "Failed to open file picker" toast is gone.',
      "After the pick both composers show the focus border (top edge 37 and 59 against the web's 37 and 58). G9 traced the resting border of earlier runs to the harness: GPUIX restores focus when its window gets the X input focus back (native patch gpuix/0006), which a window manager does when a dialog closes and Xvfb, which runs none, never did; the matrix now hands the focus back after answering the chooser.",
      TITLE_TIP,
      COMPOSER_Z
    ]
  },
  'terminal.open': {
    status: 'ported',
    differences: [
      'Terminal tab, its full "Terminal 1" title at the web width, and the prompt match (C15 fixed in G5).',
      LAMP,
      'A focused terminal blinks its cursor in both, so a frame shows the block or not by timing.'
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
  'terminal.new-tab-menu': {
    status: 'ported',
    differences: [
      'The new tab menu matches. GPUIX adds New browser tab, since only the GPUIX client has browser panes.'
    ]
  },
  'terminal.tab-reorder': {
    status: 'ported',
    differences: [
      'Dropping Terminal 2 on the left edge of Terminal 1 moves it first in both, and both clients read Terminal 2, Terminal 1 with full titles at the web widths (C15 fixed in G5).',
      'In the full M3 run, and in 1 of 5 runs of terminal.split, GPUIX opened the New tab menu but only Terminal 1: the Bash click replayed the web point before GPUIX had painted the menu. The surfaces now click Bash by its text, which waits for the item (M3 harness fix); 4 of 4 runs then passed, and the row is from one of them.'
    ]
  },
  'terminal.split': {
    status: 'ported',
    differences: [
      "Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1), and each pane's tab shows its full title with its close button (C15 fixed in G5).",
      'Both focus the moved Terminal 2: its block cursor is the focused one in both (M3 runs after the Bash fix; see terminal.tab-reorder for the lost click).'
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
    status: 'pending-unit',
    differences: [
      'GPUIX has no remote access popover yet; StatusBar renders it only under isTauriContext(). The reference is the desktop app (`tools/reference/tauri.ts`), whose status bar has the button.'
    ],
    cause: 'server route needed',
    unit: 'R4 desktop host role over the server',
    impact: 1
  },
  'chat.plan': {
    status: 'ported',
    differences: [
      'The pinned Plan panel and the inline plan card show the same three entries, Medium chips, the struck-through finished entry and the 1/3 count, and the short transcript starts at the top in both.',
      "Both cards are `bg-card/30` with the `ring-1 ring-border/50` hairline and the divider under the header. The entries sit on the web's rows and columns (G14: `@radix-ui/react-accordion` had resolved to the popover stand-in, whose Root renders no element, so the list's `px-2 pb-1.5 pt-0.5` was lost and the entries sat 8 px left and the panels 8 px short; `compat/radix/accordion.tsx` renders Radix's parts). The collapse chevron points up in both (G9). The running entry's spinner arc is drawn thicker.",
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
    status: 'ported',
    differences: [
      'The matrix hold bubble, the Working row with "Holding this turn open for the queue." and its block caret, the 1 Queued panel with queued follow-up, and the stop button match. G7 traced the empty transcript of 3 of 3 earlier runs: virtual-list rows were laid out at their fit width, and a row whose only text is a <markdown> (the live narration under Working…) took the markdown\'s 0 max-content width, wrapped each character onto its own line (a 76 by 809 px row) and pushed the other rows out of view. Rows now span the list.',
      'The Working chevron turns down for the open group in both (G9: the motion shim passes `animate.rotate` to the icons below, which bake the turn into their SVG about its centre).',
      'The narration check fails only because natively painted markdown text is not in the automation tree.',
      RUN_ORDER
    ]
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
