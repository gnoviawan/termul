import type { PixelBlastProps } from '../components/PixelBlast';

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
  bullets: string[];
  /**
   * Short screen recording for this feature. When present and motion is
   * allowed, the clip plays in the feature frame; if it fails to load the
   * synthetic FeatureVisual is shown instead.
   */
  video?: FeatureVideo;
};

export const pixelBlastDefaults = {
  pixelSize: 6,
  patternScale: 3,
  patternDensity: 1.2,
  pixelSizeJitter: 0.5,
  enableRipples: true,
  rippleSpeed: 0.4,
  rippleThickness: 0.12,
  rippleIntensityScale: 1.5,
  liquid: true,
  liquidStrength: 0.12,
  liquidRadius: 1.2,
  liquidWobbleSpeed: 5,
  speed: 0.6,
  edgeFade: 0.25,
  transparent: true,
} satisfies Partial<PixelBlastProps>;

export const featurePixelBlastProps: Partial<Record<FeatureId, Partial<PixelBlastProps>>> = {
  '01': {
    variant: 'circle',
    color: '#38bdf8',
  },
  '02': {
    variant: 'triangle',
    color: '#fb923c',
    patternScale: 2.85,
    patternDensity: 1.05,
    liquidStrength: 0.14,
    speed: 0.58,
  },
  '03': {
    variant: 'circle',
    color: '#a78bfa',
  },
  '04': {
    variant: 'square',
    color: '#22d3ee',
  },
  '05': {
    variant: 'diamond',
    color: '#eab308',
  },
  '06': {
    variant: 'triangle',
    color: '#f43f5e',
  },
  '07': {
    variant: 'square',
    color: '#4ade80',
    patternScale: 2.6,
    rippleThickness: 0.1,
    liquidStrength: 0.1,
    speed: 0.54,
  },
  '08': {
    variant: 'diamond',
    color: '#f472b6',
    patternDensity: 1.35,
    rippleSpeed: 0.38,
    liquidWobbleSpeed: 5.4,
    speed: 0.52,
  },
  '09': {
    variant: 'square',
    color: '#818cf8',
  },
};

export const features: Feature[] = [
  {
    id: '01',
    navTitle: 'TABBED INTERFACE',
    title: 'Tabbed Interface',
    description:
      'Stop hunting through a pile of scattered OS windows to find the right shell. Keep every session in one clean tab bar, reorder by dragging, and switch context in a single click.',
    bullets: [
      'Every session stays in one window, never lost behind others',
      'Drag tabs to reorder them around how you actually work',
      'Open a fresh shell without breaking your flow',
    ],
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
    bullets: [
      'Zero-config detection of PowerShell, CMD, Git Bash, WSL, zsh, and bash',
      'Move between environments without restarting your workflow',
      'Run native WSL and Windows commands side by side',
    ],
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
    bullets: [
      'Each project keeps its own terminals and working directories',
      'Switch projects from the sidebar and pick up instantly',
      'Per-project settings stay isolated and out of your way',
    ],
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
    bullets: [
      'Drag any tab to a pane edge to split your layout',
      'Mix terminals, editors, and browser tabs in one view',
      'Layouts persist, so your setup survives a restart',
    ],
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
    bullets: [
      'Live preview updates with every keystroke',
      'Rich block-based editing for notes, READMEs, and docs',
      'Mermaid diagrams render inline as you write',
    ],
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
    bullets: [
      'Capture and annotate any element while you browse',
      'Label findings with severity and intent',
      'Export a shareable package instead of loose screenshots',
    ],
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
    bullets: [
      'Stage, unstage, and discard changes with a click',
      'Commit, amend, and push from one panel',
      'Read-only history graph to trace how your branch evolved',
    ],
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
    bullets: [
      'Run multiple branches at once without re-cloning',
      'Each worktree appears as its own sub-project',
      'A simplified flow that hides the worktree plumbing',
    ],
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
    bullets: [
      'Switch projects and trigger actions from the keyboard',
      'Project-first ordering surfaces what matters most',
      'Pin frequent commands for one-keystroke access',
    ],
    video: {
      src: '/features/09-command-palette.mp4',
    },
  },
];
