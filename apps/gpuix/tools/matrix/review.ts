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

const LAMP = 'The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored).'
const RIGHT_CLICK =
  'Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike.'

const TITLE_TIP =
  'A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame.'
const CHECKBOX = 'The Amend last commit checkbox box is not drawn (native checkbox input), only its label.'
const OVERLAY = 'the modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable.'
const OVERLAP =
  'In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three.'
const PROSE =
  'Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule.'
const TREE_TEXT = 'The text check fails only because natively painted text is not in the automation tree.'
const TINT =
  'Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have).'
const SELECT =
  'Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown.'
const SETTINGS_BASE = ['The section content and navigation match.', 'The modal backdrop is far lighter than the web bg-overlay.', TINT]
const TOAST =
  'The toast is the sonner shim: a flat green box at the window edge with the close button on the right, where the web shows a card with a check icon and the close button at its top-left.'

export const REVIEWS: Record<string, Review> = {
  'rail.project-list': { status: 'ported', differences: ['Same layout and order; switching to beta works by click.', LAMP] },
  'rail.project-menu': { status: 'broken', differences: [RIGHT_CLICK], cause: 'compat translator gap', unit: 'C2 context menus', impact: 3 },
  'rail.project-rename': {
    status: 'broken',
    differences: [RIGHT_CLICK, 'With no menu, the replayed clicks land on the row and the typed name goes into the composer instead.'],
    cause: 'compat translator gap',
    unit: 'C2 context menus',
    impact: 2
  },
  'rail.project-remove': { status: 'broken', differences: [RIGHT_CLICK, 'No delete confirmation, so the project stays.'], cause: 'compat translator gap', unit: 'C2 context menus', impact: 2 },
  'rail.project-colour': { status: 'broken', differences: [RIGHT_CLICK, 'The Select Color popover never appears.'], cause: 'compat translator gap', unit: 'C2 context menus', impact: 1 },
  'rail.project-reorder': {
    status: 'broken',
    differences: ['Dragging gamma onto alpha reorders the web list to alpha, gamma, beta; GPUIX keeps alpha, beta, gamma (no drag-and-drop through compat).'],
    cause: 'compat translator gap',
    unit: 'C3 drag and drop',
    impact: 1
  },
  'rail.add-menu': {
    status: 'broken',
    differences: ['Clicking + shows only its tooltip; the New project / New folder group dropdown does not open, so the new project modal is unreachable from the rail.'],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 3
  },
  'rail.collapse': { status: 'ported', differences: ['Collapsed rail matches: icons, project letters, Changes badge.', LAMP] },
  'rail.project-settings': {
    status: 'broken',
    differences: ['The gear on the hovered row shows, but clicking it does not open Project settings (also fails with real X input).'],
    cause: 'compat translator gap',
    unit: 'C2 menus and popovers',
    impact: 2
  },
  'side.chats': { status: 'ported', differences: ['Chat card title, agent, branch and age match.'] },
  'side.chats-search': { status: 'ported', differences: ['Filtering to no match and back matches, including the No matches. text.'] },
  'side.chat-card-menu': { status: 'broken', differences: [RIGHT_CLICK], cause: 'compat translator gap', unit: 'C2 context menus', impact: 2 },
  'side.workspace-switcher': { status: 'ported', differences: ['The Working copies popover matches; GPUIX omits the small terminal glyph on the web row hover.'] },
  'side.hide': { status: 'ported', differences: ['Side panel hides; the expand chevron sits in the same place.'] },
  'explorer.tree': { status: 'ported', differences: ['Tree, git colours and status letters match.'] },
  'explorer.expand': {
    status: 'partial',
    differences: [TITLE_TIP + ' It covers the chevron and the open-folder icon of the expanded row.'],
    cause: 'compat translator gap',
    unit: 'C4 title tooltips',
    impact: 1
  },
  'explorer.context-menu': { status: 'broken', differences: [RIGHT_CLICK], cause: 'compat translator gap', unit: 'C2 context menus', impact: 2 },
  'explorer.drag': {
    status: 'unverified',
    differences: ['Playwright dragTo did not move notes.txt in the web client either (HTML5 drag events), so there is no reference; GPUIX treated the drag as a click and expanded docs.']
  },
  'editor.code': {
    status: 'ported',
    differences: [
      'The native editor (E1) paints the same highlighted text, line numbers and active line; the text checks fail only because native text is painted inside GPUI and is not in the automation tree.'
    ]
  },
  'editor.code-edit': {
    status: 'ported',
    differences: ['Click, End and typing put "// edited" on line 5 in both; the dirty dot shows on the tab. Same tree-text caveat as editor.code.']
  },
  'editor.markdown': {
    status: 'partial',
    differences: [
      'Preview renders, but the "On this page" outline column is missing, headings are smaller and paragraph spacing is tighter.',
      'The tab title truncates to "guid..." where the web shows "guide.md".',
      TITLE_TIP
    ],
    cause: 'native override needed',
    unit: 'E2 markdown preview parity',
    impact: 2
  },
  'editor.tabs': {
    status: 'partial',
    differences: ['Switching tabs works; README preview shows the same outline and typography gaps as editor.markdown, and the tab title truncates to "READ...".'],
    cause: 'native override needed',
    unit: 'E2 markdown preview parity',
    impact: 1
  },
  'git.changes': { status: 'partial', differences: ['Sections, rows, counts and history footer match.', CHECKBOX], cause: 'compat translator gap', unit: 'C5 form controls', impact: 1 },
  'git.diff': { status: 'partial', differences: ['Inline diff, hunk header and STAGE HUNK match closely.', CHECKBOX], cause: 'compat translator gap', unit: 'C5 form controls', impact: 1 },
  'git.stage': { status: 'partial', differences: ['Staging README.md moves it to Staged 2 in both.', CHECKBOX] },
  'git.unstage': { status: 'partial', differences: ['Unstaging app.ts moves it to Changes in both.', CHECKBOX] },
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
  'git.branch-picker': { status: 'ported', differences: ['Branch popover, Local group, feature/login and Create branch row match.'] },
  'git.worktree-create': { status: 'ported', differences: ['Typing a new name shows No matching working copies and Create worktree feat-matrix in both.'] },
  'chat.transcript': {
    status: 'partial',
    differences: ['The transcript, code card, task list, Worked for row and Changed files bar all render.', PROSE, TREE_TEXT],
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
    unit: 'O6 transcript wheel scroll',
    impact: 3
  },
  'chat.new-chat': { status: 'ported', differences: ['New chat opens the launcher composer in place.'] },
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
    differences: ['The running chat shows the agent chip and composer like the web.', OVERLAP, PROSE],
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
  'composer.slash': { status: 'ported', differences: ['The Skills menu matches row for row.', 'No focus ring on the GPUIX composer.'] },
  'composer.attach': {
    status: 'ported',
    differences: ['Clicking Attach files opens nothing visible in either client in this headless run (the web file chooser is a native dialog Playwright does not paint).']
  },
  'terminal.open': { status: 'ported', differences: ['Terminal tab and prompt match; the GPUIX tab title truncates to "Ter..." where the web shows "Terminal 1".'] },
  'terminal.type': { status: 'ported', differences: ['echo output matches cell for cell.'] },
  'terminal.vim-replies': {
    status: 'ported',
    differences: [
      'After vim -u NONE and :q! both clients show a clean prompt. The echoed query replies (^[[>0;276;0c ... rgb:) from the O1 fixture did not appear in either client here.',
      'GPUIX draws a block cursor; the unfocused web terminal draws none.'
    ]
  },
  'terminal.file-link': {
    status: 'ported',
    differences: ['Ctrl+click on src/app.ts in terminal output opens app.ts in a new tab in both.', TREE_TEXT]
  },
  'terminal.new-tab-menu': { status: 'ported', differences: ['The new tab menu matches.'] },
  'terminal.split': {
    status: 'unverified',
    differences: ['Ctrl+Shift+D split nothing in the web client either, so the split binding in this build is not that key; split panes are not compared.']
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
  'settings.interface': { status: 'partial', differences: SETTINGS_BASE, cause: 'compat translator gap', unit: 'C6 overlay backdrop', impact: 1 },
  'settings.notifications': {
    status: 'partial',
    differences: [...SETTINGS_BASE, 'Row dividers inside a group are missing and rows sit tighter.'],
    cause: 'compat translator gap',
    unit: 'C8 text colour runs',
    impact: 1
  },
  'settings.editor': { status: 'broken', differences: [SELECT, ...SETTINGS_BASE.slice(1)], cause: 'native override needed', unit: 'O8 native select', impact: 2 },
  'settings.appearance': {
    status: 'broken',
    differences: [SELECT, 'Renderer and Scrollback rows wrap their descriptions one word per line.', ...SETTINGS_BASE.slice(1)],
    cause: 'native override needed',
    unit: 'O8 native select',
    impact: 2
  },
  'settings.shell': { status: 'broken', differences: [SELECT, ...SETTINGS_BASE.slice(1)], cause: 'native override needed', unit: 'O8 native select', impact: 2 },
  'settings.terminal-profiles': { status: 'partial', differences: SETTINGS_BASE, cause: 'compat translator gap', unit: 'C8 text colour runs', impact: 1 },
  'settings.ai-agents': {
    status: 'broken',
    differences: [SELECT, 'The Close idle chats after label wraps one or two letters per line, filling the pane; the agents list below is pushed out of view.'],
    cause: 'native override needed',
    unit: 'O8 native select',
    impact: 2
  },
  'settings.skills': { status: 'partial', differences: SETTINGS_BASE, cause: 'compat translator gap', unit: 'C8 text colour runs', impact: 1 },
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
  'settings.shortcuts': { status: 'partial', differences: SETTINGS_BASE, cause: 'compat translator gap', unit: 'C8 text colour runs', impact: 1 },
  'settings.diagnostics': {
    status: 'partial',
    differences: [...SETTINGS_BASE, 'Server version reads termul-server v0.1.0 in GPUIX and v0.4.52 on the web against the same server.'],
    cause: 'needs diagnosis',
    unit: 'O9 server version source',
    impact: 1
  },
  'settings.reset': { status: 'partial', differences: SETTINGS_BASE, cause: 'compat translator gap', unit: 'C6 overlay backdrop', impact: 1 }
}
