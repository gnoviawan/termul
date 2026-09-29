# Overlays

Pick one shell. Do not stack a second overlay library.

| Shell | File | When |
|---|---|---|
| `Dialog` | `ui/dialog.tsx` | Centered form or detail (max-w-lg). Overlay `bg-overlay/90`. |
| `Sheet` | `ui/sheet.tsx` | Slide-over. `side`: `top` \| `bottom` \| `left` \| `right` (default `right`). Overlay `bg-overlay/80`. Mobile bottom sheets use `side="bottom"`. |
| `ConfirmDialog` | `ConfirmDialog.tsx` | Desktop yes/no. Variants: `default` \| `danger` (not `destructive`). Overlay `bg-overlay/60`. |
| `AlertDialog` | `ui/alert-dialog.tsx` | Confirm already inside chat/mobile Radix trees (`ChatMessage`, `MobileFileExplorer`). Overlay `bg-overlay/80`. |
| `SettingsModal` | `settings/SettingsModal.tsx` | Wide settings shell only. Do not replace with `Dialog`. Overlay `bg-overlay/60`. |
| `Popover` | `ui/popover.tsx` | Non-blocking extra UI (`ContextBarSettingsPopover`). |

`Drawer` (`ui/drawer.tsx`, vaul) has no product call site. Do not add a second bottom-sheet stack — use `Sheet` `side="bottom"`.

New preference groups mount in `SettingsSection` inside `SettingsModal` (`AppPreferences`, `ProjectSettings`). Do not open a standalone `Dialog` as a settings page.

Hand-rolled `fixed inset-0` scrims must use `bg-overlay/{40–90}`, never `bg-black`. Command palette / shortcut overlay uses `/40`. Default new centered modal: `Dialog`, not a custom motion card.

```
Is it a confirm (yes/no, hard to undo)?
 ├── Desktop settings / sidebar / SSH → ConfirmDialog (danger if destructive)
 ├── Chat or mobile already on Radix → AlertDialog
 └── Else → ConfirmDialog
Is it a slide-over?
 └── Sheet
Is it the app settings window?
 └── SettingsModal
Default → Dialog
```

## Correct

```tsx
// AppPreferences.tsx
<ConfirmDialog
  isOpen={isResetDialogOpen}
  title="Reset Settings"
  message="Are you sure you want to reset all application settings to their default values? This cannot be undone."
  confirmLabel="Reset"
  cancelLabel="Cancel"
  variant="danger"
  onConfirm={handleResetConfirm}
  onCancel={() => setIsResetDialogOpen(false)}
/>
```

## Incorrect

```tsx
<div className="fixed inset-0 bg-black/60" />
<ConfirmDialog variant="destructive" />
<Drawer><DrawerContent>…</DrawerContent></Drawer>
```
