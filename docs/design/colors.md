# Colors

Tokens are OKLCH `"L C H"` on `:root`. Tailwind maps `oklch(var(--token) / <alpha-value>)`. `applyColorTheme` overwrites `:root` at startup. Fallbacks live in `src/renderer/index.css`.

## Allowed layers

1. Semantic roles: `background`, `foreground`, `card`, `popover`, `primary`, `primary-fill`, `secondary`, `muted`, `accent`, `destructive`, `destructive-fill`, `success`, `success-fill`, `warning`, `connection`, `border`, `input`, `ring`, `overlay`.
2. Product identity: `project-{blue,purple,green,yellow,red,cyan,pink,orange,gray}` — chips, graph lanes, pickers only.
3. Chrome bar (legacy): `status-bar` and `status-bar-{color}`. The StatusBar does not use them now. The tokens stay for back-compat (`statusBarColors` in `lib/colors.ts`). Do not use them in new UI.
4. Diff: `diff-added`, `diff-modified` (changed files, not a warning). Deletions use `destructive`.
5. Terminal grid: `terminal-bg` / `terminal-fg`. `terminal-bg` equals `background`. xterm `theme.background` must use the same hex. Do not leave the xterm viewport at `#000`.

Nothing else exists. `green-500`, `amber-400`, `white`, `black` are bugs.

The default dark theme (`termul`) paints neutrals from an explicit ramp. Other themes still derive surfaces from one neutral plus a 4% brand tint. Brand fill stays the composer blue: palette `primary` and `accent` are `#3b82f6`, and `--primary-fill` is the solid-fill step of that blue.

| Token | Role | Source |
| --- | --- | --- |
| `background`, `terminal-bg`, `surface-darker` | Page canvas | Void `#08090a` |
| `card`, `surface-dark` | Raised panel | Carbon `#0f1011` |
| `popover`, `secondary`, `sidebar-background` | Menu, hover, sidebar | Obsidian `#161718` |
| `muted` | Recessed well | Midpoint of Obsidian and the border, same hue |
| `border`, `input` | Hairline | Graphite lightness on the Void hue (`#23252a` drifts off that hue) |
| `foreground` | Primary copy | Bone `#e5e5e6` |
| `secondary-foreground` | Secondary labels | Mist `#d0d6e0` |
| `muted-foreground` | Muted copy | Fog `#8a8f98` |
| `ring` | Focus | Bone |

The default light theme (`termul-light`) uses the paper ramp. Page, card, and popover are the same white, so a raised pane needs `border-border` to separate from the page. The primary button uses the same blue as Termul dark: palette `primary` is `#3b82f6`, so `--primary-fill` matches. Status hues stay. `data-flat-elevation` removes drop shadows on surfaces only. `button` and `[data-keep-shadow]` keep their emboss, including `Button` used as a link and the switch thumb. Other families keep derived surfaces.

| Token | Role | Source |
| --- | --- | --- |
| `background`, `terminal-bg`, `card`, `popover` | Main canvas and panels | Paper `#ffffff` |
| `sidebar-background`, `muted` | Sidebar and quiet well | Sidebar mist `#f9f9f9` |
| `secondary` | Hover | 5% black on paper |
| `border`, `input` | Hairline | 10% black on paper |
| `foreground` | Primary copy | Graphite ink `#0d0d0d` |
| `secondary-foreground` | Secondary labels | Mid ash `#5d5d5d` |
| `muted-foreground` | Muted copy | Hollow `#8f8f8f`, lifted if it misses AA |

`--primary`, `--success`, `--warning`, and `--destructive` are text-on-card tokens (AA-shifted). Solid primary / success / destructive buttons use `bg-primary-fill` / `bg-success-fill` / `bg-destructive-fill` with matching `*-foreground`. Solid warning buttons use `bg-warning text-warning-foreground`. Do not use `--accent` for new state. It is maroon in Termul Light. Selection, hover and focus are neutral (see State). Washes stay on the text token (`bg-primary/10 text-primary`).

## State

| State | On `background` / `card` | On `popover` |
| --- | --- | --- |
| Hover | `bg-foreground/[0.03]` | `bg-foreground/[0.06]` |
| Selected / you are here | `.keycap` (index.css) | `Check` icon, no fill |
| Active segment in a track | `.keycap` | `bg-foreground/10` |
| Focus | neutral `ring` | neutral `ring` |

Blue (`primary`, `primary-fill`) has three jobs only: live work (a running agent, a working spinner, a drop target), the one primary button in a view, and count badges that ask for attention (`CountBadge` in `components/ui/count-badge.tsx`: the Git change count on the activity rail and the Git Changes tab, `bg-primary-fill text-primary-foreground`). Focus, selection and hover stay neutral.

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

The StatusBar is quiet: `bg-card`, `border-t border-border`, ink `text-muted-foreground`. Labels use `text-secondary-foreground`. The project colour is in the project glyph (`ProjectIcon`), not in the bar fill. Never `text-white` or `text-primary-foreground` on the bar.

## Syntax

Code color is not a UI token. The editor, chat fences, and diffs share one map: `resolveSyntaxColors`. Termul's map is `termul-syntax.ts`. Other families keep their own overrides.

Termul follows the Cursor editor. Teal is a keyword. Peach is a declared function or type name. Blue is a name being read. Lavender is a name being declared, and also a JSX tag. Pink is a string. Comments stay neutral gray. Property names stay on the foreground.

Roles that sit next to each other stay at least 15° apart in OKLCH hue. Do not use the olive, brown, and khaki set from VS Code Dark+ (`#6a9955`, `#ce9178`, `#dcdcaa`). Do not use the UI blue (`primary`) as a syntax hue. Each syntax color must clear WCAG AA (4.5:1) on the theme background and on the card.

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
