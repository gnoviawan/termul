import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { TauriTitleBar } from '@/components/TauriTitleBar'
import { TauriTerminal } from '@/components/terminal/TauriTerminal'

export default function TauriApp(): React.JSX.Element {
  useEffect(() => {
    // Show window after React mount completes (prevents flash of empty content)
    getCurrentWindow().show()
  }, [])

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <TauriTitleBar />
      <TauriTerminal />
    </div>
  )
}
