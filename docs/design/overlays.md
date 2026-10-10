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

A hand-rolled `fixed inset-0` overlay registers with `useOverlayRegistration(id, open, ownerClose, { mobileShellOnly: true })` so system back closes it on the phone shell; pass the owner's own close (its in-flight and unsaved-changes guards), never a bypass.

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

## Menus

`DropdownMenu`, `ContextMenu` and `Select` share `components/ui/menu-styles.ts`. Do not restyle rows at the call site.

- Shell: `rounded-xl border bg-popover p-1`. Rows: `min-h-8 rounded-lg px-2 text-xs`.
- Highlight (pointer or keyboard): `bg-foreground/[0.06]`. Never `bg-secondary` — in Termul Dark it equals `bg-popover`, so the highlight disappears.
- Selected or checked: a `Check` icon. No fill. Radio items also use `Check`.
- Group label: 11px, semibold, uppercase, tracked, `text-muted-foreground`.
- Destructive item: last, after a separator, `variant="destructive"`.
- Motion: every animated Radix overlay carries `motion-reduce:animate-none!` (important, because `data-[state=open]:animate-in` outranks a bare utility). Menus get it from `MENU_MOTION_CLASS`, so a new menu inherits it. A new animated primitive must add the token itself.

## Shell body

On the mobile shell, `MobileChatShell` sets `inert` on its body wrapper while a blocking overlay is registered in `overlay-stack-store`, so a screen reader cannot reach the chat log behind a sheet. An overlay that renders inside the shell body (the agent launcher, `ConfirmDialog` instances, the snapshot and new-project modals that the Snapshots page opens, the message actions menu) is exempt, or it would go inert with the rest and could not be tapped. Add the id to `isInertExemptOverlay` in `hooks/use-inert-behind-overlays.ts` when adding one, and assert it in the owner's registration test.

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
