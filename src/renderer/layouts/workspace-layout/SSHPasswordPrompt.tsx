import { Button } from '@/components/ui/button'

interface SSHPasswordPromptProps {
  profileName: string
  passwordInput: string
  onPasswordInputChange: (value: string) => void
  onSubmit: () => void
  /** Clears the prompt and its input (Escape and the Cancel button). */
  onCancel: () => void
}

/** SSH Password Prompt */
export function SSHPasswordPrompt({
  profileName,
  passwordInput,
  onPasswordInputChange,
  onSubmit,
  onCancel
}: SSHPasswordPromptProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/50">
      <div className="bg-background border border-border rounded-lg shadow-lg w-[360px] p-4">
        <h3 className="text-sm font-semibold mb-1">SSH Password</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Enter password for <span className="font-medium">{profileName}</span>
        </p>
        <input
          type="password"
          value={passwordInput}
          onChange={(e) => onPasswordInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit()
            if (e.key === 'Escape') {
              onCancel()
            }
          }}
          placeholder="Password"
          autoFocus
          className="w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex justify-end gap-2 mt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onCancel()
            }}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onSubmit}>
            Connect
          </Button>
        </div>
      </div>
    </div>
  )
}
