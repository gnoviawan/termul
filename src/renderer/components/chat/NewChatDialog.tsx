import { useState, useCallback, useMemo, useEffect } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Pencil, Trash2, Plus, Server } from 'lucide-react'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useProjectStore } from '@/stores/project-store'
import { buildMcpServers } from '@/lib/acp-mcp-persistence'
import { McpServerDialog } from './McpServerDialog'
import { templateIcon } from './agent-templates'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'

interface NewChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Opens the agent-config dialog when the user has no agents yet, or to add. */
  onAddAgent: () => void
  /** Opens the agent-config dialog to edit an existing agent. */
  onEditAgent: (config: StoredAgentConfig) => void
  /** Target pane for the new chat tab (defaults to the active pane). */
  targetPaneId?: string
}

export function NewChatDialog({
  open,
  onOpenChange,
  onAddAgent,
  onEditAgent,
  targetPaneId
}: NewChatDialogProps): React.JSX.Element {
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const mcpServers = useAcpStore((s) => s.mcpServers)
  const startChat = useAcpStore((s) => s.startChat)
  const deleteAgentConfig = useAcpStore((s) => s.deleteAgentConfig)
  const addAgentChatTab = useWorkspaceStore((s) => s.addAgentChatTab)

  const activeProject = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const defaultCwd = activeProject?.path ?? ''

  const [configId, setConfigId] = useState<string>(agentConfigs[0]?.id ?? '')
  const [cwd, setCwd] = useState<string>(defaultCwd)
  const [selectedMcp, setSelectedMcp] = useState<string[]>([])
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false)
  const [starting, setStarting] = useState(false)

  // Keep defaults fresh when the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setConfigId((prev) => prev || (agentConfigs[0]?.id ?? ''))
      setCwd((prev) => prev || defaultCwd)
      // Reset MCP selection so a previous chat's choices don't carry over.
      setSelectedMcp([])
    }
  }, [open, agentConfigs, defaultCwd])

  const canStart = useMemo(
    () => configId.length > 0 && cwd.trim().length > 0 && !starting,
    [configId, cwd, starting]
  )

  const handleStart = useCallback(async () => {
    if (!canStart) return
    setStarting(true)
    try {
      const servers = buildMcpServers(mcpServers, selectedMcp)
      const sessionId = await startChat(configId, cwd.trim(), servers.length > 0 ? servers : undefined)
      addAgentChatTab(sessionId, targetPaneId)
      onOpenChange(false)
    } catch (err) {
      toast.error(`Failed to start chat: ${String(err)}`)
    } finally {
      setStarting(false)
    }
  }, [canStart, startChat, configId, cwd, mcpServers, selectedMcp, addAgentChatTab, targetPaneId, onOpenChange])

  const toggleMcp = useCallback((id: string) => {
    setSelectedMcp((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const handleDelete = useCallback(
    (id: string) => {
      void deleteAgentConfig(id)
        .then(() => {
          // keep the selection valid after removal
          setConfigId((prev) => (prev === id ? '' : prev))
        })
        .catch((err) => toast.error(`Failed to delete agent: ${String(err)}`))
    },
    [deleteAgentConfig]
  )

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Chat</DialogTitle>
          <DialogDescription>Start a conversation with an ACP agent.</DialogDescription>
        </DialogHeader>

        {agentConfigs.length === 0 ? (
          <div className="flex flex-col items-start gap-2 py-2 text-sm text-muted-foreground">
            <p>No agents configured yet.</p>
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onAddAgent()
              }}
            >
              Add an agent
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Agent</Label>
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => {
                    onOpenChange(false)
                    onAddAgent()
                  }}
                >
                  + Add agent
                </button>
              </div>
              <Select value={configId} onValueChange={setConfigId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agentConfigs.map((c) => {
                    const Icon = templateIcon(c.templateId)
                    return (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          {Icon && <Icon width={13} height={13} />}
                          {c.name}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {configId && (
                <div className="flex items-center justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => {
                      const cfg = agentConfigs.find((c) => c.id === configId)
                      if (cfg) {
                        onOpenChange(false)
                        onEditAgent(cfg)
                      }
                    }}
                  >
                    <Pencil size={11} /> Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-red-400 hover:text-red-300"
                    onClick={() => handleDelete(configId)}
                  >
                    <Trash2 size={11} /> Delete
                  </Button>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="acp-cwd" className="text-xs">
                Working Directory
              </Label>
              <Input
                id="acp-cwd"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/project"
                className="font-mono"
              />
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">MCP Servers</Label>
                <button
                  type="button"
                  className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                  onClick={() => setMcpDialogOpen(true)}
                >
                  <Plus size={11} /> Add server
                </button>
              </div>
              {mcpServers.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No MCP servers configured. Agents will use only their built-in tools.
                </p>
              ) : (
                <div className="flex flex-col gap-1 rounded-md border border-border/60 p-1">
                  {mcpServers.map((server) => (
                    <label
                      key={server.id}
                      className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedMcp.includes(server.id)}
                        onChange={() => toggleMcp(server.id)}
                      />
                      <Server size={11} className="text-muted-foreground" />
                      <span className="truncate flex-1">{server.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {server.type ?? 'stdio'}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {agentConfigs.length > 0 && (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleStart} disabled={!canStart}>
              {starting ? 'Starting…' : 'Start Chat'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
    <McpServerDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />
    </>
  )
}
