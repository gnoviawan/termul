import type { Dispatch, SetStateAction } from 'react'
import { RotateCcw } from '@/components/icons'
import { SettingsSection } from '@/components/settings/SettingsLayout'

interface ResetSectionProps {
  setIsResetDialogOpen: Dispatch<SetStateAction<boolean>>
}

export function ResetSection({ setIsResetDialogOpen }: ResetSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="reset">
      <div className="grid grid-cols-1 items-center gap-6 pb-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="w-full">
          <h2 className="text-lg font-medium text-foreground">Reset Settings</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Restore all settings to their default values.
          </p>
        </div>
        <div className="flex w-full justify-end">
          <button
            onClick={() => setIsResetDialogOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-card hover:bg-secondary border border-border rounded-lg text-sm text-foreground transition-colors"
          >
            <RotateCcw size={16} />
            Reset to Defaults
          </button>
        </div>
      </div>
    </SettingsSection>
  )
}
