import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { createHead, UnheadProvider } from '@unhead/react/client'
import {
  createBrowserRouter,
  RouterProvider,
  type HydrationState,
} from 'react-router'
import 'overlayscrollbars/overlayscrollbars.css'
import './index.css'
import { routes } from './routes'

const head = createHead()
const hydrationData = (window as Window & {
  __staticRouterHydrationData?: HydrationState
}).__staticRouterHydrationData
const router = createBrowserRouter(routes, { hydrationData })

hydrateRoot(
  document.getElementById('app')!,
  <StrictMode>
    <UnheadProvider head={head}>
      <RouterProvider router={router} />
    </UnheadProvider>
  </StrictMode>,
)
