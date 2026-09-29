# Colors

Tokens are OKLCH `"L C H"` on `:root`. Tailwind maps `oklch(var(--token) / <alpha-value>)`. `applyColorTheme` overwrites `:root` at startup. Fallbacks live in `src/renderer/index.css`.

## Allowed layers

1. Semantic roles: `background`, `foreground`, `card`, `popover`, `primary`, `primary-fill`, `secondary`, `muted`, `accent`, `destructive`, `destructive-fill`, `success`, `success-fill`, `warning`, `connection`, `border`, `input`, `ring`, `overlay`.
2. Product identity: `project-{blue,purple,green,yellow,red,cyan,pink,orange,gray}` — chips, graph lanes, pickers only.
3. Chrome bar: `status-bar` and `status-bar-{color}` — StatusBar fill only. Same hue as project, L ~0.47 so `primary-foreground` meets WCAG AA 4.5:1.
4. Diff: `diff-added`, `diff-modified` (changed files, not a warning). Deletions use `destructive`.
5. Terminal grid: `terminal-bg` / `terminal-fg`. `terminal-bg` equals `background`. xterm `theme.background` must use the same hex. Do not leave the xterm viewport at `#000`.

Nothing else exists. `green-500`, `amber-400`, `white`, `black` are bugs.

`--primary`, `--success`, `--warning`, and `--destructive` are text-on-card tokens (AA-shifted). Solid primary / success / destructive buttons use `bg-primary-fill` / `bg-success-fill` / `bg-destructive-fill` with matching `*-foreground`. Solid warning buttons use `bg-warning text-warning-foreground`. `--accent` is a selected-row fill (`bg-accent` + `text-accent-foreground`), not body text. Fill L is ≤ 0.55 so near-white ink meets AA. Washes stay on the text token (`bg-primary/10 text-primary`).

## Background

```
Is it the page or the Terminal grid?
 ├── Yes → bg-background or bg-terminal-bg (same colour)
 └── No
      ├── Raised panel / modal card → bg-card
      ├── Menu / select list → bg-popover
      ├── Recessed well / hover wash → bg-secondary or bg-muted
      └── Scrim behind a modal → bg-overlay/{40–90} (see overlays.md)
```

## Text

```
On background / card / popover?
 ├── Primary copy → text-foreground
 ├── Secondary copy / labels → text-muted-foreground
 ├── Disabled copy (custom chrome) → text-disabled-foreground
 └── On a solid primary / destructive / success fill → matching *-foreground
```

On a project StatusBar, ink is `text-primary-foreground`, never `text-white`. Git counts, exit code, and lamps on the bar use that ink plus icon shape — not `text-success` / `text-warning`.

## Incorrect

```tsx
// Incorrect — palette primitive
<p className="text-red-400">Failed to load</p>
<div className="bg-black/50" />
```

```tsx
// Correct — from FileExplorer.tsx
<p className="text-sm text-destructive">Failed to load project files.</p>
<div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/50" />
```
