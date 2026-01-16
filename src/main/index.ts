import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { registerDialogIpc } from './ipc/dialog.ipc'
import { registerShellIpc } from './ipc/shell.ipc'
import { registerPersistenceIpc } from './ipc/persistence.ipc'
import { registerSystemIpc } from './ipc/system.ipc'
import { registerWorktreeIpc } from './ipc/worktree.ipc'
import { registerMergeIpc } from './ipc/merge.ipc'
import { registerAIPromptIpc } from './ipc/ai-prompt.ipc'
import { registerKeyboardShortcutsIpc } from './ipc/keyboard-shortcuts.ipc'
import { initRegisterUpdaterIpc, setUpdaterWindow } from './ipc/updater.ipc'
import { flushPendingWrites } from './services/persistence-service'
import { resetDefaultPtyManager } from './services/pty-manager'
import type { WindowState } from '../shared/types/persistence.types'
import { loadWindowState, trackWindowState } from './services/window-state'
import { setupMenu, setMainWindow } from './menu'

export function createWindow(windowState?: WindowState): BrowserWindow {
  const mainWindow = new BrowserWindow({
    x: windowState?.x,
    y: windowState?.y,
    width: windowState?.width ?? 1200,
    height: windowState?.height ?? 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Set main window reference for menu
  setMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    // Restore maximized state if saved
    if (windowState?.isMaximized) {
      mainWindow.maximize()
    }
    mainWindow.show()
  })

  // Start tracking window state changes
  trackWindowState(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Intercept Ctrl+Tab and Ctrl+Shift+Tab before Chromium handles them
  // These are reserved browser shortcuts that don't reach JavaScript keydown handlers
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt) return

    // Handle Ctrl+Tab / Ctrl+Shift+Tab
    if (input.key === 'Tab') {
      event.preventDefault()
      const shortcut = input.shift ? 'prevTerminal' : 'nextTerminal'
      mainWindow.webContents.send('keyboard:shortcut', shortcut)
      return
    }

    // Handle zoom shortcuts (Ctrl+-, Ctrl+=, Ctrl+0)
    // These are browser zoom shortcuts that Chromium blocks
    if (input.key === '-' || input.key === '=' || input.key === '0') {
      event.preventDefault()
      let shortcut = ''
      if (input.key === '-') shortcut = 'zoomOut'
      else if (input.key === '=') shortcut = 'zoomIn'
      else if (input.key === '0') shortcut = 'zoomReset'
      mainWindow.webContents.send('keyboard:shortcut', shortcut)
      return
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function initializeApp(): void {
  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.termul-manager.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Setup application menu
    setupMenu()

    // Register IPC handlers
    registerTerminalIpc()
    registerDialogIpc()
    registerShellIpc()
    registerPersistenceIpc()
    registerSystemIpc()
    registerWorktreeIpc()
    registerMergeIpc()
    registerAIPromptIpc()
    registerKeyboardShortcutsIpc()
    initRegisterUpdaterIpc() // Register updater IPC handlers once

    // Load persisted window state and create window
    const windowState = await loadWindowState()
    const mainWindow = createWindow(windowState)

    // Set updater window reference
    await setUpdaterWindow(mainWindow)

    app.on('activate', async function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        const state = await loadWindowState()
        const mainWindow = createWindow(state)
        await setUpdaterWindow(mainWindow) // Only update window reference, don't re-register handlers
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Flush pending writes and cleanup PTY processes before quitting
app.on('before-quit', async () => {
  resetDefaultPtyManager()
  await flushPendingWrites()
})

// Only initialize if not in test environment
if (process.env.NODE_ENV !== 'test') {
  initializeApp()
}
