import { FolderGit2, MessagesSquare } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChatHistoryTab } from './chat/ChatHistoryTab'
import { ProjectSidebar } from './ProjectSidebar'

// Forward exactly what ProjectSidebar accepts so new sidebar props (e.g. SSH
// handlers) flow through without having to be re-declared here.
type SidebarTabsProps = React.ComponentProps<typeof ProjectSidebar>

type SidebarTab = 'projects' | 'chats'

/**
 * Projects/Chats switcher. ProjectSidebar is rendered UNCHANGED under "Projects"
 * (props forwarded verbatim); the Chats tab hosts ACP chat history. A thin
 * segmented control sits above both; the active panel fills the rest. Width
 * matches ProjectSidebar's own w-64 so layout is unchanged.
 */
export function SidebarTabs(props: SidebarTabsProps): React.JSX.Element {
  const [tab, setTab] = useState<SidebarTab>('projects')

  return (
    <div className="w-64 flex flex-col flex-shrink-0 h-full gap-2">
      <div className="flex gap-1 rounded-lg bg-sidebar p-1">
        <TabButton
          label="Projects"
          icon={<FolderGit2 size={12} />}
          active={tab === 'projects'}
          onClick={() => setTab('projects')}
        />
        <TabButton
          label="Chats"
          icon={<MessagesSquare size={12} />}
          active={tab === 'chats'}
          onClick={() => setTab('chats')}
        />
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'projects' ? (
          <ProjectSidebar {...props} />
        ) : (
          <aside className="w-full bg-sidebar flex flex-col flex-shrink-0 rounded-xl h-full overflow-hidden">
            <div className="h-9 flex items-center px-3 border-b border-sidebar-border rounded-t-xl">
              <span className="text-xs tracking-wider text-sidebar-foreground uppercase">
                Chats
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <ChatHistoryTab />
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

function TabButton({
  label,
  icon,
  active,
  onClick
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 flex items-center justify-center gap-1.5 rounded-md py-1 text-[11px] font-medium transition-colors',
        active ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
