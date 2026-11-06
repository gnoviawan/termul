import type { Dispatch, SetStateAction } from 'react'
import { rowId } from '@/components/settings/row-id'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsRow } from '@/components/settings/SettingsRow'
import { Button } from '@/components/ui/button'

interface ResetSectionProps {
  setIsResetDialogOpen: Dispatch<SetStateAction<boolean>>
}

export function ResetSection({ setIsResetDialogOpen }: ResetSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="reset">
      <SettingsGroup
        title={<span className="text-destructive">Danger zone</span>}
        footnote="To reset only keyboard shortcuts, use Keyboard shortcuts → Reset all shortcuts."
      >
        <div className="@container overflow-hidden rounded-lg border border-destructive/25 bg-card">
          <SettingsRow
            id={rowId('reset-settings')}
            label="Reset all settings"
            description="Every setting goes back to its default, including keyboard shortcuts. Terminal profiles stay."
            layout="inline"
          >
            <Button
              type="button"
              size="xs"
              variant="destructive"
              onClick={() => setIsResetDialogOpen(true)}
            >
              Reset settings…
            </Button>
          </SettingsRow>
        </div>
      </SettingsGroup>
    </SettingsSection>
  )
}
