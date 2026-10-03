# Buttons

Use `Button` from `src/renderer/components/ui/button.tsx` for actions. Navigation styled as a button is a link (`variant="link"`) or a router target, not a fake button.

Icon-only in chat/streamdown chrome uses `IconActionButton` (`label` required). Icon-only in toolbars uses `Button` `size="icon"` / `icon-sm` / `icon-xs`.

Variants (union in `buttonVariants`): `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`, `composer`. `primary` is not a variant. `default` and `composer` share one filled primary chrome: `bg-primary-fill`, layered emboss, a hover mix that keeps the hue, and a muted disabled fill. Composer send, stop, and launch use `variant="composer"`. Other primary actions use `default`. Send and stop share that chrome; only the glyph changes (arrow vs square). They do not show at the same time, so the view still has one primary.

Sizes: `default`, `xs`, `sm`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`, `touch`. `touch` is the 44px mobile floor (`WorkspaceSnapshots`). Default size is `default` (h-10).

```
Is it composer send, stop, or launch (ChatInputBar / AgentLauncher)?
 ├── Yes → variant="composer", size icon-sm | icon | touch
 └── No
      ├── Single most important action on the screen? → variant="default"
      ├── Destructive or hard to undo → variant="destructive" (bg-destructive-fill)
      ├── Cancel / dismiss next to a default button → variant="outline" or ghost
      ├── Quiet toolbar / icon in a list → variant="ghost"
      ├── Text navigation → variant="link"
      └── Secondary action in a group → variant="secondary"
```

One `default` per view. Two filled primary buttons means the screen has no hierarchy (`WorkspaceConflictBanner` keeps one `default`).

## Correct

```tsx
// CustomAgentDialog.tsx
<Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
  Cancel
</Button>
<Button size="sm" onClick={() => void handleSave()} disabled={saving}>
  {saving ? 'Saving…' : 'Create Agent'}
</Button>
```

## Incorrect

```tsx
<Button variant="primary">Save</Button>
<Button className="bg-blue-600 text-white">Save</Button>
```
