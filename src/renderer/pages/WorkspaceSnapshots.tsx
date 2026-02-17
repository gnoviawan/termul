import { useState, useCallback } from 'react'
import { Camera, Clock, Cpu, Grid3X3, Edit2, Trash2, RotateCcw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { NewProjectModal } from '@/components/NewProjectModal'
import { CreateSnapshotModal } from '@/components/CreateSnapshotModal'
import { RestoreSnapshotModal } from '@/components/RestoreSnapshotModal'
import { DeleteSnapshotModal } from '@/components/DeleteSnapshotModal'
import {
  useActiveProject,
  useActiveProjectId,
  useProjectActions,
  useProjectsLoaded
} from '@/stores/project-store'
import { useSnapshots, useSnapshotLoader, useCreateSnapshot, useRestoreSnapshot, useSnapshotActions } from '@/hooks/use-snapshots'
import { useTerminalStore } from '@/stores/terminal-store'
import { getColorClasses } from '@/lib/colors'
import type { Snapshot } from '@/types/project'
import { cn } from '@/lib/utils'

export default function WorkspaceSnapshots(): React.JSX.Element {
  const navigate = useNavigate()
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)
  const [isCreateSnapshotModalOpen, setIsCreateSnapshotModalOpen] = useState(false)
  const [isRestoreModalOpen, setIsRestoreModalOpen] = useState(false)
  const [snapshotToRestore, setSnapshotToRestore] = useState<Snapshot | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [snapshotToDelete, setSnapshotToDelete] = useState<Snapshot | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const isLoaded = useProjectsLoaded()
  const activeProject = useActiveProject()
  const activeProjectId = useActiveProjectId()
  const {
    addProject
  } = useProjectActions()

  // Load snapshots when project changes
  useSnapshotLoader()

  // Get snapshots for current project
  const snapshots = useSnapshots()
  const createSnapshot = useCreateSnapshot()
  const restoreSnapshot = useRestoreSnapshot()
  const { deleteSnapshot } = useSnapshotActions()
  const terminals = useTerminalStore((state) => state.terminals)

  // Check if current project has terminals (running processes)
  const hasRunningProcesses = terminals.filter((t) => t.projectId === activeProjectId).length > 0

  const handleCreateSnapshot = useCallback(
    async (name: string, description?: string) => {
      await createSnapshot(name, description)
    },
    [createSnapshot]
  )

  const handleOpenRestoreModal = useCallback((snapshot: Snapshot) => {
    setSnapshotToRestore(snapshot)
    setIsRestoreModalOpen(true)
  }, [])

  const handleCloseRestoreModal = useCallback(() => {
    if (!isRestoring) {
      setIsRestoreModalOpen(false)
      setSnapshotToRestore(null)
    }
  }, [isRestoring])

  const handleRestore = useCallback(async () => {
    if (!snapshotToRestore) return

    setIsRestoring(true)
    try {
      await restoreSnapshot(snapshotToRestore.id)
      setIsRestoreModalOpen(false)
      setSnapshotToRestore(null)
      // Navigate to workspace dashboard after restore
      navigate('/')
    } catch (error) {
      console.error('Failed to restore snapshot:', error)
    } finally {
      setIsRestoring(false)
    }
  }, [snapshotToRestore, restoreSnapshot, navigate])

  const handleOpenDeleteModal = useCallback((snapshot: Snapshot) => {
    setSnapshotToDelete(snapshot)
    setIsDeleteModalOpen(true)
  }, [])

  const handleCloseDeleteModal = useCallback(() => {
    if (!isDeleting) {
      setIsDeleteModalOpen(false)
      setSnapshotToDelete(null)
    }
  }, [isDeleting])

  const handleDelete = useCallback(async () => {
    if (!snapshotToDelete) return

    setIsDeleting(true)
    try {
      await deleteSnapshot(snapshotToDelete.id)
      setIsDeleteModalOpen(false)
      setSnapshotToDelete(null)
    } catch (error) {
      console.error('Failed to delete snapshot:', error)
    } finally {
      setIsDeleting(false)
    }
  }, [snapshotToDelete, deleteSnapshot])

  const colors = activeProject ? getColorClasses(activeProject.color) : getColorClasses('blue')

  const formatTime = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffHours < 1) return 'Just now'
    if (diffHours < 24) return `${diffHours} hours ago`
    if (diffDays === 1) return 'Yesterday'
    return `${diffDays} days ago`
  }

  // Show loading state while projects are being loaded
  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <>
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="h-14 bg-card border-b border-border flex items-center justify-between px-6">
          <div className="flex items-center">
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <span className={cn('w-3 h-3 rounded-full shadow-sm', colors.bg, colors.shadow)} />
              {activeProject?.name}
              <span className="text-border text-lg mx-1">/</span>
              <span className="text-secondary-foreground font-normal">Workspace Snapshots</span>
            </h1>
          </div>
          <button
            onClick={() => setIsCreateSnapshotModalOpen(true)}
            className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium py-1.5 px-3 rounded shadow-lg shadow-primary/20 transition-all flex items-center"
          >
            <Camera size={14} className="mr-2" />
            Create New Snapshot
          </button>
        </div>

        {/* Snapshot List */}
        <div className="flex-1 overflow-y-auto bg-terminal-bg p-6">
          <div className="max-w-5xl mx-auto space-y-4">
            {snapshots.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Camera size={48} className="text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">No snapshots yet</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Create a snapshot to save your current workspace state
                </p>
                <button
                  onClick={() => setIsCreateSnapshotModalOpen(true)}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium py-1.5 px-3 rounded shadow-lg shadow-primary/20 transition-all flex items-center"
                >
                  <Camera size={14} className="mr-2" />
                  Create First Snapshot
                </button>
              </div>
            ) : (
              snapshots.map((snapshot) => (
                <SnapshotCard
                  key={snapshot.id}
                  snapshot={snapshot}
                  formatTime={formatTime}
                  onRestore={handleOpenRestoreModal}
                  onDelete={handleOpenDeleteModal}
                />
              ))
            )}
          </div>
        </div>
      </main>

      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        onCreateProject={addProject}
      />

      <CreateSnapshotModal
        isOpen={isCreateSnapshotModalOpen}
        onClose={() => setIsCreateSnapshotModalOpen(false)}
        onCreateSnapshot={handleCreateSnapshot}
      />

      <RestoreSnapshotModal
        isOpen={isRestoreModalOpen}
        snapshot={snapshotToRestore}
        hasRunningProcesses={hasRunningProcesses}
        onClose={handleCloseRestoreModal}
        onRestore={handleRestore}
        isRestoring={isRestoring}
      />

      <DeleteSnapshotModal
        isOpen={isDeleteModalOpen}
        snapshot={snapshotToDelete}
        onClose={handleCloseDeleteModal}
        onDelete={handleDelete}
        isDeleting={isDeleting}
      />
    </>
  )
}

interface SnapshotCardProps {
  snapshot: Snapshot
  formatTime: (date: Date) => string
  onRestore: (snapshot: Snapshot) => void
  onDelete: (snapshot: Snapshot) => void
}

function SnapshotCard({ snapshot, formatTime, onRestore, onDelete }: SnapshotCardProps): React.JSX.Element {
  return (
    <div className="group bg-card/50 border border-border rounded-lg p-4 flex items-start gap-5 hover:border-muted-foreground/50 transition-colors">
      {/* Thumbnail */}
      <SnapshotThumbnail snapshot={snapshot} />

      {/* Content */}
      <div className="flex-1 min-w-0 pt-1">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold text-foreground">{snapshot.name}</h3>
            {snapshot.tag && (
              <span
                className={cn(
                  'px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider border',
                  snapshot.tag === 'stable'
                    ? 'bg-green-900/30 text-green-400 border-green-800/50'
                    : 'bg-primary/10 text-primary border-primary/30'
                )}
              >
                {snapshot.tag}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
              title="Rename"
            >
              <Edit2 size={14} />
            </button>
            <button
              onClick={() => onDelete(snapshot)}
              className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mb-3 line-clamp-1">{snapshot.description}</p>

        <div className="flex items-center gap-6 text-xs text-muted-foreground font-mono">
          <div className="flex items-center gap-1.5">
            <Clock size={14} />
            {formatTime(snapshot.createdAt)}
          </div>
          <div className="flex items-center gap-1.5">
            <Cpu size={14} />
            {snapshot.processCount} Active Processes
          </div>
          <div className="flex items-center gap-1.5">
            <Grid3X3 size={14} />
            {snapshot.paneCount} Panes
          </div>
        </div>
      </div>

      {/* Restore Button */}
      <div className="flex flex-col justify-center self-center pl-4 border-l border-border h-16">
        <button
          onClick={() => onRestore(snapshot)}
          className="bg-card hover:bg-secondary text-foreground text-xs font-medium py-1.5 px-3 rounded border border-border transition-colors flex items-center gap-2 shadow-sm"
        >
          <RotateCcw size={14} />
          Restore
        </button>
      </div>
    </div>
  )
}

function SnapshotThumbnail({ snapshot }: { snapshot: Snapshot }) {
  const getLines = () => {
    if (snapshot.tag === 'stable') {
      return [
        { color: 'bg-green-500/50', width: 75 },
        { color: 'bg-muted/50', width: 50 },
        { color: 'bg-muted/50', width: 66 },
        { color: 'bg-primary/30', width: 100 }
      ]
    }
    if (snapshot.processCount === 0) {
      return [
        { color: 'bg-green-500/50', width: 30 },
        { color: 'bg-muted/20', width: 100 },
        { color: 'bg-muted/20', width: 75 },
        { color: 'bg-green-500/50', width: 30 }
      ]
    }
    return [
      { color: 'bg-red-500/80', width: 25 },
      { color: 'bg-red-500/40', width: 75 },
      { color: 'bg-red-500/40', width: 50 },
      { color: 'bg-muted/30', width: 66 }
    ]
  }

  return (
    <div className="w-40 h-24 bg-black rounded border border-border relative overflow-hidden flex-shrink-0 shadow-inner p-1">
      <div className="flex flex-col gap-0.5">
        {getLines().map((line, i) => (
          <div
            key={i}
            className={cn('snapshot-line', line.color)}
            style={{ width: `${line.width}%` }}
          />
        ))}
      </div>
    </div>
  )
}
