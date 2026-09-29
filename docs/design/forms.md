# Forms

Use primitives in `src/renderer/components/ui`. Wire `Label htmlFor` to the control `id`. Placeholder is not a label.

| Control | File | When |
|---|---|---|
| `Input` | `input.tsx` | Single-line text. Height 40px (`h-10`); dense dialogs use `h-9` (`CustomAgentDialog`). |
| `Textarea` | `textarea.tsx` | Multi-line (`min-h-[80px]`). |
| `Switch` | `switch.tsx` | Boolean on/off. Label the state it turns on. |
| `Select` | `select.tsx` | Exclusive pick from a known list. |

`Checkbox`, `RadioGroup`, and `Form` exist under `ui/` and have **no** product call sites. Do not start a second boolean pattern — use `Switch`. Do not start a radio pattern — use `Select`. Do not add `react-hook-form` `Form` unless the task is to adopt that primitive across settings.

AppPreferences still has native `<select>` and custom toggle knobs. That is legacy. New settings use `Select` and `Switch` (`ContextBarSettingsPopover`, `CustomAgentDialog`).

AppPreferences persists on each control change — do not add a footer Save. ProjectSettings uses the `SettingsModal` footer Save (`variant` default). One filled `Button` in that footer.

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
<button role="switch" className="bg-primary"><span className="bg-white rounded-full" /></button>
<select className="bg-secondary"><option>Stable</option></select>
```
