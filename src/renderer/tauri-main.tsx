import { createRoot } from 'react-dom/client'
import TauriApp from './TauriApp'
// Import fontsource CSS as Vite CSS modules so its relative .woff2 URLs are
// resolved and emitted as local build assets.
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/inter/wght-italic.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import '@fontsource-variable/jetbrains-mono/wght-italic.css'
import './index.css'

createRoot(document.getElementById('root')!).render(<TauriApp />)
