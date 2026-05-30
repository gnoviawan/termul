import type { PixelBlastProps } from '../components/PixelBlast';

export type FeatureId = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08';

export type Feature = {
  id: FeatureId;
  navTitle: string;
  title: string;
  description: string;
  bullets: string[];
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
    variant: 'diamond',
    color: '#f472b6',
    patternDensity: 1.35,
    rippleSpeed: 0.38,
    liquidWobbleSpeed: 5.4,
    speed: 0.52,
  },
  '03': {
    variant: 'triangle',
    color: '#fb923c',
    patternScale: 2.85,
    patternDensity: 1.05,
    liquidStrength: 0.14,
    speed: 0.58,
  },
  '04': {
    variant: 'square',
    color: '#4ade80',
    patternScale: 2.6,
    rippleThickness: 0.1,
    liquidStrength: 0.1,
    speed: 0.54,
  },
  '05': {
    variant: 'circle',
    color: '#a78bfa',
  },
  '06': {
    variant: 'square',
    color: '#22d3ee',
  },
  '07': {
    variant: 'diamond',
    color: '#eab308',
  },
  '08': {
    variant: 'triangle',
    color: '#f43f5e',
  },
};

export const features: Feature[] = [
  {
    id: '01',
    navTitle: 'TABBED INTERFACE',
    title: 'Tabbed Interface',
    description:
      'Windows Terminal-style clean tab bar with drag-and-drop reordering and quick shell switching.',
    bullets: [
      'Intuitive window management',
      'Drag-and-drop to reorder tabs',
      'Quick access to multiple environments',
    ],
  },
  {
    id: '02',
    navTitle: 'SESSION PERSISTENCE',
    title: 'Session Persistence',
    description:
      'Terminal sessions persist across app restarts automatically. Take snapshots and restore workspace states anytime.',
    bullets: [
      'Automatic state saving',
      'Workspace snapshots for easy recovery',
      'Pick up exactly where you left off',
    ],
  },
  {
    id: '03',
    navTitle: 'MULTIPLE SHELLS',
    title: 'Multiple Shell Support',
    description:
      'Automatically detects and supports PowerShell, CMD, Git Bash, WSL, zsh, bash and more.',
    bullets: [
      'Zero-config shell detection',
      'Seamless integration with WSL',
      'Support for all popular terminal environments',
    ],
  },
  {
    id: '04',
    navTitle: 'CROSS-PLATFORM',
    title: 'Cross-Platform',
    description:
      'Built on Tauri 2.0 and React for blazing fast native performance on Windows, macOS, and Linux.',
    bullets: [
      'Native performance with Tauri 2.0',
      'Lightweight memory footprint',
      'Consistent experience across all OS',
    ],
  },
  {
    id: '05',
    navTitle: 'PROJECT WORKSPACES',
    title: 'Project-Based Workspaces',
    description:
      'Organize terminals by project with dedicated workspace directories, separate state, and per-project configuration.',
    bullets: [
      'Per-project terminal state',
      'Sidebar project switching',
      'Isolated workspace settings',
    ],
  },
  {
    id: '06',
    navTitle: 'SPLIT PANES',
    title: 'Pane-Based Split Layout',
    description:
      'Split your workspace into resizable panes and arrange terminals, editors, and browser tabs side by side.',
    bullets: [
      'Drag-to-resize panes',
      'Mix terminal, editor, and browser in one view',
      'Layout persists with workspace state',
    ],
  },
  {
    id: '07',
    navTitle: 'CODE EDITOR',
    title: 'Built-in Code & Markdown Editor',
    description:
      'Edit code and markdown without leaving Termul — syntax highlighting, dirty-state tracking, BlockNote markdown, and inline Mermaid diagrams.',
    bullets: [
      'Syntax-highlighted file buffers',
      'Rich markdown with live preview',
      'Mermaid diagram rendering',
    ],
  },
  {
    id: '08',
    navTitle: 'BROWSER TABS',
    title: 'Embedded Browser & Annotations',
    description:
      'Browse inside your workspace with child webview tabs, then capture, annotate, and export browser states with severity and intent labels.',
    bullets: [
      'In-workspace web browsing',
      'Annotation review workflow',
      'Structured export packages',
    ],
  },
];
