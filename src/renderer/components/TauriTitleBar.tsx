import { Copy, Minus, Square, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@/lib/tauri-window'

const focusableButtonClass =
  'h-full px-3 hover:bg-secondary inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset'

export function TauriTitleBar(): React.JSX.Element {
  const { t } = useTranslation('common')
  const [isMaximized, setIsMaximized] = useState(false)
  const appWindow = getCurrentWindow()

  const checkMaximized = useCallback(async () => {
    const maximized = await appWindow.isMaximized()
    setIsMaximized(maximized)
  }, [appWindow])

  useEffect(() => {
    let mounted = true
    checkMaximized()

    // Listen for resize events to track maximize state
    let unlisten: (() => void) | undefined
    appWindow
      .onResized(() => {
        checkMaximized()
      })
      .then((fn) => {
        if (mounted) {
          unlisten = fn
        } else {
          // Component already unmounted, clean up immediately
          fn()
        }
      })

    return () => {
      mounted = false
      unlisten?.()
    }
  }, [appWindow, checkMaximized])

  return (
    <header
      className="h-8 flex items-center justify-between bg-card border-b border-border select-none shrink-0"
      data-tauri-drag-region
    >
      <span className="label-section text-muted-foreground px-3" data-tauri-drag-region>
        termul
      </span>

      <div className="flex items-center h-full">
        <button
          onClick={() => appWindow.minimize()}
          className={focusableButtonClass}
          title={t('window.minimize')}
          aria-label={t('window.minimizeAria')}
          data-press-feedback="off"
        >
          <Minus size={16} />
        </button>

        <button
          onClick={() => appWindow.toggleMaximize()}
          className={focusableButtonClass}
          title={isMaximized ? t('window.restore') : t('window.maximize')}
          aria-label={isMaximized ? t('window.restoreAria') : t('window.maximizeAria')}
          data-press-feedback="off"
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>

        <button
          onClick={() => appWindow.close()}
          className="h-full px-3 hover:bg-red-500/90 hover:text-white inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          title={t('actions.close')}
          aria-label={t('window.closeAria')}
          data-press-feedback="off"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
