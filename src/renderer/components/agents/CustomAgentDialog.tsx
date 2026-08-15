import { Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'
import type { AgentPromptMode, TerminalAgentDefinition } from '@/lib/agents/agent-registry'
import { toAgentDefinition, validateCustomAgent } from '@/lib/agents/custom-agents'
import { parseBaseArgsInput } from '@/lib/agents/parse-base-args'
import { IconPicker } from './IconPicker'

interface CustomAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAgentCreated: (agent: TerminalAgentDefinition) => void
}

interface FormState {
  name: string
  command: string
  baseArgs: string
  promptMode: AgentPromptMode
  promptFlag: string
  icon: string
  iconSource: string
}

const INITIAL_FORM: FormState = {
  name: '',
  command: '',
  baseArgs: '',
  promptMode: 'positional',
  promptFlag: '',
  icon: '',
  iconSource: ''
}

export function CustomAgentDialog({
  open,
  onOpenChange,
  onAgentCreated
}: CustomAgentDialogProps): React.JSX.Element {
  const t = useRuntimeTranslation('agents')
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [saving, setSaving] = useState(false)

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const input = {
        name: form.name,
        command: form.command,
        baseArgs: parseBaseArgsInput(form.baseArgs),
        promptMode: form.promptMode,
        promptFlag: form.promptMode === 'flag' ? form.promptFlag : undefined,
        icon: form.icon || undefined
      }
      const error = validateCustomAgent(input)
      if (error) {
        toast.error(error)
        return
      }
      const def = toAgentDefinition(input)
      onAgentCreated(def)
      setForm(INITIAL_FORM)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [form, onAgentCreated, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus size={18} />
            {t('customCli.title', 'New Custom Agent')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'customCli.description',
              'Add a CLI agent to the launcher. Configure how to call it and how prompts are passed.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Icon + Name row */}
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">{t('customCli.icon', 'Icon')}</Label>
              <IconPicker
                value={form.icon}
                onChange={(icon) => setForm((prev) => ({ ...prev, icon }))}
              />
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <Label htmlFor="agent-name" className="text-xs">
                {t('customCli.name', 'Name')}
              </Label>
              <Input
                id="agent-name"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder={t('customCli.namePlaceholder', 'My Agent')}
                className="h-9"
              />
            </div>
          </div>

          {/* Command */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-command" className="text-xs">
              {t('customCli.command', 'Command')}
            </Label>
            <Input
              id="agent-command"
              value={form.command}
              onChange={(e) => update('command', e.target.value)}
              placeholder={t('customCli.commandPlaceholder', 'e.g. claude, codex, my-agent')}
              className="h-9 font-mono text-sm"
            />
          </div>

          {/* Base Args */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-base-args" className="text-xs">
              {t('customCli.baseArguments', 'Base arguments')}{' '}
              <span className="text-muted-foreground font-normal">
                {t('customCli.baseArgumentsHint', '(space-separated, optional)')}
              </span>
            </Label>
            <Input
              id="agent-base-args"
              value={form.baseArgs}
              onChange={(e) => update('baseArgs', e.target.value)}
              placeholder={t('customCli.baseArgumentsPlaceholder', 'e.g. --interactive')}
              className="h-9 font-mono text-sm"
            />
          </div>

          {/* Prompt Mode */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">{t('customCli.promptMode', 'Prompt mode')}</Label>
            <Select
              value={form.promptMode}
              onValueChange={(v) => update('promptMode', v as AgentPromptMode)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="positional">
                  {t('customCli.promptModes.positional', 'Positional — prompt appended after args')}
                </SelectItem>
                <SelectItem value="flag">
                  {t(
                    'customCli.promptModes.flag',
                    'Flag — prompt follows a flag (e.g. -i "prompt")'
                  )}
                </SelectItem>
                <SelectItem value="none">
                  {t('customCli.promptModes.none', 'None — no seed prompt')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Prompt Flag (conditional) */}
          {form.promptMode === 'flag' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-prompt-flag" className="text-xs">
                {t('customCli.promptFlag', 'Prompt flag')}
              </Label>
              <Input
                id="agent-prompt-flag"
                value={form.promptFlag}
                onChange={(e) => update('promptFlag', e.target.value)}
                placeholder={t('customCli.promptFlagPlaceholder', 'e.g. -i, --prompt')}
                className="h-9 font-mono text-sm"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setForm(INITIAL_FORM)
              onOpenChange(false)
            }}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !form.name.trim() || !form.command.trim()}
          >
            {saving ? t('common.saving', 'Saving…') : t('customCli.create', 'Create Agent')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
