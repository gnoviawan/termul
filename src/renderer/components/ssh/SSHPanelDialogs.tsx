import type { SSHProfile } from '@shared/types/ssh.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { closeSSHSession, openSSHSession } from '@/lib/ssh-sessions'
import { useSSHActions, useSSHStore } from '@/stores/ssh-store'
import { SSHHostEditor } from './SSHHostEditor'

/** State and handlers behind the host editor and the delete confirmation. */
export interface SSHPanelDialogsController {
  /** True while the editor or the delete confirmation is open. */
  isOpen: boolean
  /** Opens the host editor; `null` = new host. */
  openForm: (profile: SSHProfile | null) => void
  /** Asks to delete `profile` (opens the confirmation). */
  requestDelete: (profile: SSHProfile) => void
  form: { profile: SSHProfile | null } | null
  closeForm: () => void
  saved: (profile: SSHProfile, connect: boolean) => void
  deleteConfirm: SSHProfile | null
  cancelDelete: () => void
  confirmDelete: () => void
}

/**
 * Lifts the host editor and delete-confirm handling out of the host lists so
 * a host that cannot keep them inside its own subtree (the Rail popover
 * closes first, then opens the dialog) can own them.
 */
export function useSSHPanelDialogs(): SSHPanelDialogsController {
  const { deleteProfile } = useSSHActions()
  // Editor: closed when null; `profile` null = new host.
  const [form, setForm] = useState<{ profile: SSHProfile | null } | null>(null)
  // Delete is irreversible — gate it behind a confirmation.
  const [deleteConfirm, setDeleteConfirm] = useState<SSHProfile | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleDelete = async (profile: SSHProfile): Promise<void> => {
    if (deletingId !== null) return
    setDeletingId(profile.id)
    try {
      // Close the host's sessions first so nothing keeps running for a
      // host that no longer exists.
      const sessions = useSSHStore.getState().sessions.filter((s) => s.profileId === profile.id)
      await Promise.all(sessions.map((s) => closeSSHSession(s.id)))
      const success = await deleteProfile(profile.id)
      if (!success) {
        toast.error(`Could not delete “${profile.name}”. Try again.`)
        return
      }
      toast.success(`Deleted “${profile.name}”`)
    } catch (error) {
      toast.error(
        `Could not delete “${profile.name}”: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setDeletingId(null)
    }
  }

  return {
    isOpen: form !== null || deleteConfirm !== null,
    openForm: (profile) => setForm({ profile }),
    requestDelete: setDeleteConfirm,
    form,
    closeForm: () => setForm(null),
    saved: (profile, connect) => {
      setForm(null)
      if (connect) openSSHSession(profile.id)
    },
    deleteConfirm,
    cancelDelete: () => setDeleteConfirm(null),
    confirmDelete: () => {
      if (!deleteConfirm) return
      const profile = deleteConfirm
      setDeleteConfirm(null)
      void handleDelete(profile)
    }
  }
}

function deleteMessage(profile: SSHProfile): string {
  // Every tab of the host closes (connecting and failed ones too).
  const open = useSSHStore.getState().sessions.filter((s) => s.profileId === profile.id).length
  const sessions =
    open === 0
      ? ''
      : open === 1
        ? ' Its session will be closed.'
        : ` Its ${open} sessions will be closed.`
  return `Delete “${profile.name}”?${sessions} Saved credentials are removed from your system keychain. This can't be undone.`
}

/** The host editor and the delete confirmation for a controller. */
export function SSHPanelDialogs({
  controller
}: {
  controller: SSHPanelDialogsController
}): React.JSX.Element {
  const { form, deleteConfirm } = controller
  return (
    <>
      <SSHHostEditor
        open={form !== null}
        profile={form?.profile ?? null}
        onOpenChange={(open) => {
          if (!open) controller.closeForm()
        }}
        onSaved={controller.saved}
      />
      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        title="Delete host"
        message={deleteConfirm ? deleteMessage(deleteConfirm) : ''}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={controller.confirmDelete}
        onCancel={controller.cancelDelete}
      />
    </>
  )
}
