# Typography

`body` is `font-sans` (`Inter Variable`, then system UI). Code-ish UI is `font-mono` (JetBrains Mono Variable). The code editor loads **Ioskeley Mono** via `@font-face` in `index.css` — do not substitute `font-mono` there. Terminal glyphs come from xterm font settings, not these stacks.

Never `text-[Npx]`. Use the scale below. `tabular-nums` on every value that changes (counts, times, revisions).

## Size tokens

| Token | Size | Use |
|---|---|---|
| `text-base` | 16px | Every text field on a coarse pointer, through `pointer-coarse:text-base` (`Input` is `text-base md:text-sm pointer-coarse:text-base`) |
| `text-sm` | 14px | Body copy, labels, default `Button` |
| `text-xs` | 12px | Captions, helper lines, dense controls |
| `text-2xs` | 11px | Path chips, compact mono labels |
| `text-3xs` | 10px | Status badges (`SSHStatusBadge`), settings footnotes |
| `text-4xs` | 9px | Git ref chips (`GitHistoryPanel` `RefChip`) |

Never go below `text-4xs` (9px).

## Text fields are 16px on touch

iOS Safari zooms the page when a text field with a computed font size under 16px takes focus. Every text field (`input`, `textarea`, `select`) is 16px on a coarse pointer, whatever its size on a fine pointer. The rule is keyed on pointer type, not width, so a landscape phone (768px or wider) is covered. `Input`, `Textarea`, `CommandInput`, `PopoverSearchBand` and `PANEL_FIELD_CLASS` carry `pointer-coarse:text-base` already. A raw field adds it next to its size (`text-xs pointer-coarse:text-base`), and `cn` keeps it when a caller passes `text-xs` or `text-sm`. Never `text-[16px]`, a global `input` rule, or `maximum-scale` in the viewport meta (it blocks pinch zoom). `ui/text-field-font-size.test.tsx` fails on a raw field that has neither the token nor an allowlist entry.

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
