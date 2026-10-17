# Typography

`body` is `font-sans` (**Inter Variable**, then `sans-serif`). Code, the editor, and the terminal are `font-mono` (**Paper Mono**, then `monospace`). Both files are bundled. There is no font picker. A saved `terminalFontFamily` is ignored.

UI chrome stays at 14px (`text-sm`). Termul is a dense tool, so body copy is not 16px. Long-form markdown stays at `1rem`. Touch text fields stay at 16px.

Never `text-[Npx]`. Use the scale below. `tabular-nums` on every value that changes (counts, times, revisions).

## Size tokens

| Token | Size | Use |
|---|---|---|
| `text-base` | 16px | Every text field on a coarse pointer, through `pointer-coarse:text-base` (`Input` is `text-base md:text-sm pointer-coarse:text-base`) |
| `text-sm` | 14px | Body copy, labels, default `Button` |
| `text-xs` | 12px | Captions, helper lines, dense controls |
| `text-2xs` | 12px | Path chips, compact mono labels, SSH status words (`SSHHostStateWord`) |
| `text-3xs` | 12px | Status badges, settings footnotes |
| `text-4xs` | 12px | Git ref chips (`GitHistoryPanel` `RefChip`) |

Never go below 12px. `text-2xs`, `text-3xs`, and `text-4xs` share that size. Weight and color carry the difference. Paper Mono has no italic, so comments and emphasis stay upright.

## Text fields are 16px on touch

iOS Safari zooms the page when a text field with a computed font size under 16px takes focus. Every text field (`input`, `textarea`, `select`) is 16px on a coarse pointer, whatever its size on a fine pointer. The rule is keyed on pointer type, not width, so a landscape phone (768px or wider) is covered. `Input`, `Textarea`, `CommandInput`, `PopoverSearchBand` and `PANEL_FIELD_CLASS` carry `pointer-coarse:text-base` already. A raw field adds it next to its size (`text-xs pointer-coarse:text-base`), and `cn` keeps it when a caller passes `text-xs` or `text-sm`. Never `text-[16px]`, a global `input` rule, or `maximum-scale` in the viewport meta (it blocks pinch zoom). `ui/text-field-font-size.test.tsx` fails on a raw field that has neither the token nor an allowlist entry.

```
Is it the main sentence on the surface?
 ├── Yes → text-sm (text-foreground)
 └── No
      ├── Helper under a label → text-xs text-muted-foreground
      ├── Badge / chip in a 16–20px row → text-3xs (12px)
      └── Git ref / micro chip → text-4xs (12px)
```

## Incorrect

```tsx
<span className="text-[10px] text-gray-400">Connecting</span>
```

## Correct

```tsx
// SSHHostStateWord (ssh-host-status.tsx) — text-2xs + semantic status
<span className="text-2xs tabular-nums text-warning">Needs input</span>
```
