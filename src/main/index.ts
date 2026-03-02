import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { registerDialogIpc } from './ipc/dialog.ipc'
import { registerShellIpc } from './ipc/shell.ipc'
import { registerPersistenceIpc } from './ipc/persistence.ipc'
import { registerSystemIpc } from './ipc/system.ipc'
import { registerClipboardIpc } from './ipc/clipboard.ipc'
import { registerFilesystemIpc } from './ipc/filesystem.ipc'
import { registerWindowIpc } from './ipc/window.ipc'
import { registerVisibilityIpc } from './ipc/visibility.ipc'
import { registerSessionIpc } from './ipc/session.ipc'
import { registerDataMigrationIpc, getMigrationServiceForRegistration } from './ipc/data-migration.ipc'
import { initRegisterUpdaterIpc, setUpdaterWindow } from './ipc/updater.ipc'
import { flushPendingWrites } from './services/persistence-service'
import { resetDefaultPtyManager } from './services/pty-manager'
import { resetDefaultFilesystemService } from './services/filesystem-service'
import { getDefaultSessionPersistenceService } from './services/session-persistence'
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
    frame: false,
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
    registerClipboardIpc() // Register clipboard IPC handlers
    registerFilesystemIpc() // Register filesystem IPC handlers
    initRegisterUpdaterIpc() // Register updater IPC handlers once
    registerVisibilityIpc() // Register visibility IPC handlers
    registerSessionIpc() // Register session persistence IPC handlers
    registerDataMigrationIpc() // Register data migration IPC handlers

    // Run data migrations on app startup
    // This should happen before creating the window to ensure data is ready
    const migrationService = getMigrationServiceForRegistration()
    try {
      const migrationResult = await migrationService.runMigrations()
      if (!migrationResult.success) {
        console.error('Data migration failed:', migrationResult.error)
      } else if (migrationResult.data.length > 0) {
        console.log(`Completed ${migrationResult.data.length} migration(s)`)
      }
    } catch (error) {
      console.error('Error running migrations:', error)
    }

    // Load persisted window state and create window
    const windowState = await loadWindowState()
    const mainWindow = createWindow(windowState)

    // Register window IPC handlers (needs mainWindow reference)
    registerWindowIpc(mainWindow)

    // Set updater window reference
    await setUpdaterWindow(mainWindow)

    app.on('activate', async function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        const state = await loadWindowState()
        const mainWindow = createWindow(state)
        registerWindowIpc(mainWindow)
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
let isQuitting = false
app.on('before-quit', async (e) => {
  if (isQuitting) return
  isQuitting = true
  e.preventDefault()

  // Flush session persistence before quitting
  const sessionService = getDefaultSessionPersistenceService()
  try {
    await sessionService.flushPendingAutoSave()
  } catch (error) {
    console.error('Failed to flush session on quit:', error)
  }

  resetDefaultPtyManager()
  Promise.all([
    resetDefaultFilesystemService(),
    flushPendingWrites()
  ]).finally(() => {
    app.quit()
  })
})

// Only initialize if not in test environment
if (process.env.NODE_ENV !== 'test') {
  initializeApp()
}
