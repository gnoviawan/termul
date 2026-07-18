---
title: 'Move sidebar/file-explorer visibility toggles into the titlebar'
type: 'feature'
created: '2026-07-19'
status: 'done'
route: 'one-shot'
---

# Move sidebar/file-explorer visibility toggles into the titlebar

## Intent

**Problem:** The left-sidebar and right-sidebar (file-explorer) visibility toggles were pinned to the *bottom* of the far-left ActivityRail — a long reach from the OS window controls and visually disconnected from the titlebar.

**Approach:** Relocate both toggles into the titlebar strip, OS-aware. On Windows/Linux the in-app `TitleBar` hosts the left toggle at the far left and the right toggle just before the minimize/maximize/close controls. On macOS the full-width `MacOsTitlebarStrip` hosts the left toggle after the native traffic-light clearance and the right toggle at the far right. A shared `TitlebarPanelToggles` component preserves the persistence-aware updater, error-toast, and accessible-label contracts; the `ActivityRail` keeps only the SSH toggle and the remaining global actions.

## Suggested Review Order

**Shared toggle component (behavior contract)**

- Shared SidebarToggleButton + FileExplorerToggleButton; persistence-aware updater, error toast, and a11y parity with the old rail handlers.
  [`TitlebarPanelToggles.tsx:36`](../../src/renderer/components/TitlebarPanelToggles.tsx#L36)
- Right-sidebar toggle; same contract for the file explorer.
  [`TitlebarPanelToggles.tsx:74`](../../src/renderer/components/TitlebarPanelToggles.tsx#L74)
- Shared `titlebarNoDragStyle` so buttons stay clickable inside either drag region.
  [`TitlebarPanelToggles.tsx:22`](../../src/renderer/components/TitlebarPanelToggles.tsx#L22)

**Windows/Linux titlebar placement**

- Left toggle at the far left of the content-column strip, inside the no-drag wrapper.
  [`TitleBar.tsx:48`](../../src/renderer/components/TitleBar.tsx#L48)
- Right toggle immediately before the minimize/maximize/close window controls.
  [`TitleBar.tsx:61`](../../src/renderer/components/TitleBar.tsx#L61)

**macOS titlebar placement**

- `MacOsTitlebarStrip` hosts both toggles in the full-width top drag strip.
  [`WorkspaceLayout.tsx:140`](../../src/renderer/layouts/WorkspaceLayout.tsx#L140)
- Left toggle placed after the traffic-light clearance; right toggle at the far right.
  [`WorkspaceLayout.tsx:154`](../../src/renderer/layouts/WorkspaceLayout.tsx#L154)
- `macOsTitlebarStripClass` reused (repurposed from `justify-center` to `relative`).
  [`platform.ts:19`](../../src/renderer/lib/platform.ts#L19)

**ActivityRail cleanup + tests**

- Bottom group now holds only shortcuts/preferences/themes; panel toggles removed.
  [`ActivityRail.tsx:184`](../../src/renderer/components/ActivityRail.tsx#L184)
- Moved toggle + error-toast coverage for the relocated buttons.
  [`TitlebarPanelToggles.test.tsx:29`](../../src/renderer/components/TitlebarPanelToggles.test.tsx#L29)
- macOS strip now asserts the real toggles render inside it.
  [`WorkspaceLayout.test.tsx:410`](../../src/renderer/layouts/WorkspaceLayout.test.tsx#L410)
