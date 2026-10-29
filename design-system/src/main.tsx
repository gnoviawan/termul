import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/inter/wght-italic.css'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

createRoot(root).render(
  <StrictMode>
    <TooltipProvider delayDuration={80} skipDelayDuration={300}>
      <App />
      <Toaster />
    </TooltipProvider>
  </StrictMode>
)
