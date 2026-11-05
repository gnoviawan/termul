import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsSwitchRow } from '@/components/settings/SettingsSwitchRow'

interface NotificationsSectionProps {
  notifyOnTerminalIdle: boolean
  notifyOnAgentChatTurnFinished: boolean
  notifyOnAgentChatNeedsYou: boolean
  handleNotifyOnTerminalIdleToggle: (enabled: boolean) => void
  handleNotifyOnAgentChatTurnFinishedToggle: (enabled: boolean) => void
  handleNotifyOnAgentChatNeedsYouToggle: (enabled: boolean) => void
}

export function NotificationsSection({
  notifyOnTerminalIdle,
  notifyOnAgentChatTurnFinished,
  notifyOnAgentChatNeedsYou,
  handleNotifyOnTerminalIdleToggle,
  handleNotifyOnAgentChatTurnFinishedToggle,
  handleNotifyOnAgentChatNeedsYouToggle
}: NotificationsSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="notifications">
      <SettingsGroup title="Terminal">
        <SettingsCard>
          <SettingsSwitchRow
            id="notify-terminal-idle"
            label="Notify when a terminal agent finishes"
            description="A long-running terminal tab goes quiet."
            checked={notifyOnTerminalIdle}
            onToggle={handleNotifyOnTerminalIdleToggle}
          />
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="Agent chat">
        <SettingsCard>
          <SettingsSwitchRow
            id="notify-turn-finished"
            label="Notify when an agent chat turn finishes"
            description="A chat turn ends and nothing is queued."
            checked={notifyOnAgentChatTurnFinished}
            onToggle={handleNotifyOnAgentChatTurnFinishedToggle}
          />
          <SettingsSwitchRow
            id="notify-needs-you"
            label="Notify when an agent chat needs you"
            description="An agent waits for your approval or an answer."
            checked={notifyOnAgentChatNeedsYou}
            onToggle={handleNotifyOnAgentChatNeedsYouToggle}
          />
        </SettingsCard>
      </SettingsGroup>
    </SettingsSection>
  )
}
