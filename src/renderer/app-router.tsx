import { createHashRouter } from 'react-router-dom'
import WorkspaceLayout from './layouts/WorkspaceLayout'
import WorkspaceDashboard from './pages/WorkspaceDashboard'
import ProjectSettings from './pages/ProjectSettings'
import AppPreferences from './pages/AppPreferences'
import WorkspaceSnapshots from './pages/WorkspaceSnapshots'
import NotFound from './pages/NotFound'
import { RemoteAccessPanel } from '@/components/remote/RemoteAccessPanel'

export const router = createHashRouter(
  [
    {
      path: '/',
      element: <WorkspaceLayout />,
      children: [
        { index: true, element: <WorkspaceDashboard /> },
        { path: 'snapshots', element: <WorkspaceSnapshots /> },
        { path: 'settings', element: <ProjectSettings /> },
        { path: 'preferences', element: <AppPreferences /> },
        { path: 'remote', element: <RemoteAccessPanel /> }
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
