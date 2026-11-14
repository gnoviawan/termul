# Sidebar V2: handoff checklist

Status: design final (2026-11-14). Implemented in steps P1 to P5 (2026-11-15). The checklist ticks what the code has; the "Code now" columns show the code before P1.
Design source: Paper file "Termul Design System", page **Troupe Design - V2** (rows 1 and 2), and the **Shell** page, board **Sidebar**.

Scope: the shell rail in its expanded and collapsed states, the hover panels of the collapsed rail, and the open workspace tab label. `AGENTS.md` asks to check every surface: the browser client renders the same rail, so check it too.

## Final frames

| Frame | What it shows |
|---|---|
| `2.2 New chat / ASCII glow (MAIN SCREEN)` | Expanded sidebar, final reference |
| `2.3 New chat / Collapsed sidebar` | Collapsed rail, 1:1 with the expanded sidebar |
| `2.4 New chat / Collapsed, hover chat` | Hover a chat icon: chat list peek |
| `2.5 New chat / Collapsed, hover project` | Hover a project icon: project card |
| `2.6 New chat / Collapsed, hover nav` | Hover a nav icon: tooltip with shortcut |
| `1.2 Shell / Collapsed sidebar` | Collapsed rail on a working chat |

All other V2 screens use the same expanded sidebar. The old icon-stack collapsed rail is archived ("Old · New chat, collapsed icon rail (not chosen)").

## Decisions

| Topic | Decision |
|---|---|
| Shortcut hints | Removed from the nav rows (no ⌘N, no ⌃K Kbd). The shortcut shows in the hover tooltip. |
| Text colour | Nav rows, project names and chat titles use `secondary-foreground`. Troupe logos stay `foreground`. |
| Open tab label | The open workspace tab label uses `secondary-foreground` (was `foreground`). |
| Collapsed rail | The expanded sidebar with the labels removed. Each icon keeps its y position. |
| Hover | Hover on a collapsed icon opens a panel next to the rail that shows what the icon stands for. |
| Change count badge | Blue `CountBadge` (`primary-fill`), as in code. |

## Spec: expanded sidebar (width 248)

| Part | Value | Code now |
|---|---|---|
| Nav section | padding 8 / 8 / 10, row gap 1 | — |
| Nav row | height 28, inset 12 / 12, icon–label gap 8, icon 14, text 12/16 `secondary-foreground` | `RailRow`: `h-8`, `RAIL_ROW_INSET_CLASS` `gap-2 px-2`, icon box `size-4`, Kbd chip |
| Section header ("Projects") | height 40, padding-top 12, label inset 18, `muted-foreground` 12/16 | `rail-section-header.tsx` |
| Project list | padding-top 2, inset 8, row gap 1 | `project-list.tsx` |
| Project row | height 30, inset 12 / 12, icon 16, gap 8 | `project-item.tsx`: `h-8 … text-xs` |
| Chats under a project | group padding-bottom 4, row gap 1 | — |
| Chat row | height 30, indent 35 (icon under the project name), right 12, gap 9 | `project-chat-row.tsx` |
| "Show N more" | height 28, indent 56 | — |
| Open chat row | keycap: `muted` fill + `inset 0 1px 0 #E5E5E614, 0 1px 2px #00000040` | — |
| Long titles | no "…": fade over the last 24px (`mask-image: linear-gradient(to right, black calc(100% - 24px), transparent)`), text box fills the row | `truncate` |
| Footer | 4 icon buttons, 32 box, icon 14 | `RailFooter.tsx` |

## Spec: collapsed rail (width 48, `COLLAPSED_WIDTH`)

| Part | Value |
|---|---|
| Structure | Same rows and the same vertical metrics as the expanded sidebar. Labels, meta and status hidden. Icons centred in a 32px row. |
| Header row (44) | Only the macOS traffic lights. The open-sidebar toggle sits in the tab bar right of them (tab bar padding-left 24). |
| Nav icons | Same y as expanded: 65 / 94 / 123 / 152 (row centres, from the window top). |
| "Projects" header | A 20×1 divider in `border`, at the header y. |
| Projects and chats | Project icon and agent icon at the row y. The open chat stays raised (keycap). "Show N more" becomes "···". |
| SSH section | Hidden. |
| Footer | Icons stack upward from the bottom (column-reverse, gap 4). Settings keeps its place at the bottom. |

Code now: `RailCollapsed.tsx` draws a different stack (project stack card, Chats button, Actions, Pinned). It must change to the 1:1 layout above.

## Spec: hover panels (collapsed rail only)

| Panel | Trigger | Content | Position |
|---|---|---|---|
| Chat list peek | a chat icon | the project row + all its chat rows, with titles and status (spinner, New, Needs you); hovered row has the hover fill; open chat keycap | x = 52 (rail + 4); rows at the same y as the rail icons |
| Project card | a project icon | the project row: name + diff stat | x = 52, row at the icon y |
| Nav tooltip | a nav icon | label + shortcut Kbd (keycap) | x = 52, centred on the icon; height 28 |

Surface: `popover` fill, radius 10 (tooltip 8), 0.5px edge (`#38393A` until a token exists), shadow `0 1px 2px #00000099, 0 4px 8px -4px #00000080`, padding 4, row gap 1. Hovered rail icon: `color-mix(in oklab, var(--foreground) 6%, transparent)`, radius 6. Motion: use the existing tooltip motion; no new curve.

Code now: `RailRow` shows a `Tooltip` with label + hint. The chat peek and the project card are new.

## Open workspace tab

| Part | Value | Code |
|---|---|---|
| Open tab label | `secondary-foreground` | `WorkspaceTabBar.tsx` |

## Checklist

- [x] Expanded rail rows: heights, insets, 1px gaps, 14px nav icons, no Kbd chips
- [x] Text colours: `secondary-foreground` for nav, project and chat labels
- [x] Long titles fade instead of "…" (rows only; multi-line keeps line-clamp)
- [x] Collapsed rail rebuilt as 1:1 with the expanded rail (`RailBody.tsx` with `rail-density.tsx`; `RailCollapsed.tsx` is removed)
- [x] Open-sidebar toggle in the tab bar, right of the traffic lights, when collapsed
- [x] Hover chat peek, project card, nav tooltip with shortcut
- [x] Open tab label `secondary-foreground`
- [ ] Browser client checked in a real browser (code review and the parity checklist pass; P1 was checked in the browser, P2–P5 not yet)
- [x] Durable logs for new flows if any are added (`src/renderer/lib/log-api.ts`)
- [ ] Light theme checked (design is dark only)

### P4: what moved out of the removed panels

The Side panel Chats tab, its header Workspace switcher and the StatusBar are gone (P1 to P3). P4 gives their remaining jobs a place:

- [x] Worktree switch: the project row menu (right-click, Shift+F10 or the context-menu key, or the row "…" button on the expanded rail) has "Switch worktree…". It opens the working copies popover on the row (`shell/rail/worktree-switcher.tsx`: search, create, a terminal action per row). The pick stays in `shell-layout-store.worktreePickByProject`.
- [x] Worktree chip: a muted chip under the project name with the picked worktree, only when the pick is not the project folder. The collapsed rail keeps its line (18px) with a branch glyph, so the icons keep their y; the chat peek repeats the chip.
- [x] StatusBar information (git counts, cwd, exit code, needs-you pill) is dropped. The context bar settings (popover, store, loader) are removed; a stored `settings/context-bar` value is not read.
- [x] Shell picker: right-click, Shift+F10 or the context-menu key on the tool strip Terminal button lists the detected shells (default first); a pick opens a terminal tab with that shell. A click opens the default shell. The tooltip says "Right-click for other shells".
- [x] Windows and Linux window controls: in the window's top-right corner, above the tool strip (the strip starts 44px lower). The top row surface on their left (right panel header when the panel is open, else the tab bar, SSH header or fallback bar) ends with a 76px drag spacer. macOS is unchanged.
- [x] Chat search: the command palette has a "Chats" group while there is a query. It searches every chat of the open project (title, agent, branch, model) and opens the picked chat. The rail "Search" row opens the palette.
- [x] Import chats: an item in the Projects `+` menu, for the open project's working copy (disabled with the reason on a read-only server).
- [x] Durable logs: worktree switch from the rail, shell picked from the strip, chat import started, chat opened from the palette.
- [ ] Paper has no frame for the worktree chip, the row "…" button or the shell menu yet.

### P5: phone, browser parity, clean-up

- [x] Phone: the phone shell mounts no Rail, tool strip or right panel (`WorkspaceLayout.mobile.test.tsx`, e2e `mobile-drawer-home`).
- [x] Phone drawer chat rows use the Rail live state (`useChatLiveState`) and the Rail trail (`ChatRowTrail`): one status per chat (Needs you, then Running, then New), the same as the desktop Rail. The rows keep their layout and the created time. `AgentChatStatusGlyphs` and `agentChatStatusSlots` are removed.
- [x] Browser client (desktop width): the tool strip has no Remote access and no Browser button (browser tabs are native webviews; the palette command and the shortcut are gated the same way); it shows the connection lamp. Covered by `ShellToolStrip.test.tsx` and the parity checklist.
- [x] Parity checklist: tool strip gating, the palette Chats group and the Projects menu Import item.
- [x] E2E specs use the V2 UI: Rail chat rows (`rail-project-chats`), tool strip buttons, the command palette Chats group, tab drag for splits. Helpers in `tests/e2e/ui.ts`: `railChat`, `showAllRailChats`, `openRightPanelView`.
- [x] Orphans removed: the `icon` variant of `ImportChatsButton`, `ProjectSwitcher`, `sidebar-search-field`.

## Open items

- A chat can no longer be dragged onto a pane edge from the chat list (the Chats cards had it). The Rail chat rows are not draggable, and `startChatDrag` in `use-pane-dnd.tsx` has no caller. Decide: add drag to the Rail rows, or remove the chat drag path.
- The collapsed rail shows a status dot on the agent icon (P2).
- The design shows a dark theme only. Light-theme values come from the same tokens.
