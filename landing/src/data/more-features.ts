import type { IconSvgElement } from '@hugeicons/react';
import {
  ServerStack01Icon,
  FolderTreeIcon,
  Notification01Icon,
  FileSearchIcon,
  ArchiveRestoreIcon,
  ClockIcon,
  KeyboardIcon,
  RefreshIcon,
  FlashIcon,
  SecurityLockIcon,
  Globe02Icon,
  PaintBrush01Icon,
} from '@hugeicons/core-free-icons';

export type MoreFeature = {
  icon: IconSvgElement;
  title: string;
  description: string;
};

export const moreFeatures: MoreFeature[] = [
  {
    icon: ServerStack01Icon,
    title: 'SSH & Remote Connections',
    description:
      'Connect to remote machines and manage files over SFTP without leaving your workspace.',
  },
  {
    icon: FolderTreeIcon,
    title: 'File Explorer with Live Watch',
    description:
      'Browse your project tree, create and rename inline, and see changes the moment they hit disk.',
  },
  {
    icon: FileSearchIcon,
    title: 'Ripgrep-Powered Search',
    description:
      'Search across your whole project at native speed, powered by a bundled ripgrep sidecar.',
  },
  {
    icon: ArchiveRestoreIcon,
    title: 'Workspace Snapshots',
    description:
      'Capture a full workspace layout and restore it later, so experiments never cost you your setup.',
  },
  {
    icon: ClockIcon,
    title: 'Command History',
    description:
      'Look back across per-project and aggregate command history to find what you ran and when.',
  },
  {
    icon: Notification01Icon,
    title: 'Exit Notifications',
    description:
      'Get a desktop notification and a tab highlight when a long-running command finishes.',
  },
  {
    icon: KeyboardIcon,
    title: 'Custom Keyboard Shortcuts',
    description:
      'Record your own shortcuts and trigger app actions consistently from any focused surface.',
  },
  {
    icon: RefreshIcon,
    title: 'Automatic Updates',
    description:
      'Stay current with signed auto-updates that download in the background and install on confirm.',
  },
  {
    icon: FlashIcon,
    title: 'WebGL Terminal Rendering',
    description:
      'A GPU-accelerated renderer keeps the terminal smooth, with an automatic DOM fallback.',
  },
  {
    icon: SecurityLockIcon,
    title: 'Secure Env Storage',
    description:
      'Per-project environment variables are stored securely and redacted when persisted.',
  },
  {
    icon: Globe02Icon,
    title: 'Cross-Platform',
    description:
      'Native builds for Windows, macOS, and Linux from one Tauri 2 codebase, signed and packaged.',
  },
  {
    icon: PaintBrush01Icon,
    title: 'Themeable Workspace',
    description:
      'Color-code projects and tune terminal and UI preferences to match how you like to work.',
  },
];
