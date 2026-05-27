import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { createHead, UnheadProvider } from '@unhead/react/client'
import 'overlayscrollbars/overlayscrollbars.css'
import './index.css'
import App from './App.tsx'

const head = createHead()

hydrateRoot(
  document.getElementById('app')!,
  <StrictMode>
    <UnheadProvider head={head}>
      <App />
    </UnheadProvider>
  </StrictMode>,
)
