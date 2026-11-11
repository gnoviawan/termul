# Preferences redesign — hand-off checklist

Status: implemented in pull request #1380 (2026-10-18). Items that are still open stay unchecked below.
Design source: `termul-design.pen`, section **"Preferences — redesign (v2)"**. The canvas frame for this file is `Prefs v2 · Shared · Hand-off checklist`.

Scope is the desktop Application Preferences modal (`src/renderer/pages/AppPreferences.tsx`). `AGENTS.md` asks to check every surface: the browser client renders the same React pages, so check it too. Keep each file under about 800 lines and split leaf components and hooks.

## Decisions

| Topic | Decision |
|---|---|
| Navigation | One page per category. Scroll-spy over one long page is removed. |
| Visual direction | Current Troupe tokens (OKLCH, Inter, keycap). New structure and components. |
| Surfaces | Desktop modal. Browser client to be checked with the parity checklist. |
| Pilot | Editor + Notifications (from the old Behavior section). |

### Sitemap (14 pages in 4 groups)

| Group | Pages |
|---|---|
| General | Interface · Notifications · Editor |
| Terminal | Appearance · Shell · Profiles |
| Agents | Agent chats · Skills · Accounts · MCP servers |
| App | Keyboard shortcuts · Updates · Logs · Reset |

Old → new: Behavior splits into Interface (terminal links move to Appearance), Editor and Notifications. New Project Defaults moves into Interface. Provider is renamed Accounts. Diagnostics & Logs is renamed Logs. AI Agents is renamed Agent chats.

## Canvas map

The section header "Preferences — redesign (v2)" is at y ≈ 23 000. The columns follow the sidebar order:

| Column | Frames |
|---|---|
| 00 Shared | `Prefs v2 · Components`, `… · Shared · Pilot states and spec`, `… · Shared · Hand-off checklist` |
| 01–14 Pages | `Prefs v2 · <Group> · <Page> — default`, then `… · States`. Extra frames: Editor (auto save off, narrow), Interface (narrow), Accounts (narrow), MCP servers (narrow), Keyboard shortcuts (scrolled, header stays) |
| 15 Sidebar search | Results (with jump target), no results |

The as-built reference (rebuilt from the current code) is the section "Preferences — as-built" at y ≈ 17 700.

## Spec

1. One page per category. 14 pages in 4 sidebar groups replace 13 sections in one long scroll.
2. No modal header bar. The sidebar holds the title and search; the page header holds the title, one line of help and Close.
3. Content is full width (720px). The 1/3 title column is gone, so lists get the room they need.
4. One row anatomy for every setting: label and description left, control right. No double labels.
5. A dependent setting is indented under its switch. When it is off, it says why.
6. Every Select and Switch has a bound label (fixes the unnamed native selects).
7. Sentence case for all labels, groups and buttons. No section icons in the content.
8. Application Preferences saves on change. That modal has no footer and no Save button. Project settings keeps the `SettingsModal` footer Save (`docs/design/forms.md`).
9. Search shows the page path under each result and highlights the setting it jumps to. No results offers Clear search.
10. Narrow layout: when the modal is under 768px wide, the sidebar becomes a top bar with a scrolling category strip (the next chip peeks out). When page content is under 560px, a Select, stepper, swatches or usage meter moves under its label; a switch stays on the right. MCP rows put status, tools and Connect on their own line.
11. Field edges use a new `field-border` token (`#666a73` on canvas): 3.5:1 on card, 3.7:1 on bg, 3.3:1 on popover. `ui-border` stays for card dividers only.
12. Long pages: the modal stops at 85vh. The page header with Close stays pinned; only the body scrolls, with `scroll-padding-top` equal to the header height.
13. Search jump: the target row gets a 2px foreground bar on its leading edge and a 4% wash for 2 seconds (the wash alone was 1.08:1).
14. Undo toasts have no timer. They stay until the user closes them or starts another action, and use `role="status"`. Toasts with no action ("Log copied") may close on their own.
15. Naming: the page is Accounts, so the Project settings section changes from Provider to Accounts too. The default shell is called "System default" everywhere.
16. Numbers that change use `tabular-nums`: usage percent and reset time, zoom percent, font size, counts and checked times (`docs/design/typography.md`).

## Checklist

### 1 · Structure

- [ ] `src/renderer/components/settings/SettingsLayout.tsx`: replace scroll-spy with one page per category. Keep the active page in `src/renderer/stores/settings-modal-store.ts` so search and deep links can open a page.
- [ ] `src/renderer/pages/app-preferences/categories.tsx`: 14 pages in 4 groups (General, Terminal, Agents, App). Split Behavior into Interface (links move to Appearance), Editor and Notifications.
- [ ] `src/renderer/components/settings/SettingsModal.tsx`: remove the header bar. The sidebar holds the title and search; each page has its own header with Close. Modal max height 85vh; page header pinned; body scrolls.
- [ ] `src/renderer/lib/settings-search.ts`: results show the page path. Selecting one opens the page, scrolls to the setting and shows the 2px target bar for 2 seconds.
- [ ] Application Preferences saves on change. That modal has no footer and no Save button. Project settings keeps the `SettingsModal` footer Save.

### 2 · Tokens and type

- [ ] Add `field-border` (`#666a73` on canvas, 3:1 on card, bg and popover) to `src/renderer/lib/themes/apply-color-theme.ts`, `src/renderer/index.css` and `tailwind.config.ts`. Use it for the edge of `Input`, `Textarea`, `SelectTrigger` and `PANEL_FIELD_CLASS` (`src/renderer/components/ui/panel-styles.ts`). Measure again with the real OKLCH values, in every theme.
- [ ] `ui-border` stays for card dividers only.
- [ ] `tabular-nums` on usage percent, reset time, zoom percent, font size, counts and checked times.
- [ ] Icons: use the project Hugeicons set (`src/renderer/components/icons`) at 1.5 stroke. The canvas uses Lucide only as a stand-in.

### 3 · Parts to build

- [ ] `SettingsRow`: label + description left, control right; indent variant for a dependent setting; disabled variant with a reason. Replaces `SettingsSwitchRow`.
- [ ] `SettingsGroup`: heading (sentence case 12/500 muted) + card + optional footnote.
- [ ] Replace native `<select>` with `ui/select` and custom toggles with `ui/switch` (legacy note in `docs/design/forms.md`).
- [ ] Stepper for zoom and font size (−, value, +, Reset); disabled at the limits.
- [ ] Status word (dot + word) for MCP servers, agents and accounts.
- [ ] Row menu (…) for list rows; Notice (info, warning, danger, success); Toast with Close.

### 4 · Narrow layout

- [ ] Under a 768px viewport: the sidebar becomes a top bar with title, Close, search and a scrolling category strip.
- [ ] Content under 560px (container query): Select, stepper, swatches and usage meters move under the label; switches stay on the right.
- [ ] MCP rows use three lines; the Accounts meter goes full width. Test at 200% zoom and at 300% interface zoom.

### 5 · Behavior changes (confirm with the team)

- [ ] MCP and Profiles delete: act at once and show an Undo toast with no timer (`role="status"`). Add boundary logs with `src/renderer/lib/log-api.ts` for delete and undo.
- [ ] Rename Provider to Accounts in Preferences and in Project settings (`src/renderer/components/settings/provider/ProjectProviderSettings.tsx`).
- [ ] The Update button names the agent ("Update Codex").
- [ ] Shortcut conflict keeps the current behavior: "Use anyway" keeps the keys on both commands.

### 6 · Accessibility checks

- [ ] Every Select, Switch, stepper and input has a bound `Label` (`htmlFor` + `id`).
- [ ] Icon-only buttons have names: "Close preferences", "Actions for <name>", "Decrease zoom", "Increase zoom", "Clear search", "Refresh usage", "Close notification".
- [ ] Color swatches are a radio group with arrow keys and names such as "Green, selected".
- [ ] Visible focus on every control; on a checked switch the ring sits 2px away.
- [ ] Keyboard walk of each page, screen reader pass, contrast measured in the app, reduced motion for toast and menu motion.

### 7 · Tests

- [ ] Update `src/renderer/components/settings/SettingsLayout.test.tsx`, `src/renderer/pages/AppPreferences.test.tsx` and `src/renderer/pages/app-preferences/categories.test.ts` for the paged model.
- [ ] Add tests for search jump, undo delete, field labels and the narrow layout.
- [ ] Run the parity checklist for the browser client (`src/renderer/lib/__tests__/parity-checklist.test.ts`).

## Review status

The redesign was reviewed with the better-interface skill (accessibility, layout, writing, typography, colors, UI polish). All HIGH, MEDIUM and LOW findings are fixed on the canvas or moved into this checklist.

Not verified (needs the code): accessible names, focus order, screen reader output, and contrast with the real OKLCH tokens.
