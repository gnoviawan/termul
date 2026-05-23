import { createHashRouter } from 'react-router-dom'
import { isTauri } from '@/lib/api-bridge'
import WorkspaceLayout from './layouts/WorkspaceLayout'
import WorkspaceDashboard from './pages/WorkspaceDashboard'
import ProjectSettings from './pages/ProjectSettings'
import AppPreferences from './pages/AppPreferences'
import WorkspaceSnapshots from './pages/WorkspaceSnapshots'
import NotFound from './pages/NotFound'
import { RemoteAccessPanel } from '@/components/remote/RemoteAccessPanel'

const isDesktopApp = isTauri()

export const router = createHashRouter(
  [
    {
      path: '/',
      element: <WorkspaceLayout />,
      children: [
        { index: true, element: <WorkspaceDashboard /> },
        { path: 'snapshots', element: <WorkspaceSnapshots /> },
        ...(isDesktopApp ? [{ path: 'settings', element: <ProjectSettings /> }] : []),
        ...(isDesktopApp ? [{ path: 'preferences', element: <AppPreferences /> }] : []),
        ...(isDesktopApp ? [{ path: 'remote', element: <RemoteAccessPanel /> }] : [])
      ]
    },
    { path: '*', element: <NotFound /> }
  ],
  {
    future: {
      v7_relativeSplatPath: true
    }
  }
)
