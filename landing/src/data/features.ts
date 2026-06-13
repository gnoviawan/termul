export type FeatureId = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09';

export type FeatureVideo = {
  /** H.264 MP4 source. Recorded at 4:3 (e.g. 1280x960), silent, looping. */
  src: string;
  /** Optional WebM source for smaller payloads on supporting browsers. */
  webm?: string;
  /** Optional poster image shown before the clip loads. */
  poster?: string;
};

export type Feature = {
  id: FeatureId;
  navTitle: string;
  title: string;
  description: string;
  /**
   * Short screen recording for this feature. When present and motion is
   * allowed, the clip plays in the feature frame; if it fails to load the
   * synthetic FeatureVisual is shown instead.
   */
  video?: FeatureVideo;
};

export const featureBackgroundImage = '/bg-termul.webp';

export const features: Feature[] = [
  {
    id: '01',
    navTitle: 'TABBED INTERFACE',
    title: 'Tabbed Interface',
    description:
      'Stop hunting through a pile of scattered OS windows to find the right shell. Keep every session in one clean tab bar, reorder by dragging, and switch context in a single click.',
    video: {
      src: '/features/01-tabbed-interface.mp4',
    },
  },
  {
    id: '02',
    navTitle: 'MULTIPLE SHELLS',
    title: 'Multiple Shell Support',
    description:
      'Switching between PowerShell, WSL, and Git Bash usually means remembering paths and editing configs. Termul detects your installed shells for you, so the right environment is always one click away.',
    video: {
      src: '/features/02-multiple-shells.mp4',
    },
  },
  {
    id: '03',
    navTitle: 'PROJECT WORKSPACES',
    title: 'Project-Based Workspaces',
    description:
      'Juggling three projects should not mean three sets of mismatched terminals. Termul groups every session, directory, and setting under the project it belongs to, so switching projects restores the exact context you left.',
    video: {
      src: '/features/03-project-workspaces.mp4',
    },
  },
  {
    id: '04',
    navTitle: 'SPLIT PANES',
    title: 'Pane-Based Split Layout',
    description:
      'Alt-tabbing between a terminal, your code, and a browser breaks concentration. Split your workspace into resizable panes and keep everything you need to see in view at once.',
    video: {
      src: '/features/04-split-panes.mp4',
    },
  },
  {
    id: '05',
    navTitle: 'MARKDOWN EDITOR',
    title: 'Markdown-First Live Editor',
    description:
      'Writing docs in one app and previewing in another breaks your flow. Termul renders markdown live as you type — headings, lists, tables, and Mermaid diagrams take shape side by side with your text, no save-and-refresh loop.',
    video: {
      src: '/features/05-markdown-builtin-preview.mp4',
    },
  },
  {
    id: '06',
    navTitle: 'BROWSER ANNOTATION',
    title: 'Embedded Browser & Annotations',
    description:
      'Reporting a UI bug usually means screenshots, arrows, and a long chat thread. Browse inside your workspace, mark up exactly what is wrong, and export a structured report your team can act on.',
    video: {
      src: '/features/06-browser-annotation.mp4',
    },
  },
  {
    id: '07',
    navTitle: 'GIT PANEL',
    title: 'Visual Git Panel',
    description:
      'Memorizing git commands for routine work slows everyone down. Stage, commit, amend, and push from a visual panel, and read your branch history as a graph without leaving the terminal.',
    video: {
      src: '/features/07-git-panel.mp4',
    },
  },
  {
    id: '08',
    navTitle: 'GIT WORKTREE',
    title: 'Git Worktree as Sub-Project',
    description:
      'Checking out a second branch normally means stashing work or cloning the repo again. Open a worktree as its own sub-project and work on multiple branches in parallel, each with isolated terminals.',
    video: {
      src: '/features/08-git-worktree.mp4',
    },
  },
  {
    id: '09',
    navTitle: 'COMMAND PALETTE',
    title: 'Command Palette',
    description:
      'Reaching for the mouse to switch projects or run an action adds up fast. Open the command palette and jump anywhere — project-first ordering and pinning keep what you use most at your fingertips.',
    video: {
      src: '/features/09-command-palette.mp4',
    },
  },
];
