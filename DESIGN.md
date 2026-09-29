# Termul design system

Termul is a dark-first desktop workspace. Colour is semantic OKLCH tokens written by `applyColorTheme` (`src/renderer/lib/themes/apply-color-theme.ts`). Shared primitives live in `src/renderer/components/ui`. `landing/` is out of scope.

This file is the entry for agents. Topic rules live in `docs/design/`. `docs/component-inventory.md` is a catalog of product surfaces, not a licence to invent variants.

## Layer rule

Components use semantic Tailwind tokens (`bg-background`, `text-destructive`, `bg-overlay/60`). Never Tailwind palette primitives (`bg-red-500`, `text-white`, `bg-black/50`). Never raw hex in renderer JSX. xterm and canvas that cannot take `oklch()` read hex through `readCssTokenHex`.

```
Need a colour?
 ├── Is it a semantic token in tailwind.config.ts / index.css?
 │    └── Yes → use that token
 └── No → stop. Add a token in applyColorTheme + index.css + Tailwind. Do not hardcode.
```

## Files

- [docs/design/colors.md](docs/design/colors.md) — fills, text, overlays, project vs status-bar
- [docs/design/typography.md](docs/design/typography.md) — font stacks and size tokens
- [docs/design/buttons.md](docs/design/buttons.md) — `Button` variants and sizes
- [docs/design/overlays.md](docs/design/overlays.md) — Dialog, Sheet, ConfirmDialog, AlertDialog
- [docs/design/status.md](docs/design/status.md) — success / warning / destructive / connection
- [docs/design/forms.md](docs/design/forms.md) — Input, Label, Switch, Select, Textarea
