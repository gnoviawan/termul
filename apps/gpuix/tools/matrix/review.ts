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
  }
}
