import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { registerDialogIpc } from './ipc/dialog.ipc'
import { registerShellIpc } from './ipc/shell.ipc'
import { registerPersistenceIpc } from './ipc/persistence.ipc'
import { registerSystemIpc } from './ipc/system.ipc'
import { flushPendingWrites } from './services/persistence-service'
import { resetDefaultPtyManager } from './services/pty-manager'
import type { WindowState } from '../shared/types/persistence.types'
import { loadWindowState, trackWindowState } from './services/window-state'

export function createWindow(windowState?: WindowState): BrowserWindow {
  const mainWindow = new BrowserWindow({
    x: windowState?.x,
    y: windowState?.y,
    width: windowState?.width ?? 1200,
    height: windowState?.height ?? 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

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

    // Register IPC handlers before creating window
    registerTerminalIpc()
    registerDialogIpc()
    registerShellIpc()
    registerPersistenceIpc()
    registerSystemIpc()

    // Load persisted window state and create window
    const windowState = await loadWindowState()
    createWindow(windowState)

    app.on('activate', async function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        const state = await loadWindowState()
        createWindow(state)
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
