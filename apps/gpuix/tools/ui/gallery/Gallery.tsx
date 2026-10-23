/**
 * The ui gallery, one source for both clients. The web build resolves
 * `@/components/ui/*` to the real Radix components in src/renderer; the GPUIX
 * build aliases the same specifiers to apps/gpuix/src/ui (tools/ui/alias.ts).
 * Raw elements here are only `div`s with numeric layout styles, which both
 * renderers read the same way; all text goes through ui components.
 */
import { type ReactNode, useState } from 'react'
import { Check, Copy, Plus, Search, Settings, Trash2 } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CountBadge } from '@/components/ui/count-badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CELLS, type CellId, type SceneId } from './layout'

function Cell({ id, children }: { id: CellId; children: ReactNode }) {
  const r = CELLS[id]
  return (
    <div
      style={{
        position: 'absolute',
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
        display: 'flex',
        alignItems: 'center',
        gap: 12
      }}
    >
      {children}
    </div>
  )
}

const VARIANTS = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const

interface SceneProps {
  onEvent: (text: string) => void
  /** Start closed, for the interaction checks; the screenshots start open. */
  interactive: boolean
}

function Controls({ onEvent }: SceneProps) {
  const [on, setOn] = useState(true)
  return (
    <>
      <Cell id="buttons">
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </Cell>
      <Cell id="button-sizes">
        <Button size="xs">Extra small</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" variant="outline" aria-label="Settings">
          <Settings />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Search">
          <Search />
        </Button>
        <Button size="icon-xs" variant="secondary" aria-label="Add">
          <Plus />
        </Button>
        <Button disabled>Disabled</Button>
        <Button variant="outline">
          <Copy />
          With icon
        </Button>
      </Cell>
      <Cell id="fields">
        <div style={{ width: 260, display: 'flex' }}>
          <Input placeholder="Search projects" />
        </div>
        <div style={{ width: 260, display: 'flex' }}>
          <Input defaultValue="termul-server" />
        </div>
        <div style={{ width: 300, display: 'flex' }}>
          <Textarea placeholder="Describe the change" />
        </div>
      </Cell>
      <Cell id="toggles">
        <Switch
          data-testid="switch-off"
          checked={false}
          onCheckedChange={(checked) => onEvent(`switch:${checked}`)}
        />
        <Switch checked={on} onCheckedChange={setOn} />
        <Label>Auto-save</Label>
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge variant="outline">Outline</Badge>
        <CountBadge count={7} className="h-4 min-w-4 text-3xs" />
        <CountBadge count={120} max={99} className="h-4 min-w-4 text-3xs" />
      </Cell>
      <Cell id="misc">
        <Kbd className="px-1 py-0.5">Ctrl+K</Kbd>
        <Kbd className="px-1 py-0.5">Esc</Kbd>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="size-8 rounded-full" />
        <Spinner />
        <Spinner size={24} className="text-muted-foreground" />
        <Check className="size-4 text-success" />
        <Trash2 className="size-4 text-destructive" />
      </Cell>
    </>
  )
}

function DialogScene({ onEvent, interactive }: SceneProps) {
  const [open, setOpen] = useState(!interactive)
  return (
    <Cell id="overlay-trigger">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          onEvent(`dialog:${next}`)
        }}
      >
        <DialogTrigger asChild>
          <Button data-testid="dialog-trigger" variant="outline">
            Open dialog
          </Button>
        </DialogTrigger>
        <DialogContent data-testid="dialog-content">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              The new name shows in the sidebar and the title bar.
            </DialogDescription>
          </DialogHeader>
          <Input defaultValue="termul" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Cell>
  )
}

const MENU_ITEMS = ['Rename', 'Duplicate', 'Archive'] as const

function DropdownScene({ onEvent, interactive }: SceneProps) {
  const [open, setOpen] = useState(!interactive)
  const [pinned, setPinned] = useState(true)
  return (
    <Cell id="overlay-trigger">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button data-testid="dropdown-trigger" variant="outline">
            Project actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-testid="dropdown-content" className="w-56" align="start">
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          {MENU_ITEMS.map((item) => (
            <DropdownMenuItem
              key={item}
              data-testid={`menu-${item.toLowerCase()}`}
              onSelect={() => onEvent(`select:${item.toLowerCase()}`)}
            >
              {item}
              <DropdownMenuShortcut>⌘{item[0]}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>
            Pinned
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Cell>
  )
}

function PopoverScene({ onEvent, interactive }: SceneProps) {
  const [open, setOpen] = useState(!interactive)
  return (
    <Cell id="overlay-trigger">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          onEvent(`popover:${next}`)
        }}
      >
        <PopoverTrigger asChild>
          <Button data-testid="popover-trigger" variant="outline">
            Show details
          </Button>
        </PopoverTrigger>
        <PopoverContent data-testid="popover-content" align="start">
          <Label>Branch</Label>
          <div style={{ height: 8 }} />
          <Input defaultValue="gpuix/k1" />
        </PopoverContent>
      </Popover>
    </Cell>
  )
}

function TooltipScene() {
  return (
    <Cell id="overlay-trigger">
      <TooltipProvider delayDuration={400}>
        <Tooltip open>
          <TooltipTrigger asChild>
            <Button data-testid="tooltip-trigger" variant="outline" size="icon" aria-label="Copy">
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent data-testid="tooltip-content" side="bottom">
            Copy to clipboard
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </Cell>
  )
}

const MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' }
] as const

function SelectScene({ onEvent, interactive }: SceneProps) {
  const [value, setValue] = useState('opus')
  return (
    <Cell id="overlay-trigger">
      <div style={{ width: 240, display: 'flex' }}>
        <Select
          defaultOpen={!interactive}
          value={value}
          onValueChange={(next) => {
            setValue(next)
            onEvent(`value:${next}`)
          }}
        >
          <SelectTrigger data-testid="select-trigger">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent data-testid="select-content">
            {MODELS.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Cell>
  )
}

/** The last interaction, painted so the automation checks can read it back. */
function EventLog({ text }: { text: string }) {
  return (
    <Cell id="event-log">
      <Label data-testid="event-log" className="text-xs text-muted-foreground">
        {text || 'no events'}
      </Label>
    </Cell>
  )
}

export function Gallery({ scene, interactive = false }: { scene: SceneId; interactive?: boolean }) {
  const [event, setEvent] = useState('')
  const props = { onEvent: setEvent, interactive }
  return (
    <>
      {scene === 'controls' && <Controls {...props} />}
      {scene === 'dialog' && <DialogScene {...props} />}
      {scene === 'dropdown' && <DropdownScene {...props} />}
      {scene === 'popover' && <PopoverScene {...props} />}
      {scene === 'tooltip' && <TooltipScene />}
      {scene === 'select' && <SelectScene {...props} />}
      <EventLog text={event} />
    </>
  )
}
