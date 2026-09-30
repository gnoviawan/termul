# Typography

`body` is `font-sans` (`Inter Variable`, then system UI). Code-ish UI is `font-mono` (JetBrains Mono Variable). The code editor loads **Ioskeley Mono** via `@font-face` in `index.css` — do not substitute `font-mono` there. Terminal glyphs come from xterm font settings, not these stacks.

Never `text-[Npx]`. Use the scale below. `tabular-nums` on every value that changes (counts, times, revisions).

## Size tokens

| Token | Size | Use |
|---|---|---|
| `text-base` | 16px | Input on small viewports (`Input` is `text-base md:text-sm`) |
| `text-sm` | 14px | Body copy, labels, default `Button` |
| `text-xs` | 12px | Captions, helper lines, dense controls |
| `text-2xs` | 11px | Path chips, compact mono labels |
| `text-3xs` | 10px | Status badges (`SSHStatusBadge`), settings footnotes |
| `text-4xs` | 9px | Git ref chips (`GitHistoryPanel` `RefChip`) |

Never go below `text-4xs` (9px).

```
Is it the main sentence on the surface?
 ├── Yes → text-sm (text-foreground)
 └── No
      ├── Helper under a label → text-xs text-muted-foreground
      ├── Badge / chip in a 16–20px row → text-3xs
      └── Git ref / micro chip → text-4xs
```

## Incorrect

```tsx
<span className="text-[10px] text-gray-400">Connecting</span>
```

## Correct

```tsx
// SSHStatusBadge — text-3xs + semantic status
<span className="inline-flex items-center px-1.5 py-0.5 rounded text-3xs font-medium bg-warning/20 text-warning">
  Connecting
</span>
```
