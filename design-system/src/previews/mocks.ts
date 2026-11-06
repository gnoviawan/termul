/** Synthetic data for previews. No real users, paths or hosts. */

export const MOCK_BRANCHES = ['main', 'dev', 'feature/canvas', 'fix/terminal-resize']

export const MOCK_FILES = [
  { path: 'src/server/index.ts', added: 24, removed: 3 },
  { path: 'src/server/routes.ts', added: 8, removed: 12 },
  { path: 'README.md', added: 2, removed: 0 }
]

export const MOCK_MESSAGES = [
  { id: 'm1', from: 'you', time: '09:12', text: 'Add a health check to the API server.' },
  {
    id: 'm2',
    from: 'agent',
    time: '09:12',
    text: 'Added GET /healthz returning 200 with uptime. Tests pass.'
  },
  { id: 'm3', from: 'you', time: '09:14', text: 'Also log the port on startup.' },
  { id: 'm4', from: 'agent', time: '09:15', text: 'Done. It logs "listening on :4000".' }
] as const

export const MOCK_PROJECTS = [
  { id: 'p-blue', name: 'api-server', color: 'blue' },
  { id: 'p-purple', name: 'design-kit', color: 'purple' },
  { id: 'p-green', name: 'infra', color: 'green' },
  { id: 'p-yellow', name: 'docs', color: 'yellow' },
  { id: 'p-red', name: 'hotfix', color: 'red' },
  { id: 'p-cyan', name: 'mobile', color: 'cyan' },
  { id: 'p-pink', name: 'marketing', color: 'pink' },
  { id: 'p-orange', name: 'data-jobs', color: 'orange' },
  { id: 'p-gray', name: 'archive', color: 'gray' }
] as const

export const MOCK_COMMANDS = [
  { group: 'Terminal', label: 'New terminal', shortcut: 'Ctrl+T' },
  { group: 'Terminal', label: 'Split right', shortcut: 'Ctrl+\\' },
  { group: 'Project', label: 'Open folder', shortcut: 'Ctrl+O' },
  { group: 'Project', label: 'Switch project', shortcut: 'Ctrl+P' },
  { group: 'View', label: 'Toggle sidebar', shortcut: 'Ctrl+B' }
]
