/**
 * The four X1 targets (ported from the X1 prototype), mounted unchanged from `src/renderer` inside the
 * providers the web root gives them. The same file renders in the browser
 * (react-dom) and in GPUIX (through the compat runtime), against one seeded
 * server, so a pixel diff measures the compat layer and nothing else.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ShellRail } from '@/components/shell/ShellRail'
import { StatusBar } from '@/components/StatusBar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useProjectRegistry } from '@/hooks/use-project-registry'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

const queryClient = new QueryClient()
const noop = () => {}

function useSeededProjects() {
  useProjectRegistry()
  const projects = useProjectStore((s) => s.projects)
  const isLoaded = useProjectStore((s) => s.isLoaded)
  return { projects, isLoaded }
}

function StatusBarFixture() {
  const { projects, isLoaded } = useSeededProjects()
  if (!isLoaded || !projects[0]) return null
  return (
    <div data-testid="fixture-ready" className="flex h-full w-full flex-col">
      <div className="flex-1" />
      <StatusBar project={projects[0]} />
    </div>
  )
}

function SidebarFixture() {
  const { projects, isLoaded } = useSeededProjects()
  if (!isLoaded || projects.length === 0) return null
  return (
    <div data-testid="fixture-ready" className="flex h-full w-full">
      <ShellRail
        projects={projects}
        activeProject={projects[0]}
        activeProjectId={projects[0].id}
        onSelectProject={noop}
        onNewProject={noop}
        onSSHConnect={noop}
        onSelectSSHProfile={noop}
        activeSSHProfileId={null}
        onOpenCommandPalette={noop}
        onOpenCanvas={noop}
        canOpenCanvas={false}
        isShortcutsOpen={false}
        onShortcutsOpenChange={noop}
        isThemePickerOpen={false}
      />
      <div className="flex-1 bg-background" />
    </div>
  )
}

const USER_MESSAGE: ChatMessageType = {
  id: 'msg-user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Rename the status bar item and keep the tooltip.' }],
  streaming: false,
  timestamp: 1_760_000_000_000
} as ChatMessageType

const AGENT_MESSAGE: ChatMessageType = {
  id: 'msg-agent-1',
  role: 'agent',
  blocks: [
    {
      type: 'text',
      text: 'Done. I renamed **StatusItem** and kept the tooltip.\n\n- The label now reads `project-name`.\n- Nothing else changed.\n\nRun the status bar tests next.'
    }
  ],
  streaming: false,
  timestamp: 1_760_000_001_000
} as ChatMessageType

function ChatFixture() {
  return (
    <div data-testid="fixture-ready" className="mx-auto flex w-[720px] flex-col gap-4 p-6">
      <ChatMessage message={USER_MESSAGE} animateEnter={false} />
      <ChatMessage message={AGENT_MESSAGE} animateEnter={false} isLast isTurnTail />
    </div>
  )
}

function DialogFixture() {
  return (
    <div data-testid="fixture-ready" className="h-full w-full">
      <ConfirmDialog
        isOpen
        title="Delete project?"
        message="This removes alpha from Termul. Files on disk stay where they are."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={noop}
        onCancel={noop}
      />
    </div>
  )
}

export const FIXTURES: Record<string, () => ReactNode> = {
  statusbar: StatusBarFixture,
  sidebar: SidebarFixture,
  chat: ChatFixture,
  dialog: DialogFixture
}

export function FixtureRoot({ name }: { name: string }) {
  const Fixture = FIXTURES[name]
  if (!Fixture) throw new Error(`unknown fixture ${name}`)
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TooltipProvider delayDuration={80} skipDelayDuration={300}>
          <div className="flex h-screen w-screen flex-col bg-background font-sans text-sm text-foreground">
            <Fixture />
          </div>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
