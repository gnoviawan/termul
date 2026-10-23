/**
 * Daily-core surfaces: rail, side panel, explorer, editor, git, chat,
 * composer, terminal and status bar.
 */

import type { Surface } from '../types'
import { ensureProject, resetAlpha } from '../world'
import { click, css, DASHBOARD, drag, gone, hover, id, label, press, rclick, see, step, txt, type, wait, wheel } from './dsl'

export const CHAT_TITLE = 'How does the web client decide which routes rend'
const openChat = click(txt(CHAT_TITLE, false))
const explorer = click(txt('Explorer'))
const changes = click(txt('Changes', false))
const composer = click(css('[contenteditable="true"], textarea'))
const openTerminal = click(css('button[aria-label^="Open terminal at"]'))

const RAIL: Surface[] = [
  {
    id: 'rail.project-list',
    area: 'rail',
    title: 'Project list and switching',
    roi: '[data-testid="shell-rail"]',
    steps: [
      step('a-dashboard', [], see('alpha', 'beta', 'gamma', 'What should we do in alpha?')),
      step('b-switch-beta', [click(id('project-item-m1-beta'))], see('What should we do in beta?'))
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
    prepare: (world) => ensureProject(world, 'gamma'),
    steps: [
      DASHBOARD,
      step('b-confirm', [rclick(id('project-item-m1-gamma')), click(txt('Delete'))], see('Delete')),
      step('c-removed', [click(label('Delete'))], [gone('gamma')])
    ]
  },
  {
    id: 'rail.project-colour',
    area: 'rail',
    title: 'Project colour picker',
    prepare: (world) => ensureProject(world, 'beta'),
    steps: [DASHBOARD, step('b-picker', [rclick(id('project-item-m1-beta')), click(txt('Change Color'))], see('Select Color'))]
  },
  {
    id: 'rail.project-reorder',
    area: 'rail',
    title: 'Reorder projects by drag',
    roi: '[data-testid="shell-rail"]',
    steps: [
      DASHBOARD,
      step('b-dragged', [drag(id('project-item-m1-gamma'), id('project-item-m1-alpha')), wait(500)], [
        { order: ['alpha', 'gamma', 'beta'], within: 'shell-rail' }
      ])
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
    steps: [DASHBOARD, step('b-collapsed', [click(label('Expand or collapse projects'))], [gone('Projects')])]
  },
  {
    id: 'rail.project-settings',
    area: 'rail',
    title: 'Project settings modal',
    steps: [
      DASHBOARD,
      step('b-beta', [click(id('project-item-m1-beta'))], see('What should we do in beta?')),
      step('c-settings', [click(label('Settings for beta'))], see('Basic project identification and location.'))
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
      step('b-miss', [click(css('input[placeholder^="Search chats"]')), type('zzz-no-match')], [gone(CHAT_TITLE)]),
      step('c-hit', [press('ctrl-a'), type('routes')], see(CHAT_TITLE))
    ]
  },
  {
    id: 'side.chat-card-menu',
    area: 'side-panel',
    title: 'Chat card context menu',
    steps: [DASHBOARD, step('b-menu', [rclick(txt(CHAT_TITLE, false))], see('Open in split', 'Copy Path', 'Delete Chat'))]
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
    steps: [DASHBOARD, step('b-tree', [explorer], see('src')), step('c-expanded', [click(txt('src'))], see('app.ts', 'utils.ts'))]
  },
  {
    id: 'explorer.context-menu',
    area: 'explorer',
    title: 'File context menu',
    steps: [DASHBOARD, step('b-tree', [explorer], see('README.md')), step('c-menu', [rclick(txt('README.md'))], see('Rename', 'Delete'))]
  },
  {
    id: 'explorer.drag',
    area: 'explorer',
    title: 'Drag a file into a folder',
    prepare: resetAlpha,
    steps: [DASHBOARD, step('b-tree', [explorer], see('notes.txt', 'docs')), step('c-dropped', [drag(txt('notes.txt'), txt('docs')), wait(800)])]
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
      step('b-open', [explorer, click(txt('src')), click(txt('app.ts'))], see('export function greet')),
      step('c-typed', [click(txt('VERSION', false)), press('end'), type(' // edited')], see('// edited'))
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
      step('b-two', [explorer, click(txt('README.md')), click(txt('src')), click(txt('app.ts'))], see('export function greet')),
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
    id: 'git.diff',
    area: 'git',
    title: 'Diff view of an unstaged file',
    prepare: resetAlpha,
    steps: [DASHBOARD, step('b-changes', [changes], see('README.md')), step('c-diff', [click(txt('README.md'))], see('An unstaged line.'))]
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
      step('c-message', [click(css('input[placeholder="Summary (required)"]')), type('bump version')]),
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
      step('b-switcher', [click(label('Workspace'))], see('Working copies')),
      step('c-typed', [type('feat-matrix')], see('feat-matrix'))
    ]
  }
]

const CHAT: Surface[] = [
  {
    id: 'chat.transcript',
    area: 'chat',
    title: 'Open a chat: transcript, tool cards, changed files',
    roi: '[data-slot="message-scroller-viewport"]',
    steps: [DASHBOARD, step('b-open', [openChat, wait(1500)], see('One more place parses it', 'Changed files'))]
  },
  {
    id: 'chat.scroll-top',
    area: 'chat',
    title: 'Transcript scrolled to the first turn',
    roi: '[data-slot="message-scroller-viewport"]',
    steps: [
      DASHBOARD,
      step('b-open', [openChat, wait(1500)], see('One more place parses it')),
      step('c-top', [wheel(txt('One more place parses it', false), -20000), wait(1200)], see('How workspace routes are chosen'))
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
    steps: [DASHBOARD, step('b-menu', [click(css('button[aria-label^="Agent and model"]'))], see('Chat Scenario Agent', 'Codex'))]
  },
  {
    id: 'chat.send',
    area: 'chat',
    title: 'Send a prompt from the dashboard and stream the reply',
    steps: [
      DASHBOARD,
      step('b-typed', [composer, type('Explain the router')], see('Explain the router')),
      step('c-reply', [press('enter'), wait(4000)], see('The router docs cover the hash variant in more depth'))
    ]
  },
  {
    id: 'chat.model-selector',
    area: 'chat',
    title: 'Model and mode selector in a running chat',
    steps: [DASHBOARD, step('b-open', [openChat, wait(1000)], see('Chat Scenario Agent'))]
  },
  {
    id: 'chat.permission',
    area: 'chat',
    title: 'Permission prompt',
    pending: { unit: 'M2', reason: 'needs a scripted agent that requests permission; the scenario agent has none' },
    steps: []
  },
  {
    id: 'chat.plan',
    area: 'chat',
    title: 'Plan panel',
    pending: { unit: 'M2', reason: 'needs a scripted agent that emits plan updates' },
    steps: []
  },
  {
    id: 'chat.queue',
    area: 'chat',
    title: 'Prompt queue while a turn runs',
    pending: { unit: 'M2', reason: 'needs a scripted agent that holds a turn open' },
    steps: []
  }
]

const COMPOSER: Surface[] = [
  {
    id: 'composer.mention',
    area: 'composer',
    title: 'Mention menu (@)',
    steps: [DASHBOARD, step('b-menu', [composer, type('@')], see('README.md'))]
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
    title: 'Attach files button',
    steps: [DASHBOARD, step('b-click', [click(label('Attach files'))])]
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
    steps: [DASHBOARD, step('b-open', [openTerminal, wait(2500)]), step('c-echo', [type('echo matrix-$((6*7))\n'), wait(1500)])]
  },
  {
    id: 'terminal.vim-replies',
    area: 'terminal',
    title: 'Terminal query replies after vim (T1 fixture shape)',
    steps: [
      DASHBOARD,
      step('b-open', [openTerminal, wait(2500)]),
      step('c-vim', [type('vim -u NONE\n'), wait(2500)]),
      step('d-quit', [press('escape'), type(':q!\n'), wait(1500)])
    ]
  },
  {
    id: 'terminal.new-tab-menu',
    area: 'terminal',
    title: 'New tab menu (terminal, browser, ...)',
    steps: [DASHBOARD, step('b-menu', [click(label('New tab'))], see('Terminal'))]
  },
  {
    id: 'terminal.split',
    area: 'terminal',
    title: 'Split terminal panes',
    steps: [DASHBOARD, step('b-open', [openTerminal, wait(2500)]), step('c-split', [press('ctrl-shift-d'), wait(2000)])]
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
    blocked: 'StatusBar renders RemoteAccessPopover only under isTauriContext(); the web client has none to compare, and GPUIX would need the desktop host role from the server',
    steps: []
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
