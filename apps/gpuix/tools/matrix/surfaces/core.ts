/**
 * Daily-core surfaces: rail, side panel, explorer, editor, git, chat,
 * composer, terminal and status bar.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  HOLD_REPLY,
  MATRIX_PROMPTS,
  PERMISSION_GRANTED,
  PERMISSION_TITLE,
  PLAN_ENTRIES
} from '../agent'
import type { Surface } from '../types'
import { ensureProject, resetAlpha } from '../world'
import {
  COMPOSER_READY,
  choose,
  click,
  css,
  DASHBOARD,
  drag,
  gone,
  hover,
  id,
  label,
  press,
  rclick,
  see,
  step,
  txt,
  type,
  wait,
  wheel
} from './dsl'

/** The mermaid card's own fullscreen button; the transcript's table has one too. */
const MERMAID_FULLSCREEN =
  '[data-streamdown="mermaid-block-actions"] button[aria-label="View fullscreen"]'

const ATTACH_FILE = 'matrix-attach.md'
export const CHAT_TITLE = 'How does the web client decide which routes rend'
const openChat = click(txt(CHAT_TITLE, false))
const explorer = click(txt('Explorer'))
const changes = click(txt('Changes', false))
const composer = click(css('[contenteditable="true"], textarea'))
const openTerminal = click(css('button[aria-label^="Open terminal at"]'))
/** A spot in the first workspace pane, as a fraction of its size: its drop zones while a drag runs. */
const paneAt = (x: number, y: number) => ({ css: '[data-pane-content]', frac: { x, y } })

const RAIL: Surface[] = [
  {
    id: 'rail.project-list',
    area: 'rail',
    title: 'Project list and switching',
    roi: '[data-testid="shell-rail"]',
    steps: [
      step(
        'a-dashboard',
        [],
        see('alpha', 'beta', 'gamma', 'delta', 'What should we do in alpha?')
      ),
      step(
        'b-switch-beta',
        [click(id('project-item-m1-beta'))],
        [...see('What should we do in beta?'), ...COMPOSER_READY]
      )
    ]
  },
  {
    id: 'rail.project-menu',
    area: 'rail',
    title: 'Project context menu',
    roi: '[role="menu"]',
    steps: [DASHBOARD, step('b-menu', [rclick(id('project-item-m1-beta'))], see('Rename'))]
  },
  {
    id: 'rail.project-rename',
    area: 'rail',
    title: 'Rename a project',
    prepare: (world) => ensureProject(world, 'gamma'),
    roi: '[data-testid="shell-rail"]',
    steps: [
      DASHBOARD,
      step(
        'b-rename',
        [
          rclick(id('project-item-m1-gamma')),
          click(txt('Rename')),
          click(css('[data-testid="shell-rail"] input')),
          press('ctrl-a'),
          type('gamma-renamed'),
          press('enter')
        ],
        [{ text: 'gamma-renamed', within: 'shell-rail' }]
      )
    ]
  },
  {
    id: 'rail.project-remove',
    area: 'rail',
    title: 'Remove a project',
    prepare: (world) => ensureProject(world, 'delta'),
    steps: [
      DASHBOARD,
      step(
        'b-confirm',
        [rclick(id('project-item-m1-delta')), click(txt('Delete'))],
        see('Delete Project')
      ),
      step('c-removed', [click(label('Delete'))], [gone('delta')])
    ]
  },
  {
    id: 'rail.project-colour',
    area: 'rail',
    title: 'Project colour picker',
    prepare: (world) => ensureProject(world, 'beta'),
    steps: [
      DASHBOARD,
      step(
        'b-picker',
        [rclick(id('project-item-m1-beta')), click(txt('Change Color'))],
        see('Select Color')
      )
    ]
  },
  {
    id: 'rail.project-reorder',
    area: 'rail',
    title: 'Reorder projects by drag',
    roi: '[data-testid="shell-rail"]',
    steps: [
      DASHBOARD,
      step(
        'b-dragged',
        [drag(id('project-item-m1-gamma'), id('project-item-m1-alpha')), wait(500)],
        [{ order: ['alpha', 'gamma', 'beta'], within: 'shell-rail' }]
      )
    ]
  },
  {
    id: 'rail.add-menu',
    area: 'rail',
    title: 'Add project menu and new project modal',
    steps: [
      DASHBOARD,
      step('b-menu', [click(label('Add project or folder group'))], see('New project')),
      step('c-modal', [click(txt('New project', false))], see('Create'))
    ]
  },
  {
    id: 'rail.collapse',
    area: 'rail',
    title: 'Collapse and expand the rail',
    steps: [
      DASHBOARD,
      step('b-collapsed', [click(label('Expand or collapse projects'))], [gone('Projects')])
    ]
  },
  {
    id: 'rail.project-settings',
    area: 'rail',
    title: 'Project settings modal',
    steps: [
      DASHBOARD,
      step('b-beta', [click(id('project-item-m1-beta'))], see('What should we do in beta?')),
      step(
        'c-settings',
        [click(label('Settings for beta'))],
        see('Basic project identification and location.')
      )
    ]
  }
]

const SIDE: Surface[] = [
  {
    id: 'side.chats',
    area: 'side-panel',
    title: 'Chats tab with a chat card',
    roi: '[data-testid="chats-list-scroll"]',
    steps: [step('a-chats', [], see(CHAT_TITLE, 'Chat Scenario Agent'))]
  },
  {
    id: 'side.chats-search',
    area: 'side-panel',
    title: 'Search chats',
    steps: [
      DASHBOARD,
      step(
        'b-miss',
        [click(css('input[placeholder^="Search chats"]')), type('zzz-no-match')],
        [gone(CHAT_TITLE)]
      ),
      step('c-hit', [press('ctrl-a'), type('routes')], see(CHAT_TITLE))
    ]
  },
  {
    id: 'side.chat-card-menu',
    area: 'side-panel',
    title: 'Chat card context menu',
    steps: [
      DASHBOARD,
      step(
        'b-menu',
        [rclick(txt(CHAT_TITLE, false))],
        see('Open in split', 'Copy Path', 'Delete Chat')
      )
    ]
  },
  {
    id: 'side.workspace-switcher',
    area: 'side-panel',
    title: 'Workspace (worktree) switcher',
    steps: [DASHBOARD, step('b-open', [click(label('Workspace'))], see('Current checkout'))]
  },
  {
    id: 'side.hide',
    area: 'side-panel',
    title: 'Hide and show the side panel',
    steps: [DASHBOARD, step('b-hidden', [click(label('Hide side panel'))], [gone(CHAT_TITLE)])]
  }
]

const EXPLORER: Surface[] = [
  {
    id: 'explorer.tree',
    area: 'explorer',
    title: 'File tree',
    steps: [DASHBOARD, step('b-tree', [explorer], see('src', 'docs', 'README.md', 'notes.txt'))]
  },
  {
    id: 'explorer.expand',
    area: 'explorer',
    title: 'Expand a folder',
    steps: [
      DASHBOARD,
      step('b-tree', [explorer], see('src')),
      step('c-expanded', [click(txt('src'))], see('app.ts', 'utils.ts'))
    ]
  },
  {
    id: 'explorer.context-menu',
    area: 'explorer',
    title: 'File context menu',
    steps: [
      DASHBOARD,
      step('b-tree', [explorer], see('README.md')),
      step('c-menu', [rclick(txt('README.md'))], see('Rename', 'Delete'))
    ]
  },
  {
    id: 'explorer.drag',
    area: 'explorer',
    title: 'Drag a file from the tree into the pane to open it',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step('b-tree', [explorer], see('notes.txt', 'docs')),
      step(
        'c-dropped',
        [drag(txt('notes.txt'), paneAt(0.5, 0.5)), wait(1200)],
        see('untracked notes')
      )
    ]
  }
]

const EDITOR: Surface[] = [
  {
    id: 'editor.code',
    area: 'editor',
    title: 'Code editor (CodeMirror) on a TypeScript file',
    steps: [
      DASHBOARD,
      step('b-tree', [explorer, click(txt('src'))], see('app.ts')),
      step('c-open', [click(txt('app.ts'))], see('export function greet'))
    ]
  },
  {
    id: 'editor.code-edit',
    area: 'editor',
    title: 'Type into the code editor',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step(
        'b-open',
        [explorer, click(txt('src')), click(txt('app.ts'))],
        see('export function greet')
      ),
      step(
        'c-typed',
        [click(txt('VERSION', false)), press('end'), type(' // edited')],
        see('// edited')
      )
    ]
  },
  {
    id: 'editor.markdown',
    area: 'editor',
    title: 'Markdown (BlockNote) editor',
    steps: [
      DASHBOARD,
      step('b-tree', [explorer, click(txt('docs'))], see('guide.md')),
      step('c-open', [click(txt('guide.md'))], see('Alpha guide', 'Setup'))
    ]
  },
  {
    id: 'editor.tabs',
    area: 'editor',
    title: 'Two editor tabs and switching',
    steps: [
      DASHBOARD,
      step(
        'b-two',
        [explorer, click(txt('README.md')), click(txt('src')), click(txt('app.ts'))],
        see('export function greet')
      ),
      step('c-back', [click(css('[role="tab"]:has-text("README.md")'))], see('The matrix project.'))
    ]
  }
]

const GIT: Surface[] = [
  {
    id: 'git.changes',
    area: 'git',
    title: 'Changes panel: staged, unstaged, untracked',
    prepare: resetAlpha,
    steps: [DASHBOARD, step('b-changes', [changes], see('app.ts', 'README.md', 'notes.txt'))]
  },
  {
    id: 'git.amend',
    area: 'git',
    title: 'Amend last commit: the label and the box toggle it',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step('b-changes', [changes], see('Amend last commit')),
      step('c-label', [click(txt('Amend last commit')), wait(400)], see('Amend commit')),
      step('d-box', [click(css('input[type="checkbox"]')), wait(400)], [gone('Amend commit')])
    ]
  },
  {
    id: 'git.diff',
    area: 'git',
    title: 'Diff view of an unstaged file',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step('b-changes', [changes], see('README.md')),
      step('c-diff', [click(txt('README.md'))], see('An unstaged line.'))
    ]
  },
  {
    id: 'git.stage',
    area: 'git',
    title: 'Stage a file',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step('b-changes', [changes], see('README.md')),
      step('c-staged', [click(label('Stage changes'))], see('README.md'))
    ]
  },
  {
    id: 'git.unstage',
    area: 'git',
    title: 'Unstage a file',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step('b-changes', [changes], see('app.ts')),
      step('c-unstaged', [click(label('Unstage changes'))], see('app.ts'))
    ]
  },
  {
    id: 'git.discard',
    area: 'git',
    title: 'Discard a change (confirm dialog)',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step('b-changes', [changes], see('README.md')),
      step('c-confirm', [click(label('Discard changes'))], see('Discard'))
    ]
  },
  {
    id: 'git.commit',
    area: 'git',
    title: 'Commit staged changes',
    prepare: resetAlpha,
    steps: [
      DASHBOARD,
      step('b-changes', [changes], see('app.ts')),
      step('c-message', [
        click(css('input[placeholder="Summary (required)"]')),
        type('bump version')
      ]),
      step('d-committed', [click(label('Commit to main'))], [gone('app.ts')])
    ]
  },
  {
    id: 'git.branch-picker',
    area: 'git',
    title: 'Branch picker',
    prepare: resetAlpha,
    steps: [DASHBOARD, step('b-picker', [click(label('Switch git branch'))], see('feature/login'))]
  },
  {
    id: 'git.worktree-create',
    area: 'git',
    title: 'Working copies switcher: search or create a worktree',
    steps: [
      DASHBOARD,
      step('b-switcher', [click(label('Workspace'))], see('main')),
      step('c-typed', [type('feat-matrix'), wait(800)])
    ]
  }
]

const CHAT: Surface[] = [
  {
    id: 'chat.transcript',
    area: 'chat',
    title: 'Open a chat: transcript, tool cards, changed files',
    roi: '[data-slot="message-scroller-viewport"]',
    steps: [
      DASHBOARD,
      step('b-open', [openChat, wait(1500)], see('One more place parses it', 'Changed files'))
    ]
  },
  {
    id: 'chat.scroll-top',
    area: 'chat',
    title: 'Transcript scrolled to the first turn',
    roi: '[data-slot="message-scroller-viewport"]',
    steps: [
      DASHBOARD,
      step('b-open', [openChat, wait(1500)], see('One more place parses it')),
      step(
        'c-top',
        [wheel(txt('One more place parses it', false), -20000), wait(1200)],
        see('Three call sites depend on it')
      )
    ]
  },
  {
    id: 'chat.table-fullscreen',
    area: 'chat',
    title: 'Table card fullscreen view',
    steps: [
      DASHBOARD,
      step('b-open', [openChat, wait(1500)]),
      step('c-top', [wheel(txt('One more place parses it', false), -20000), wait(1200)]),
      step('d-fullscreen', [click(label('View fullscreen')), wait(800)], see('WorkspaceSnapshots'))
    ]
  },
  {
    id: 'chat.new-chat',
    area: 'chat',
    title: 'New chat button',
    steps: [DASHBOARD, step('b-new', [click(label('New chat'))], see('Chat Scenario Agent'))]
  },
  {
    id: 'chat.agent-launcher',
    area: 'chat',
    title: 'Agent launcher menu',
    steps: [
      DASHBOARD,
      step(
        'b-menu',
        [click(css('button[aria-label^="Agent and model"]'))],
        see('This agent gives no model')
      )
    ]
  },
  {
    id: 'chat.send',
    area: 'chat',
    title: 'Send a prompt from the dashboard and stream the reply',
    steps: [
      DASHBOARD,
      step('b-typed', [composer, type('Explain the router')], see('Explain the router')),
      step(
        'c-reply',
        [press('enter'), wait(4000)],
        [
          ...see('The router docs cover the hash variant in more depth'),
          { text: 'Chat Scenario Agent', within: 'agent-model-selector-trigger' }
        ]
      ),
      step('d-zoom', [click(label('Zoom in')), wait(600)]),
      step(
        'e-download-menu',
        [click(label('Download diagram')), wait(400)],
        see('SVG', 'PNG', 'MMD')
      ),
      step('f-fullscreen', [click(css(MERMAID_FULLSCREEN)), wait(800)], [gone('SVG')])
    ]
  },
  {
    id: 'chat.model-selector',
    area: 'chat',
    title: 'Model and mode selector in a running chat',
    steps: [DASHBOARD, step('b-open', [openChat, wait(1000)], see('Chat Scenario Agent'))]
  },
  {
    id: 'chat.plan',
    area: 'chat',
    title: 'Plan panel from a plan update',
    steps: [
      DASHBOARD,
      step(
        'b-reply',
        [composer, type(MATRIX_PROMPTS.plan), press('enter'), wait(3000)],
        see('Here is the plan for the router work.')
      ),
      step('c-panel', [], see('Plan', ...PLAN_ENTRIES))
    ]
  },
  {
    id: 'chat.permission',
    area: 'chat',
    title: 'Permission prompt: allow a tool call',
    steps: [
      DASHBOARD,
      step(
        'b-prompt',
        [composer, type(MATRIX_PROMPTS.permission), press('enter'), wait(3000)],
        see(PERMISSION_TITLE, 'Allow', 'Reject')
      ),
      step(
        'c-allowed',
        [click(txt('Allow')), wait(1500)],
        [...see(PERMISSION_GRANTED), gone('Reject')]
      )
    ]
  },
  {
    id: 'chat.queue',
    area: 'chat',
    title: 'Prompt queue while a turn runs',
    steps: [
      DASHBOARD,
      step(
        'b-holding',
        [composer, type(MATRIX_PROMPTS.hold), press('enter'), wait(2500)],
        see(HOLD_REPLY)
      ),
      step(
        'c-queued',
        [composer, type('queued follow-up'), press('enter'), wait(1200)],
        see('Queued', 'queued follow-up')
      )
    ]
  }
]

const COMPOSER: Surface[] = [
  {
    id: 'composer.mention',
    area: 'composer',
    title: 'Mention menu (@)',
    steps: [DASHBOARD, step('b-menu', [composer, type('@')], see('No files or folders match'))]
  },
  {
    id: 'composer.slash',
    area: 'composer',
    title: 'Slash command menu (/)',
    steps: [DASHBOARD, step('b-menu', [composer, type('/')], see('Skills'))]
  },
  {
    id: 'composer.attach',
    area: 'composer',
    title: 'Attach a file from the OS file chooser',
    prepare: async (world) => {
      mkdirSync(path.join(world.root, 'attach'), { recursive: true })
      writeFileSync(path.join(world.root, 'attach', ATTACH_FILE), '# Matrix attachment\n')
    },
    steps: [
      DASHBOARD,
      step(
        'b-attach',
        [choose(label('Attach files'), path.join('attach', ATTACH_FILE)), wait(800)],
        [...see(ATTACH_FILE), gone('Failed to open file picker')]
      )
    ]
  }
]

const TERMINAL: Surface[] = [
  {
    id: 'terminal.open',
    area: 'terminal',
    title: 'Open a terminal from the status bar',
    steps: [DASHBOARD, step('b-open', [openTerminal, wait(2500)], see('Terminal'))]
  },
  {
    id: 'terminal.type',
    area: 'terminal',
    title: 'Type a command and see its output',
    steps: [
      DASHBOARD,
      step('b-open', [openTerminal, wait(2500)]),
      step('c-echo', [type('echo matrix-$((6*7))\n'), wait(1500)])
    ]
  },
  {
    id: 'terminal.vim-replies',
    area: 'terminal',
    title: 'Terminal query replies after vim (T1 fixture shape)',
    steps: [
      DASHBOARD,
      step('b-open', [openTerminal, wait(2500)]),
      step('c-vim', [type('vim -u NONE -N notes.txt\n'), wait(2500)]),
      step('d-quit', [press('escape'), type(':q!\n'), wait(1500)])
    ]
  },
  {
    id: 'terminal.file-link',
    area: 'terminal',
    title: 'Ctrl+click a file path in terminal output opens it in the editor',
    steps: [
      DASHBOARD,
      step('b-open', [openTerminal, wait(2500)]),
      step('c-echo', [type('clear && echo src/app.ts\n'), wait(1500)]),
      step(
        'd-link',
        [
          { do: 'click', target: { css: '.xterm-screen', at: { x: 24, y: 9 } }, modifiers: 'ctrl' },
          wait(2500)
        ],
        see('export function greet')
      )
    ]
  },
  {
    id: 'terminal.new-tab-menu',
    area: 'terminal',
    title: 'New tab menu (terminal, browser, ...)',
    steps: [DASHBOARD, step('b-menu', [click(label('New tab'))], see('Terminal'))]
  },
  {
    id: 'terminal.tab-reorder',
    area: 'terminal',
    title: 'Reorder terminal tabs by dragging',
    steps: [
      DASHBOARD,
      step(
        'b-two',
        [openTerminal, wait(2000), click(label('New tab')), click(txt('Bash')), wait(2000)],
        see('Terminal 1', 'Terminal 2')
      ),
      step('c-reordered', [
        drag(txt('Terminal 2'), {
          css: '[role="tab"]:has-text("Terminal 1")',
          frac: { x: 0.1, y: 0.5 }
        }),
        wait(1200)
      ])
    ]
  },
  {
    id: 'terminal.split',
    area: 'terminal',
    title: 'Split panes: drag a second terminal tab to the pane edge',
    steps: [
      DASHBOARD,
      step(
        'b-two',
        [openTerminal, wait(2000), click(label('New tab')), click(txt('Bash')), wait(2000)],
        see('Terminal 1', 'Terminal 2')
      ),
      step(
        'c-split',
        [drag(txt('Terminal 2'), paneAt(0.92, 0.5)), wait(2000)],
        see('Terminal 1', 'Terminal 2')
      )
    ]
  }
]

const STATUSBAR: Surface[] = [
  {
    id: 'statusbar.items',
    area: 'statusbar',
    title: 'Status bar items',
    roi: '[data-status-bar]',
    steps: [step('a-dashboard', [], see('main', 'Terminal'))]
  },
  {
    id: 'statusbar.context-bar',
    area: 'statusbar',
    title: 'Context bar settings popover',
    steps: [DASHBOARD, step('b-popover', [click(label('Context bar settings'))], see('Branch'))]
  },
  {
    id: 'statusbar.connection',
    area: 'statusbar',
    title: 'Connection indicator hover',
    steps: [DASHBOARD, step('b-hover', [hover(label('Connected')), wait(1200)])]
  },
  {
    id: 'remote.access-popover',
    area: 'remote',
    title: 'Remote access popover (desktop shared-live host)',
    reference: 'tauri',
    steps: [
      DASHBOARD,
      step(
        'b-popover',
        [click(id('remote-access-trigger'))],
        see('Remote Agent Access', 'Enable remote access', 'Not available in this build yet.')
      )
    ]
  }
]

export const CORE: Surface[] = [
  ...RAIL,
  ...SIDE,
  ...EXPLORER,
  ...EDITOR,
  ...GIT,
  ...CHAT,
  ...COMPOSER,
  ...TERMINAL,
  ...STATUSBAR
]
