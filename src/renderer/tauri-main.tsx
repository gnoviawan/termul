import { createRoot } from 'react-dom/client'
import { initializeI18nFromSettings } from '@/i18n/bootstrap'
import TauriApp from './TauriApp'
import './index.css'

async function bootstrap(): Promise<void> {
  await initializeI18nFromSettings()
  createRoot(document.getElementById('root')!).render(<TauriApp />)
}

void bootstrap()
