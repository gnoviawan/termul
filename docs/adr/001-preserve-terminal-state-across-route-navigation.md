# ADR-001: Preserve Terminal State Across Route Navigation

> **Status:** Proposed
> **Date:** 2026-01-14
> **Decision Makers:** Development Team
> **Technical Story:** Terminal sessions reset when navigating between routes

---

## Context

### Current State

Termul is an Electron-based terminal emulator with project-aware workspaces. The application uses React Router (`createHashRouter`) for navigation between:

- `/` - WorkspaceDashboard (main terminal view)
- `/settings` - ProjectSettings (per-project configuration)
- `/preferences` - AppPreferences (global settings)
- `/snapshots` - WorkspaceSnapshots (workspace state management)

**Current Routing Architecture (App.tsx):**
```typescript
const router = createHashRouter([
  { path: '/', element: <WorkspaceDashboard /> },
  { path: '/settings', element: <ProjectSettings /> },
  { path: '/preferences', element: <AppPreferences /> },
  { path: '/snapshots', element: <WorkspaceSnapshots /> },
  { path: '*', element: <NotFound /> }
])
```

### The Problem

When users navigate from the terminal view (`/`) to Settings (`/settings`) and back, **all terminal state is destroyed**. This occurs because:

1. React Router completely unmounts `WorkspaceDashboard` when navigating away
2. `ConnectedTerminal` components unmount, triggering cleanup:
   - PTY processes are killed via `window.api.terminal.kill(ptyId)`
   - xterm.js terminals are disposed via `terminal.dispose()`
   - All IPC listeners are removed
3. When navigating back, new PTY processes spawn with fresh state

**User Impact:**
- Active shell sessions are terminated
- Working directory context is lost
- Command history in scrollback buffer is erased
- Running processes (dev servers, builds, etc.) are killed
- Users must re-establish their terminal environment

### Why Change is Needed

Terminal applications expect session persistence. Users reasonably expect that adjusting settings does not terminate their active terminal sessions. This is standard behavior in applications like VS Code, iTerm2, and Windows Terminal.

---

## Decision Drivers

1. **User Experience:** Terminal state must survive navigation
2. **Resource Efficiency:** Avoid unnecessary PTY spawn/kill cycles
3. **Maintainability:** Solution should be easy to understand and extend
4. **Testing:** Solution should be testable in isolation
5. **Future Scalability:** Solution should accommodate new routes/features

---

## Options Considered

### Option A: Nested Routes with Layout Component

**Description:** Transform `WorkspaceDashboard` into a layout component that renders terminals alongside an `<Outlet>` for child routes. Settings and Preferences become nested routes.

**Proposed Route Structure:**
```typescript
const router = createHashRouter([
  {
    path: '/',
    element: <WorkspaceLayout />,  // Contains terminals + <Outlet>
    children: [
      { index: true, element: <TerminalView /> },      // Default: show terminals
      { path: 'settings', element: <ProjectSettings /> },
      { path: 'preferences', element: <AppPreferences /> },
      { path: 'snapshots', element: <WorkspaceSnapshots /> }
    ]
  },
  { path: '*', element: <NotFound /> }
])
```

**Implementation:**
- Create `WorkspaceLayout.tsx` - contains sidebar, terminals, and `<Outlet>`
- Terminals render at layout level, always mounted
- Child routes render in content area (overlay or panel)
- Settings pages become "modal-like" overlays or side panels

### Option B: Lift Terminals Above Router

**Description:** Move `ConnectedTerminal` rendering to `App.tsx` level, above the `RouterProvider`. Use CSS visibility and route state to show/hide terminals.

**Proposed Structure:**
```tsx
const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppEffects />
      {/* Terminals rendered here - always mounted */}
      <TerminalLayer />
      <RouterProvider router={router} />
    </TooltipProvider>
  </QueryClientProvider>
)
```

**Implementation:**
- Create `TerminalLayer.tsx` - renders all terminals with visibility control
- Use `useLocation()` hook to detect current route
- Terminals hidden (not unmounted) when on non-terminal routes
- Router handles only page chrome and settings UI

---

## Trade-offs Matrix

| Criterion | Option A: Nested Routes | Option B: Lift Above Router |
|-----------|------------------------|----------------------------|
| **Complexity** | Medium - Standard React Router pattern | High - Custom rendering logic, route syncing |
| **Maintainability** | High - Follows conventions | Medium - Non-standard architecture |
| **Scalability** | High - Easy to add nested routes | Medium - Each new feature needs visibility logic |
| **Performance** | Good - React handles mounting | Good - Avoids re-renders via CSS hiding |
| **Testing** | Easy - Routes are isolated | Harder - Global state dependencies |
| **Code Changes** | Moderate - Refactor routing | Significant - Restructure component tree |
| **Pattern Alignment** | Follows React Router best practices | Deviates from router conventions |
| **Developer Onboarding** | Low friction - familiar pattern | Higher friction - custom pattern |

### Detailed Analysis

#### Complexity

**Option A (Nested Routes):** Uses standard React Router patterns. Developers familiar with React Router will immediately understand the structure. The Outlet pattern is well-documented.

**Option B (Lift Above Router):** Introduces a non-standard pattern where the router no longer controls the primary content area. Requires careful coordination between:
- Route location state
- Terminal visibility state
- Zustand store state for active project/terminal
- Potential z-index management for overlays

#### Maintainability

**Option A:** Future routes follow the same pattern - add as children. Settings pages remain self-contained. Clear separation between layout (always mounted) and content (route-dependent).

**Option B:** Adding new features requires updating the visibility logic in TerminalLayer. Risk of accumulating conditional rendering logic. Harder to reason about what renders when.

#### Performance

**Option A:** React's reconciliation handles efficient re-rendering. Terminals never unmount. Child routes mount/unmount cleanly.

**Option B:** CSS visibility (`visibility: hidden` or `display: none`) keeps elements in DOM. May have marginal performance benefits for very complex terminal states, but modern React is highly optimized.

#### Testing

**Option A:** Each route can be tested in isolation. Layout can be tested with mock Outlet. Integration tests can verify terminal persistence.

**Option B:** Tests need to mock location state and verify visibility logic. Terminal rendering is tightly coupled to route state, making unit testing harder.

---

## Decision

**Recommended: Option A - Nested Routes with Layout Component**

### Rationale

1. **Idiomatic React Router:** The nested routes pattern with layout components is the recommended approach in React Router v6+. It aligns with the mental model of "layout routes" and "leaf routes."

2. **Minimal Conceptual Overhead:** Developers do not need to learn a custom pattern. The Outlet component is well-understood.

3. **Clean Separation of Concerns:**
   - `WorkspaceLayout` owns: sidebar, terminal rendering, status bar
   - Child routes own: their specific UI (settings forms, snapshot lists)
   - Clear responsibility boundaries

4. **Extensibility:** Adding new nested routes (e.g., `/logs`, `/debug`, `/ai-assistant`) follows the same pattern with zero architectural changes.

5. **Existing Code Leverage:** The current `WorkspaceDashboard` already has most of the layout logic. Refactoring to a layout component is additive, not a rewrite.

6. **Lower Risk:** Nested routes are battle-tested in production React applications. The pattern is stable and predictable.

### Why Not Option B?

While Option B would technically work, it introduces unnecessary complexity:

- Non-standard architecture requires documentation and onboarding
- Risk of z-index wars between terminal layer and router content
- Focus management becomes complicated (which layer has keyboard focus?)
- Harder to implement deep linking correctly (e.g., `/settings/shells`)
- Testing requires mocking router location in terminal tests

---

## Consequences

### Positive

1. **Terminal sessions survive navigation** - The core problem is solved
2. **Familiar patterns for developers** - Lower onboarding cost
3. **Easy to add new routes** - Just add children to the layout route
4. **Settings can have sub-routes** - e.g., `/settings/env`, `/settings/shell`
5. **StatusBar remains visible on all routes** - Consistent UI

### Negative

1. **Routing refactor required** - Existing pages need adjustment
2. **Settings UI may need redesign** - Currently full-page, may become panels
3. **URL structure changes** - `/settings` stays same, but implementation differs

### Neutral

1. **Terminal layer stays in DOM** - This is the intent
2. **Zustand stores unchanged** - State management is not affected

---

## Implementation Notes

### Proposed File Changes

1. **Create:** `src/renderer/layouts/WorkspaceLayout.tsx`
   - Extract layout logic from `WorkspaceDashboard`
   - Render sidebar, terminals, and `<Outlet>` for children

2. **Modify:** `src/renderer/App.tsx`
   - Change flat routes to nested route structure
   - WorkspaceLayout as parent, current pages as children

3. **Modify:** `src/renderer/pages/ProjectSettings.tsx`
   - Remove `ProjectSidebar` (now in layout)
   - Adjust to render as panel/overlay in layout area

4. **Modify:** `src/renderer/pages/AppPreferences.tsx`
   - Remove `ProjectSidebar` (now in layout)
   - Adjust to render as panel/overlay in layout area

5. **Modify:** `src/renderer/pages/WorkspaceSnapshots.tsx`
   - Remove sidebar (if present)
   - Adjust to render in layout area

### Migration Path

1. Create `WorkspaceLayout` with basic structure
2. Move `ProjectSidebar` to layout level
3. Move terminal rendering to layout level
4. Convert existing pages to be Outlet-compatible
5. Update route configuration
6. Test navigation preserves terminal state
7. Adjust styling/layout as needed

---

## Related Decisions

- **Future:** May want modals vs. panels for settings (UI/UX decision)
- **Future:** Consider route-level code splitting for settings pages
- **Future:** Deep linking within settings pages (e.g., `/settings/shortcuts`)

---

## References

- [React Router v6 - Layout Routes](https://reactrouter.com/en/main/route/route#layout-routes)
- [React Router v6 - Outlet](https://reactrouter.com/en/main/components/outlet)
- Current architecture: `docs/architecture.md`

---

## Appendix: Current Code Analysis

### ConnectedTerminal Cleanup (lines 331-367)

The cleanup effect in `ConnectedTerminal.tsx` explicitly kills the PTY:

```typescript
return () => {
  // Unregister terminal from registry
  if (ptyIdRef.current) {
    unregisterTerminal(ptyIdRef.current)
  }
  // Kill PTY process on unmount to prevent orphaned shell processes
  if (ptyIdRef.current) {
    const killPromise = window.api.terminal.kill(ptyIdRef.current)
    // ...
  }
  // ...
  terminal.dispose()
}
```

This behavior is correct for intentional terminal closure, but problematic when triggered by route navigation.

### Current Page Structure

Both `ProjectSettings.tsx` and `AppPreferences.tsx` include their own `ProjectSidebar`, duplicating the sidebar across routes. The layout approach consolidates this.

### Terminal Rendering in WorkspaceDashboard

Lines 428-454 show all terminals are rendered (including hidden ones for project switching):

```typescript
{allTerminals.map((terminal) => {
  const isActiveTerminal = terminal.id === activeTerminalId &&
                           terminal.projectId === activeProjectId
  return (
    <div key={terminal.id}
         className={isActiveTerminal ? 'w-full h-full'
                                      : 'w-full h-full absolute inset-0 invisible'}>
      <ConnectedTerminal ... />
    </div>
  )
})}
```

This pattern (render all, hide inactive) should be preserved in the layout.
