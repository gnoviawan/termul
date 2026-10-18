/**
 * Where each project's canvas shows. A visible `CanvasPanel` registers its
 * slot element here; `CanvasMountLayer` lays the project's iframe over that
 * slot, or offscreen when there is none. The iframe itself never moves in the
 * DOM, because re-parenting an iframe reloads it.
 */

import { create } from 'zustand'

interface CanvasSlotState {
  slots: Record<string, HTMLElement>
  claimSlot: (projectId: string, element: HTMLElement) => void
  /** Releases the slot only while `element` still holds it, so a panel that
   * unmounts after its successor claimed the slot does not clear it. */
  releaseSlot: (projectId: string, element: HTMLElement) => void
}

export const useCanvasSlots = create<CanvasSlotState>((set) => ({
  slots: {},
  claimSlot: (projectId, element) =>
    set((state) =>
      state.slots[projectId] === element ? {} : { slots: { ...state.slots, [projectId]: element } }
    ),
  releaseSlot: (projectId, element) =>
    set((state) => {
      if (state.slots[projectId] !== element) return {}
      const { [projectId]: _released, ...rest } = state.slots
      return { slots: rest }
    })
}))
