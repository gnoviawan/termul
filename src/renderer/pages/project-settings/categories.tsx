import {
  Globe,
  KeyRound,
  KeySquare,
  Link2,
  Settings,
  ShieldAlert,
  TerminalSquare
} from '@/components/icons'
import { BROWSER_ANCHORS } from '@/components/settings/browser-policy-copy'
import type { SettingsCategory } from '@/components/settings/SettingsLayout'
import type { SettingsSearchEntry } from '@/lib/settings-search'

export const PROJECT_SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Basic project identification and location.',
    icon: <Settings size={16} />
  },
  {
    id: 'env-vars',
    label: 'Environment variables',
    description:
      'Secrets and config injected into your shell session. Secret values are cleared on app restart until secure storage is added.',
    icon: <KeySquare size={16} />
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'Customize the terminal experience for this workspace.',
    icon: <TerminalSquare size={16} />
  },
  {
    id: 'symlinks',
    label: 'Worktree symlinks',
    description:
      'Directories to symlink from the project root into worktrees, so shared dependencies such as node_modules work without reinstalling.',
    icon: <Link2 size={16} />
  },
  {
    id: 'provider',
    label: 'Accounts',
    description: "Choose the account that this project's agent chats use.",
    icon: <KeyRound size={16} />
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Which sites agents may browse in this project without asking.',
    icon: <Globe size={16} />
  },
  {
    id: 'emergency',
    label: 'Emergency mode',
    description:
      'Power-user workflow settings for incident response and rapid worktree operations.',
    icon: <ShieldAlert size={16} />
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
    anchorId: 'project-name'
  },
  {
    categoryId: 'general',
    label: 'Root directory',
    description: 'Project location on disk.',
    keywords: ['path', 'folder', 'location'],
    anchorId: 'project-root-directory'
  },
  {
    categoryId: 'general',
    label: 'Project color',
    description: 'Project color and appearance.',
    keywords: ['theme', 'color', 'appearance']
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
    description: 'Customize the terminal experience for this workspace.',
    keywords: ['bash', 'zsh', 'powershell'],
    anchorId: 'project-default-shell'
  },
  {
    categoryId: 'shell',
    label: 'Startup command',
    description: 'Command to execute when a new terminal session starts.',
    keywords: ['init', 'startup', 'command']
  },
  {
    categoryId: 'symlinks',
    label: 'Worktree symlinks',
    description: 'Directories to symlink from the project root into worktrees.',
    keywords: ['node_modules', 'gitignore', 'shared dependencies']
  },
  {
    categoryId: 'emergency',
    label: 'Skip confirmation dialogs',
    description: 'Bypass non-essential prompts during worktree operations.',
    keywords: ['emergency', 'confirm']
  },
  {
    categoryId: 'emergency',
    label: 'Skip .gitignore selection',
    description: 'Use default symlink settings when creating worktrees.',
    keywords: ['emergency', 'gitignore']
  },
  {
    categoryId: 'emergency',
    label: 'Default branch prefix',
    description: 'Prefix for new branch naming.',
    keywords: ['branch', 'feature', 'hotfix'],
    anchorId: 'project-branch-prefix'
  }
]
