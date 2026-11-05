import { Braces, Globe, KeyRound, Link2, Settings, Terminal } from '@/components/icons'
import { BROWSER_ANCHORS } from '@/components/settings/browser-policy-copy'
import { rowId } from '@/components/settings/row-id'
import type { SettingsCategory } from '@/components/settings/SettingsLayout'
import type { SettingsSearchEntry } from '@/lib/settings-search'

// Emergency mode (skip confirmations, skip .gitignore selection, branch
// prefix) is hidden until its settings persist. TODO: persist them to
// app-settings-store, then add the page back under an "Advanced" group.
export const PROJECT_SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Basic project identification and location.',
    icon: <Settings size={16} />,
    group: 'Project'
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'The shell new terminals in this project open with.',
    icon: <Terminal size={16} />,
    group: 'Project'
  },
  {
    id: 'env-vars',
    label: 'Environment variables',
    description:
      'Secrets and config injected into your shell session. Secret values are cleared on app restart until secure storage is added.',
    icon: <Braces size={16} />,
    group: 'Project'
  },
  {
    id: 'symlinks',
    label: 'Worktree symlinks',
    description:
      'Directories to symlink from the project root into worktrees, so shared dependencies such as node_modules work without reinstalling.',
    icon: <Link2 size={16} />,
    group: 'Project'
  },
  {
    id: 'provider',
    label: 'Accounts',
    description: "Choose the account that this project's agent chats use.",
    icon: <KeyRound size={16} />,
    group: 'Agents'
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Which sites agents may browse in this project without asking.',
    icon: <Globe size={16} />,
    group: 'Agents'
  }
]

export const PROJECT_SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    categoryId: 'provider',
    label: 'Claude account',
    description: 'Choose the Claude account that chats in this project use.',
    keywords: ['provider', 'account', 'claude', 'work', 'personal', 'switch']
  },
  {
    categoryId: 'browser',
    label: 'Browse logged out in this project',
    description: 'Agents start logged out and keep nothing after the chat ends.',
    keywords: ['ephemeral', 'incognito', 'private', 'profile', 'cookies', 'login', 'browser'],
    anchorId: BROWSER_ANCHORS.projectEphemeral
  },
  {
    categoryId: 'browser',
    label: 'Allowed sites',
    description: 'Sites agents open in this project without asking.',
    keywords: ['browser', 'allow list', 'allowlist', 'origin', 'domain', 'website', 'automation'],
    anchorId: BROWSER_ANCHORS.projectAllowList
  },
  {
    categoryId: 'browser',
    label: 'Pre-approved actions',
    description: 'Actions agents may take on a site in this project without asking.',
    keywords: ['browser', 'password', 'payment', 'upload', 'download', 'approve'],
    anchorId: BROWSER_ANCHORS.projectPreapprovals
  },
  {
    categoryId: 'general',
    label: 'Project name',
    description: 'Basic project identification.',
    keywords: ['rename', 'title'],
    anchorId: rowId('project-name')
  },
  {
    categoryId: 'general',
    label: 'Root directory',
    description: 'Project location on disk.',
    keywords: ['path', 'folder', 'location'],
    anchorId: rowId('project-root-directory')
  },
  {
    categoryId: 'general',
    label: 'Project color',
    description: 'Project color and appearance.',
    keywords: ['theme', 'color', 'appearance'],
    anchorId: rowId('project-color')
  },
  {
    categoryId: 'env-vars',
    label: 'Environment variables',
    description: 'Secrets and config injected into your shell session.',
    keywords: ['env', 'secrets', 'config', 'dotenv']
  },
  {
    categoryId: 'shell',
    label: 'Default shell',
    description: 'The shell new terminals in this project open with.',
    keywords: ['bash', 'zsh', 'powershell', 'terminal'],
    anchorId: rowId('project-default-shell')
  },
  {
    categoryId: 'symlinks',
    label: 'Worktree symlinks',
    description: 'Directories to symlink from the project root into worktrees.',
    keywords: ['node_modules', 'gitignore', 'shared dependencies']
  }
]
