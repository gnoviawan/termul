# Status

Status colour is a role, not a hue. Pair it with a label or icon — never colour alone.

| Role | Tokens | Meaning |
|---|---|---|
| `success` | `text-success`, `bg-success/20` | Connected, completed, added (when not in a diff view) |
| `warning` | `text-warning`, `bg-warning/20` | In progress, conflict, caution |
| `destructive` | `text-destructive`, `bg-destructive/20` | Failed, delete, error |
| `connection` | `text-connection`, `bg-connection` | Live connection lamp only — not success green |
| `muted` | `text-muted-foreground` | Offline / idle |

`diff-modified` marks changed files in git lists. Do not use `warning` for “this file changed”. Diff line additions use `diff-added`; deletions use `destructive`.

SSH (`SSHStatusBadge.tsx`): disconnected → muted; connecting **and** reconnecting → `warning`; connected → `success`; failed → `destructive`. Do not split reconnecting onto `project-orange`.

StatusBar is quiet: `h-7 border-t border-border bg-card text-2xs text-muted-foreground`. Do not use `bg-status-bar*`, `bg-project-*` or `text-primary-foreground` on the bar. The project colour is in the 14px project glyph only.

- Use the constants in `components/status-bar-hit.ts`. Do not copy the class strings.
- Text items: `STATUS_BAR_ITEM_CLASS` (`h-6 rounded-md px-2`) with `STATUS_BAR_HOVER_CLASS` (`hover:bg-foreground/[0.03] hover:text-foreground`). An item with no action (the project label) has no hover and `cursor-default`.
- Icon buttons and popover triggers: `STATUS_BAR_HIT_TARGET` (`size-6`, 44px box on coarse pointers) with the glyph in `STATUS_BAR_HIT_GLYPH`.
- Open trigger (branch picker, popovers): `STATUS_BAR_OPEN_CLASS` (`bg-foreground/[0.06]`). Focus: neutral `ring-1 ring-ring`.
- Git counts: `diff-modified` (pencil), `diff-added` (plus), muted (untracked). Numbers use `tabular-nums`.
- Exit code: `Check` / `X` icon and "Exit N" in bar ink. No status colour.
- Remote access on: `Monitor` icon in `text-connection`. Web connection lamp: status tone (`connection` / `warning` / `destructive`).
- A chat that needs you: `rounded-md bg-warning/10 text-warning font-medium` pill with a 6px `bg-warning` dot.
- No blue (`primary`) on the bar. The bar has no live-work signal.

```
Is it git diff line paint?
 ├── Addition → diff-added
 ├── Deletion → destructive
 └── Modified file in a list → diff-modified
Is it a live lamp (SSH/agent connected)?
 └── connection or success per existing lamp component — do not invent a third green
Is it in-progress (connecting, conflict banner)?
 └── warning
Failed / delete → destructive
```

## Correct

```tsx
connecting: { label: 'Connecting', color: 'bg-warning/20 text-warning' },
reconnecting: { label: 'Reconnecting', color: 'bg-warning/20 text-warning' },
connected: { label: 'Connected', color: 'bg-success/20 text-success' },
failed: { label: 'Failed', color: 'bg-destructive/20 text-destructive' },
```

Warning copy on a banner uses `bg-warning/10 text-warning` (`WorkspaceConflictBanner`). `Alert` variants are `default` | `destructive` only (`ui/alert.tsx`) — there is no `warning` Alert.

Toasts (Sonner and the Radix toaster) use the active theme card: `bg-card`, `border-border`, `text-foreground`, description `text-muted-foreground`. They follow light themes and the other families. Do not enable Sonner `richColors`. Info and default icons use `muted-foreground`. Success, warning, and error icons use `success`, `warning`, and `destructive`. The card surface stays the same for every toast type. Dark appearance may add a drop shadow. Termul light uses the hairline only.

## Incorrect

```tsx
<span className="bg-green-500/20 text-green-600">Connected</span>
<div className="h-6 bg-project-yellow text-white" />
<Alert variant="warning">Workspace changed</Alert>
```
