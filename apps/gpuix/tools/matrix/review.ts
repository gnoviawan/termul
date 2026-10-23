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
  'side.hide': { status: 'ported', differences: ['Side panel hides; the expand chevron sits in the same place.'] }
}
