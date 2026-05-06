export type WorkflowValidationMode = 'automated' | 'manual'
export type WorkflowValidationSeverity = 'acceptable' | 'warning' | 'blocked'

export interface WorkflowValidationScenario {
  id: string
  title: string
  mode: WorkflowValidationMode
  area:
    | 'project-switching'
    | 'heavy-output'
    | 'resize-fit'
    | 'detached-output'
    | 'search'
    | 'links'
    | 'selection-copy'
    | 'ime'
    | 'tui'
    | 'feature-flag'
  expectedOutcome: string
  failureSignal: string
  blockerRule: string
  evidence: string[]
  canaryRequired: boolean
  commands?: string[]
}

export const AUTOMATED_WORKFLOW_SCENARIOS: WorkflowValidationScenario[] = [
  {
    id: 'auto-project-switch-live-pty',
    title: 'Project switching preserves restore-path continuity',
    mode: 'automated',
    area: 'project-switching',
    expectedOutcome:
      'Restoring a project records the selected restore path and keeps continuity evidence equal to the stabilized 5.5 baseline.',
    failureSignal:
      'Restore-path events, transcript replay, or pane remapping regress compared to current Epic 1/2 behavior.',
    blockerRule: 'Any worse-than-5.5 continuity result is an adoption blocker.',
    evidence: [
      'src/renderer/hooks/use-terminal-restore.test.ts',
      'src/renderer/components/terminal/ConnectedTerminal.test.tsx',
    ],
    canaryRequired: true,
  },
  {
    id: 'auto-detached-output',
    title: 'Detached output continuity survives hidden/unmounted periods',
    mode: 'automated',
    area: 'detached-output',
    expectedOutcome:
      'Terminal output continues to accumulate while no renderer is mounted and replay remains available on restore.',
    failureSignal:
      'Detached transcript data is dropped or replay semantics regress during project switching.',
    blockerRule: 'Detached output loss is release-critical for migration readiness.',
    evidence: [
      'src/renderer/hooks/use-terminal-detached-output.test.ts',
      'src/renderer/components/terminal/ConnectedTerminal.test.tsx',
    ],
    canaryRequired: true,
  },
  {
    id: 'auto-heavy-output-resize-fit',
    title: 'Heavy output with fit/resize remains stable',
    mode: 'automated',
    area: 'heavy-output',
        expectedOutcome:
      'Heavy output, fit churn, and visibility recovery remain within the accepted Story 3.2 comparison bands.',
    failureSignal:
      'Fit churn, visibility recovery, or resize-sensitive output behaves worse than the accepted Story 3.2 posture.',
    blockerRule: 'Blocked or unstable fit/resize behavior prevents promotion to default runtime.',
    evidence: [
      'src/renderer/components/terminal/terminal-performance.bench.test.ts',
      'src/renderer/components/terminal/ConnectedTerminal.test.tsx',
      '_bmad-output/implementation-artifacts/tests/benchmark-results-story-3-2.md',
    ],
    canaryRequired: true,
  },
  {
    id: 'auto-resize-visibility-stability',
    title: 'Resize and visibility changes stay stable under candidate posture',
    mode: 'automated',
    area: 'resize-fit',
    expectedOutcome:
      'Visibility transitions, resize broadcasts, and fit recovery remain stable under normal Termul interaction patterns.',
    failureSignal:
      'Visibility changes or resize recovery become unstable, spam the backend, or leave the terminal in a degraded state.',
    blockerRule: 'Blocked if resize/visibility behavior is materially worse than the 5.5 baseline.',
    evidence: [
      'src/renderer/components/terminal/ConnectedTerminal.test.tsx',
    ],
    canaryRequired: true,
  },
  {
    id: 'auto-search-workflow',
    title: 'Terminal search UI preserves expected next/previous behavior',
    mode: 'automated',
    area: 'search',
    expectedOutcome:
      'Search interactions trigger next/previous navigation, clear decorations when closed, and surface no-match feedback.',
    failureSignal:
      'Search controls fail to drive find-next/find-previous behavior or leave stale decorations behind.',
    blockerRule: 'Search regression is warning-level unless it blocks the supported search workflow entirely.',
    evidence: [
      'src/renderer/components/terminal/TerminalSearchBar.test.tsx',
    ],
    canaryRequired: true,
  },
  {
    id: 'auto-clickable-links',
    title: 'Clickable terminal links still open through supported modifier flow',
    mode: 'automated',
    area: 'links',
    expectedOutcome:
      'Ctrl/meta-click continues to resolve supported file paths without breaking plain-click behavior.',
    failureSignal:
      'File-path link activation, context resolution, or error handling regresses.',
    blockerRule: 'Broken supported link-opening paths are warning-level unless they hide larger renderer regressions.',
    evidence: [
      'src/renderer/components/terminal/ConnectedTerminal.test.tsx',
    ],
    canaryRequired: true,
  },
  {
    id: 'auto-selection-copy-paste',
    title: 'Selection, copy, and paste behavior remain intact',
    mode: 'automated',
    area: 'selection-copy',
    expectedOutcome:
      'Selection state, clipboard copy, paste, and Ctrl/Cmd shortcuts continue to work as expected.',
    failureSignal:
      'Selections are lost, clipboard operations fail, or shortcuts regress under the migration path.',
    blockerRule: 'Supported copy/paste regressions are warning-level; data-loss behavior is blocked.',
    evidence: [
      'src/renderer/hooks/use-terminal-clipboard.test.ts',
      'src/renderer/components/terminal/ConnectedTerminal.test.tsx',
    ],
    canaryRequired: true,
  },
  {
    id: 'auto-canary-default-off',
    title: '6.1 workflow stays opt-in behind the migration canary',
    mode: 'automated',
    area: 'feature-flag',
    expectedOutcome:
      'The 6.1 workflow remains explicitly opt-in and does not replace the xterm 5.5 default path.',
    failureSignal:
      'Candidate workflow is enabled implicitly or production-default posture changes without approval.',
    blockerRule: 'Any accidental promotion of the 6.1 path is blocked.',
    evidence: [
      'src/renderer/lib/xterm-migration.test.ts',
      'src/renderer/App.tsx',
    ],
    canaryRequired: false,
  },
]

export const MANUAL_WORKFLOW_SCENARIOS: WorkflowValidationScenario[] = [
  {
    id: 'manual-ime-composition',
    title: 'IME composition under the 6.1 canary path',
    mode: 'manual',
    area: 'ime',
    expectedOutcome:
      'Composition candidates, intermediate composition state, and committed text behave the same as the 5.5 baseline.',
    failureSignal:
      'Dropped characters, broken candidate windows, duplicate commits, or caret instability during IME typing.',
    blockerRule: 'Any reproducible IME regression is blocked.',
    evidence: ['Auto Run Docs/xterm-6.1-manual-validation-protocol.md'],
    canaryRequired: true,
    commands: ['Type mixed-language input in a terminal prompt and inside an interactive CLI.'],
  },
  {
    id: 'manual-tui-vim',
    title: 'vim alternate-screen workflow',
    mode: 'manual',
    area: 'tui',
    expectedOutcome:
      'Entering, editing, resizing, and leaving vim behaves without redraw corruption or stuck alternate-screen state.',
    failureSignal:
      'Broken redraws, cursor drift, resize corruption, or restore issues after leaving vim.',
    blockerRule: 'Any reproducible alternate-screen regression worse than 5.5 is blocked.',
    evidence: ['Auto Run Docs/xterm-6.1-manual-validation-protocol.md'],
    canaryRequired: true,
    commands: ['vim README.md'],
  },
  {
    id: 'manual-tui-fzf',
    title: 'fzf interactive filtering workflow',
    mode: 'manual',
    area: 'tui',
    expectedOutcome:
      'Interactive filtering, selection movement, and prompt redraw remain responsive and visually correct.',
    failureSignal:
      'Input lag, redraw corruption, or selection glitches while filtering.',
    blockerRule: 'Material interaction lag or visual corruption is blocked.',
    evidence: ['Auto Run Docs/xterm-6.1-manual-validation-protocol.md'],
    canaryRequired: true,
    commands: ['fzf'],
  },
  {
    id: 'manual-tui-lazygit',
    title: 'lazygit navigation and resize workflow',
    mode: 'manual',
    area: 'tui',
    expectedOutcome:
      'Panel redraw, keyboard navigation, and split resizing remain stable while lazygit is running.',
    failureSignal:
      'Broken panel redraw, stuck keys, or resize instability.',
    blockerRule: 'Navigation or redraw regressions are blocked.',
    evidence: ['Auto Run Docs/xterm-6.1-manual-validation-protocol.md'],
    canaryRequired: true,
    commands: ['lazygit'],
  },
  {
    id: 'manual-agent-cli',
    title: 'Agent CLI streaming output workflow',
    mode: 'manual',
    area: 'tui',
    expectedOutcome:
      'Streaming agent output, prompt redraw, copy behavior, and project switching remain usable under the canary path.',
    failureSignal:
      'Streaming corruption, prompt instability, or continuity loss after switching away and back.',
    blockerRule: 'Any migration-only degradation in agent CLI usability is blocked.',
    evidence: ['Auto Run Docs/xterm-6.1-manual-validation-protocol.md'],
    canaryRequired: true,
    commands: ['Run a representative agent CLI session with sustained streaming output.'],
  },
]

export function getWorkflowValidationMatrix(): WorkflowValidationScenario[] {
  return [...AUTOMATED_WORKFLOW_SCENARIOS, ...MANUAL_WORKFLOW_SCENARIOS]
}

export function summarizeWorkflowValidationMatrix() {
  const matrix = getWorkflowValidationMatrix()
  return {
    total: matrix.length,
    automated: matrix.filter((scenario) => scenario.mode === 'automated').length,
    manual: matrix.filter((scenario) => scenario.mode === 'manual').length,
    canaryRequired: matrix.filter((scenario) => scenario.canaryRequired).length,
  }
}
