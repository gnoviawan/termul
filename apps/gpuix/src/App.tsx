import { useProjectRegistry } from '@/hooks/use-project-registry'
import { TERMUL_DARK_CHROME as chrome } from '@/lib/themes/termul-dark-chrome'
import { useWebAuthGate } from '@/lib/web-auth-gate'
import { useProjectStore } from '@/stores/project-store'

const SIDEBAR_WIDTH = 260
const FONT_SANS = 'Inter Variable, Inter, sans-serif'

function ProjectList() {
  const projects = useProjectStore((state) => state.projects)
  const isLoaded = useProjectStore((state) => state.isLoaded)
  const gate = useWebAuthGate()

  if (!isLoaded) {
    return (
      <text style={{ color: chrome.mutedForeground, fontFamily: FONT_SANS, fontSize: 13 }}>
        {gate.status === 'unauthorized' ? 'Unauthorized: check TERMUL_SERVER_TOKEN' : 'Loading…'}
      </text>
    )
  }
  return (
    <div testId="project-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {projects.map((project) => (
        <div
          key={project.id}
          testId={`project-item-${project.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 32,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 6,
            hover: { backgroundColor: chrome.elevated }
          }}
        >
          <text style={{ color: chrome.foreground, fontFamily: FONT_SANS, fontSize: 13 }}>
            {project.name}
          </text>
        </div>
      ))}
    </div>
  )
}

export function App() {
  useProjectRegistry()
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        backgroundColor: chrome.background
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: SIDEBAR_WIDTH,
          height: '100%',
          padding: 12,
          gap: 8,
          backgroundColor: chrome.card,
          borderRightWidth: 1,
          borderColor: chrome.border
        }}
      >
        <text
          style={{
            color: chrome.mutedForeground,
            fontFamily: FONT_SANS,
            fontSize: 11,
            fontWeight: 600,
            paddingLeft: 12
          }}
        >
          PROJECTS
        </text>
        <ProjectList />
      </div>
      <div style={{ display: 'flex', flexGrow: 1 }} />
    </div>
  )
}
