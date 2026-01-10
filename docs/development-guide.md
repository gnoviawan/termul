# Termul Manager - Development Guide

> **Generated:** 2026-01-12

---

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** or **bun** package manager
- **Git** for version control

### Platform-Specific Requirements

**Windows:**
- Visual Studio Build Tools (for node-pty compilation)
- Windows SDK

**macOS:**
- Xcode Command Line Tools

**Linux:**
- build-essential, python3

---

## Getting Started

### 1. Clone and Install

```bash
# Clone the repository
git clone <repository-url>
cd termul

# Install dependencies
npm install
# or with bun
bun install
```

### 2. Start Development Server

```bash
npm run dev
```

This starts:
- Vite dev server with HMR for the renderer
- Electron in development mode
- Auto-reload on main process changes

### 3. Open DevTools

Press `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (macOS) to open DevTools.

---

## Available Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run dev` | `electron-vite dev` | Start development server |
| `npm run build` | `electron-vite build` | Build for production |
| `npm run start` | `electron-vite preview` | Preview production build |
| `npm run lint` | `eslint .` | Run ESLint |
| `npm test` | `vitest run` | Run tests once |
| `npm run test:watch` | `vitest` | Run tests in watch mode |
| `npm run typecheck` | TypeScript checks | Validate all types |
| `npm run build:win` | Build + package | Windows installer |
| `npm run build:mac` | Build + package | macOS DMG |
| `npm run build:linux` | Build + package | Linux AppImage/DEB |

---

## Project Structure

```
src/
├── main/           # Electron main process (Node.js)
│   ├── index.ts    # Entry point
│   ├── ipc/        # IPC handlers
│   └── services/   # Business logic
├── preload/        # IPC bridge (contextBridge)
├── renderer/       # React UI (browser environment)
│   ├── components/ # UI components
│   ├── hooks/      # Custom React hooks
│   ├── pages/      # Route pages
│   ├── stores/     # Zustand state stores
│   └── types/      # Type definitions
└── shared/         # Shared between main & renderer
    └── types/      # IPC contract types
```

---

## Development Workflow

### Adding a New Feature

#### 1. If feature needs native capabilities (file system, system info, etc.):

```typescript
// 1. Add IPC handler in src/main/ipc/
// src/main/ipc/myfeature.ipc.ts
import { ipcMain } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'

export function registerMyFeatureIpc(): void {
  ipcMain.handle('myfeature:action', async (): Promise<IpcResult<string>> => {
    try {
      // Do something
      return { success: true, data: 'result' }
    } catch (error) {
      return { success: false, error: String(error), code: 'ACTION_FAILED' }
    }
  })
}

// 2. Register in src/main/index.ts
import { registerMyFeatureIpc } from './ipc/myfeature.ipc'
// ... in initializeApp()
registerMyFeatureIpc()

// 3. Expose via preload in src/preload/index.ts
const myFeatureApi = {
  action: (): Promise<IpcResult<string>> => {
    return ipcRenderer.invoke('myfeature:action')
  }
}
// Add to api object
```

#### 2. If feature needs state management:

```typescript
// src/renderer/stores/myfeature-store.ts
import { create } from 'zustand'

interface MyFeatureState {
  data: string[]
  addItem: (item: string) => void
}

export const useMyFeatureStore = create<MyFeatureState>((set) => ({
  data: [],
  addItem: (item) => set((state) => ({
    data: [...state.data, item]
  }))
}))
```

#### 3. If feature needs a UI component:

```typescript
// src/renderer/components/MyFeature.tsx
import { useMyFeatureStore } from '@/stores/myfeature-store'

export function MyFeature() {
  const { data, addItem } = useMyFeatureStore()

  return (
    <div>
      {data.map((item, i) => <div key={i}>{item}</div>)}
      <button onClick={() => addItem('new')}>Add</button>
    </div>
  )
}
```

---

## Testing

### Running Tests

```bash
# Run all tests once
npm test

# Run in watch mode (development)
npm run test:watch

# Run with coverage
npm test -- --coverage
```

### Writing Tests

Tests are colocated with source files using `.test.ts` or `.test.tsx` extension.

```typescript
// src/renderer/stores/myfeature-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useMyFeatureStore } from './myfeature-store'

describe('MyFeatureStore', () => {
  beforeEach(() => {
    useMyFeatureStore.setState({ data: [] })
  })

  it('should add items', () => {
    const { addItem } = useMyFeatureStore.getState()
    addItem('test')
    expect(useMyFeatureStore.getState().data).toEqual(['test'])
  })
})
```

### Test Configuration

- **Framework:** Vitest
- **Environment:** JSDOM for renderer tests
- **Setup:** `vitest.setup.ts`
- **Path aliases:** `@` and `@renderer` resolve to `src/renderer`

---

## Type Checking

```bash
# Check all TypeScript
npm run typecheck

# Check only main/preload
npm run typecheck:node

# Check only renderer
npm run typecheck:web
```

---

## Linting

```bash
# Run ESLint
npm run lint

# Fix auto-fixable issues
npm run lint -- --fix
```

---

## Building for Production

### Development Build

```bash
npm run build
```

Creates production build in `out/` directory.

### Platform Packages

```bash
# Windows (NSIS installer + portable)
npm run build:win

# macOS (DMG + ZIP)
npm run build:mac

# Linux (AppImage + DEB)
npm run build:linux
```

Packages are output to `dist/` directory.

---

## Path Aliases

| Alias | Resolves To |
|-------|-------------|
| `@` | `src/renderer` |
| `@renderer` | `src/renderer` |

Usage:
```typescript
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores/project-store'
```

---

## Environment Variables

Development environment variables can be set in `.env` files:

- `.env` - All environments
- `.env.development` - Development only
- `.env.production` - Production only

Access in renderer:
```typescript
import.meta.env.VITE_MY_VAR
```

Access in main process:
```typescript
process.env.MY_VAR
```

---

## Debugging

### Renderer Process
- Use browser DevTools (`Ctrl+Shift+I`)
- React DevTools extension works in development

### Main Process
- Console output appears in terminal
- Use VS Code debugger with Electron debug configuration

### Preload Script
- Console output appears in renderer DevTools console

---

## Common Tasks

### Adding a shadcn/ui Component

```bash
# Components are in src/renderer/components/ui/
# Copy from shadcn/ui registry or create manually
```

### Adding a New Route

```typescript
// src/renderer/App.tsx
const router = createHashRouter([
  // Add new route
  { path: '/mypage', element: <MyPage /> },
])
```

### Persisting State

```typescript
// Use the persistence API
const result = await window.api.persistence.write('mykey', data)
if (!result.success) {
  console.error(result.error)
}
```

---

## Troubleshooting

### Native Module Issues

If node-pty fails to build:
```bash
# Rebuild native modules
npm run postinstall
# or
npx electron-rebuild
```

### TypeScript Errors

```bash
# Clear TypeScript cache
rm -rf tsconfig.node.tsbuildinfo tsconfig.web.tsbuildinfo
npm run typecheck
```

### Development Server Issues

```bash
# Clear Vite cache
rm -rf node_modules/.vite
npm run dev
```
