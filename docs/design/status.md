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

StatusBar fill: `bg-status-bar` with no project; `bg-status-bar-{color}` with a project. Never `bg-project-*` on the bar (those swatches are too light for `primary-foreground`). Ink on the bar is `text-primary-foreground`. Hover wash: `hover:bg-primary-foreground/10`.

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

## Incorrect

```tsx
<span className="bg-green-500/20 text-green-600">Connected</span>
<div className="h-6 bg-project-yellow text-white" />
<Alert variant="warning">Workspace changed</Alert>
```
