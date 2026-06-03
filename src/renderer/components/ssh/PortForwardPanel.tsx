import type { ActivePortForward, PortForwardConfig, SSHConnection } from '@shared/types/ssh.types'
import { ArrowRightLeft, Circle, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useSSHActions } from '@/stores/ssh-store'

interface PortForwardPanelProps {
  connection: SSHConnection
}

export function PortForwardPanel({ connection }: PortForwardPanelProps): React.JSX.Element {
  const { startPortForward, stopPortForward } = useSSHActions()
  const [showAdd, setShowAdd] = useState(false)
  const [localPort, setLocalPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('localhost')
  const [remotePort, setRemotePort] = useState('')

  const handleAdd = async () => {
    const lp = Number(localPort)
    const rp = Number(remotePort)

    if (
      !Number.isInteger(lp) ||
      lp < 1 ||
      lp > 65535 ||
      !Number.isInteger(rp) ||
      rp < 1 ||
      rp > 65535
    ) {
      toast.error('Invalid port numbers')
      return
    }

    const config: PortForwardConfig = {
      id: Date.now().toString(),
      type: 'local',
      localPort: lp,
      remoteHost: remoteHost || 'localhost',
      remotePort: rp,
      autoStart: false
    }

    const success = await startPortForward(connection.id, config)
    if (success) {
      toast.success(`Port forward started: ${lp} → ${remoteHost}:${rp}`)
      setShowAdd(false)
      setLocalPort('')
      setRemotePort('')
    } else {
      toast.error('Failed to start port forward')
    }
  }

  const handleStop = async (forward: ActivePortForward) => {
    const success = await stopPortForward(connection.id, forward.id)
    if (success) {
      toast.success(`Port forward stopped: ${forward.localPort}`)
    }
  }

  return (
    <div className="border border-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Port Forwards</span>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="p-0.5 rounded hover:bg-accent text-muted-foreground"
          title="Add port forward"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Active forwards */}
      {connection.activeForwards.length > 0 ? (
        <div className="space-y-1">
          {connection.activeForwards.map((forward) => (
            <div
              key={forward.id}
              className="flex items-center justify-between px-2 py-1 bg-muted rounded text-xs"
            >
              <div className="flex items-center gap-2">
                <Circle
                  className={cn(
                    'h-2 w-2 fill-current',
                    forward.status === 'active' ? 'text-green-500' : 'text-red-500'
                  )}
                />
                <span className="font-mono">
                  :{forward.localPort} → {forward.remoteHost}:{forward.remotePort}
                </span>
              </div>
              <button
                onClick={() => handleStop(forward)}
                className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">No active port forwards</p>
      )}

      {/* Add form */}
      {showAdd && (
        <div className="mt-2 p-2 bg-muted rounded space-y-2">
          <div className="flex gap-2 items-center">
            <input
              type="number"
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
              placeholder="Local"
              className="w-16 px-2 py-1 text-xs bg-background border border-border rounded"
              min={1}
              max={65535}
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="text"
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              placeholder="host"
              className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded"
            />
            <span className="text-xs text-muted-foreground">:</span>
            <input
              type="number"
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
              placeholder="Port"
              className="w-16 px-2 py-1 text-xs bg-background border border-border rounded"
              min={1}
              max={65535}
            />
          </div>
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setShowAdd(false)}
              className="px-2 py-0.5 text-[10px] rounded border border-border hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              className="px-2 py-0.5 text-[10px] rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Start
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
