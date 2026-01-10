# Termul Manager - Component Inventory

> **Generated:** 2026-01-12

---

## Component Categories

| Category | Count | Location |
|----------|-------|----------|
| shadcn/ui Primitives | 45 | `src/renderer/components/ui/` |
| Terminal Components | 4 | `src/renderer/components/terminal/` |
| Feature Components | 15 | `src/renderer/components/` |
| Page Components | 4 | `src/renderer/pages/` |

---

## shadcn/ui Primitives

Base UI components built on Radix UI primitives with Tailwind CSS styling.

| Component | File | Description |
|-----------|------|-------------|
| Accordion | `ui/accordion.tsx` | Collapsible content sections |
| Alert | `ui/alert.tsx` | Alert messages |
| AlertDialog | `ui/alert-dialog.tsx` | Modal confirmation dialogs |
| AspectRatio | `ui/aspect-ratio.tsx` | Maintain aspect ratio |
| Avatar | `ui/avatar.tsx` | User avatar display |
| Badge | `ui/badge.tsx` | Status badges |
| Breadcrumb | `ui/breadcrumb.tsx` | Navigation breadcrumbs |
| Button | `ui/button.tsx` | Button variants |
| Calendar | `ui/calendar.tsx` | Date picker calendar |
| Card | `ui/card.tsx` | Content cards |
| Carousel | `ui/carousel.tsx` | Image/content carousel |
| Chart | `ui/chart.tsx` | Chart components (recharts) |
| Checkbox | `ui/checkbox.tsx` | Checkbox input |
| Collapsible | `ui/collapsible.tsx` | Collapsible sections |
| Command | `ui/command.tsx` | Command palette base |
| ContextMenu | `ui/context-menu.tsx` | Right-click menu |
| Dialog | `ui/dialog.tsx` | Modal dialogs |
| Drawer | `ui/drawer.tsx` | Slide-out drawer |
| DropdownMenu | `ui/dropdown-menu.tsx` | Dropdown menus |
| Form | `ui/form.tsx` | Form with react-hook-form |
| HoverCard | `ui/hover-card.tsx` | Hover-triggered card |
| Input | `ui/input.tsx` | Text input |
| InputOTP | `ui/input-otp.tsx` | OTP/PIN input |
| Label | `ui/label.tsx` | Form labels |
| Menubar | `ui/menubar.tsx` | Menu bar |
| NavigationMenu | `ui/navigation-menu.tsx` | Navigation menu |
| Pagination | `ui/pagination.tsx` | Pagination controls |
| Popover | `ui/popover.tsx` | Popover overlays |
| Progress | `ui/progress.tsx` | Progress bar |
| RadioGroup | `ui/radio-group.tsx` | Radio button group |
| Resizable | `ui/resizable.tsx` | Resizable panels |
| ScrollArea | `ui/scroll-area.tsx` | Custom scrollbar |
| Select | `ui/select.tsx` | Select dropdown |
| Separator | `ui/separator.tsx` | Visual separator |
| Sheet | `ui/sheet.tsx` | Side sheet overlay |
| Sidebar | `ui/sidebar.tsx` | Sidebar layout |
| Skeleton | `ui/skeleton.tsx` | Loading skeleton |
| Slider | `ui/slider.tsx` | Range slider |
| Sonner | `ui/sonner.tsx` | Toast notifications |
| Switch | `ui/switch.tsx` | Toggle switch |
| Table | `ui/table.tsx` | Data tables |
| Tabs | `ui/tabs.tsx` | Tab navigation |
| Textarea | `ui/textarea.tsx` | Multi-line input |
| Toast | `ui/toast.tsx` | Toast notifications |
| Toaster | `ui/toaster.tsx` | Toast container |
| Toggle | `ui/toggle.tsx` | Toggle button |
| ToggleGroup | `ui/toggle-group.tsx` | Toggle button group |
| Tooltip | `ui/tooltip.tsx` | Hover tooltips |

---

## Terminal Components

Specialized components for terminal functionality.

| Component | File | Description |
|-----------|------|-------------|
| XTerminal | `terminal/XTerminal.tsx` | xterm.js wrapper with WebGL renderer |
| ConnectedTerminal | `terminal/ConnectedTerminal.tsx` | Terminal with IPC connection to PTY |
| TerminalSearchBar | `terminal/TerminalSearchBar.tsx` | Search within terminal output |
| TerminalTabBar | `TerminalTabBar.tsx` | Terminal tab management |

### XTerminal Props

```typescript
interface XTerminalProps {
  terminalId: string
  onReady?: (terminal: Terminal) => void
}
```

### ConnectedTerminal Props

```typescript
interface ConnectedTerminalProps {
  terminal: Terminal
  isActive: boolean
}
```

---

## Feature Components

Application-specific feature components.

| Component | File | Description | Has Tests |
|-----------|------|-------------|-----------|
| ProjectSidebar | `ProjectSidebar.tsx` | Project navigation sidebar | ✓ |
| StatusBar | `StatusBar.tsx` | Bottom status bar with git info | ✓ |
| CommandPalette | `CommandPalette.tsx` | Cmd+K command search | |
| CommandHistoryModal | `CommandHistoryModal.tsx` | View command history | |
| ConfirmDialog | `ConfirmDialog.tsx` | Generic confirmation dialog | ✓ |
| ContextMenu | `ContextMenu.tsx` | Right-click context menu | ✓ |
| ColorPickerPopover | `ColorPickerPopover.tsx` | Project color selection | ✓ |
| ContextBarSettingsPopover | `ContextBarSettingsPopover.tsx` | Context bar configuration | |
| CreateSnapshotModal | `CreateSnapshotModal.tsx` | Create workspace snapshot | |
| RestoreSnapshotModal | `RestoreSnapshotModal.tsx` | Restore from snapshot | |
| DeleteSnapshotModal | `DeleteSnapshotModal.tsx` | Delete snapshot confirmation | |
| NewProjectModal | `NewProjectModal.tsx` | Create new project | |
| ShellSelector | `ShellSelector.tsx` | Shell selection dropdown | |
| ShortcutRecorder | `ShortcutRecorder.tsx` | Record keyboard shortcut | |
| NavLink | `NavLink.tsx` | Navigation link wrapper | |
| TerminalView | `TerminalView.tsx` | Terminal container view | |

---

## Page Components

Route-level page components.

| Component | File | Route | Description |
|-----------|------|-------|-------------|
| WorkspaceDashboard | `pages/WorkspaceDashboard.tsx` | `/` | Main terminal workspace |
| ProjectSettings | `pages/ProjectSettings.tsx` | `/settings` | Project configuration |
| AppPreferences | `pages/AppPreferences.tsx` | `/preferences` | Global app settings |
| WorkspaceSnapshots | `pages/WorkspaceSnapshots.tsx` | `/snapshots` | Snapshot management |
| NotFound | `pages/NotFound.tsx` | `*` | 404 error page |

---

## Hooks Inventory

Custom React hooks for feature logic.

| Hook | File | Purpose |
|------|------|---------|
| useToast | `hooks/use-toast.ts` | Toast notifications |
| useTerminalResize | `hooks/use-terminal-resize.ts` | Handle terminal resize |
| useXterm | `hooks/use-xterm.ts` | xterm.js instance management |
| useTerminals | `hooks/useTerminals.ts` | Terminal state access |
| useTerminalAutoSave | `hooks/useTerminalAutoSave.ts` | Auto-save terminal state |
| useTerminalRestore | `hooks/use-terminal-restore.ts` | Restore terminal state |
| useCwd | `hooks/use-cwd.ts` | CWD tracking |
| useGitBranch | `hooks/use-git-branch.ts` | Git branch tracking |
| useGitStatus | `hooks/use-git-status.ts` | Git status tracking |
| useExitCode | `hooks/use-exit-code.ts` | Command exit code tracking |
| useContextBarSettings | `hooks/use-context-bar-settings.ts` | Context bar configuration |
| useSnapshots | `hooks/use-snapshots.ts` | Snapshot management |
| useRecentCommands | `hooks/use-recent-commands.ts` | Recent commands |
| useCommandHistory | `hooks/use-command-history.ts` | Command history |
| useAppSettingsLoader | `hooks/use-app-settings.ts` | Load app settings |
| useKeyboardShortcutsLoader | `hooks/use-keyboard-shortcuts.ts` | Load shortcuts |
| useProjectsLoader | `hooks/use-projects-persistence.ts` | Load projects |
| useProjectsAutoSave | `hooks/use-projects-persistence.ts` | Auto-save projects |
| useMobile | `hooks/use-mobile.tsx` | Mobile device detection |

---

## Component Patterns

### Styling
- All components use Tailwind CSS
- `cn()` utility for conditional classes
- CSS variables for theming

### State Access
- Components access Zustand stores via hooks
- Selectors for performance optimization
- `useShallow` for array/object comparisons

### IPC Communication
- Components call `window.api.*` methods
- Handle `IpcResult` success/error states
- Use hooks to subscribe to IPC events

### Example Pattern

```tsx
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { Button } from '@/components/ui/button'

export function MyComponent({ className }: { className?: string }) {
  const projects = useProjectStore((s) => s.projects)

  const handleClick = async () => {
    const result = await window.api.dialog.selectDirectory()
    if (result.success) {
      console.log(result.data)
    }
  }

  return (
    <div className={cn('p-4', className)}>
      {projects.map((p) => (
        <div key={p.id}>{p.name}</div>
      ))}
      <Button onClick={handleClick}>Select</Button>
    </div>
  )
}
```
