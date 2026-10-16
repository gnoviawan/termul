# Forms

Use primitives in `src/renderer/components/ui`. Wire `Label htmlFor` to the control `id`. Placeholder is not a label.

| Control | File | When |
|---|---|---|
| `Input` | `input.tsx` | Single-line text. Height 40px (`h-10`); dense dialogs use `h-9` (`CustomAgentDialog`). |
| `Textarea` | `textarea.tsx` | Multi-line (`min-h-[80px]`). |
| `Switch` | `switch.tsx` | Boolean on/off. Label the state it turns on. |
| `Select` | `select.tsx` | Exclusive pick from a known list. |

`Checkbox`, `RadioGroup`, and `Form` exist under `ui/` and have **no** product call sites. Do not start a second boolean pattern — use `Switch`. Do not start a radio pattern — use `Select`. One exception: a pick-one list whose options carry live data to compare (Project Settings → Provider, where each account shows its usage) is a `role="listbox"` of `role="option"` rows with a `Check` on the chosen row, like menu rows, with arrow-key focus and Enter/Space to choose. Do not add `react-hook-form` `Form` unless the task is to adopt that primitive across settings.

AppPreferences still has native `<select>` and custom toggle knobs. That is legacy. New settings use `Select` and `Switch` (`ContextBarSettingsPopover`, `CustomAgentDialog`).

AppPreferences persists on each control change — do not add a footer Save. ProjectSettings uses the `SettingsModal` footer Save (`variant` default). One filled `Button` in that footer.

Every text field is 16px on a coarse pointer so iOS Safari does not zoom when it takes focus: `Input` is `text-base md:text-sm pointer-coarse:text-base`, and a raw `<input>`, `<textarea>` or `<select>` adds `pointer-coarse:text-base` next to its size. Never `text-[16px]`. See [typography.md](typography.md).

## Focus

Every text field and select shows keyboard focus in the neutral `ring` token, never blue. Use the constants in `ui/panel-styles.ts`; `Input`, `Textarea`, `SelectTrigger`, `CommandInput`, `PopoverSearchBand` and `PANEL_FIELD_CLASS` carry them already.

| Field | Class | Focus looks like |
|---|---|---|
| Bordered or underlined | `FIELD_FOCUS_CLASS` | The hairline turns `ring` |
| Borderless with a fill | `FOCUS_RING_CLASS` | A 1px `ring` edge |
| Inside a search band | `INNER_FIELD_FOCUS_CLASS` on the field, `BAND_FOCUS_CLASS` on the band | The band's hairline turns `ring`; no box around the input |

All three use `focus-visible` with `outline-hidden`, so Windows forced-colors mode still draws a system outline. Never `focus:ring-primary`, a bare `focus:` ring, `ring-offset-2` on a field, or `outline-none` with no replacement. `ui/text-field-focus.test.tsx` fails on a raw `<input>`, `<textarea>` or `<select>` that breaks this.

Keep submit enabled until the request starts. Then `disabled` on the submit `Button`. Do not block paste on `Input`.

```
Boolean?
 └── Switch + visible label
Exclusive list (2+ named options)?
 └── Select (SelectTrigger, SelectContent, SelectItem)
One line of text?
 └── Label + Input
Many lines?
 └── Label + Textarea
```

## Correct

```tsx
// CustomAgentDialog.tsx
<Label htmlFor="agent-prompt-flag" className="text-xs">
  Prompt flag
</Label>
<Input
  id="agent-prompt-flag"
  value={form.promptFlag}
  onChange={(e) => update('promptFlag', e.target.value)}
  placeholder="e.g. -i, --prompt"
  className="h-9 font-mono text-sm"
/>
<Select value={form.promptMode} onValueChange={(v) => update('promptMode', v)}>
  <SelectTrigger className="h-9">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="positional">Positional — prompt appended after args</SelectItem>
  </SelectContent>
</Select>
```

```tsx
// ContextBarSettingsPopover.tsx
<Switch checked={checked} onCheckedChange={onCheckedChange} />
```

## Incorrect

```tsx
<input className="border-gray-500 bg-white" />
<button role="switch" className="bg-primary-fill"><span className="bg-white rounded-full" /></button>
<select className="bg-secondary"><option>Stable</option></select>
```
