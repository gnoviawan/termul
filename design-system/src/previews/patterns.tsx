import { type FormEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { AgentConnectionLamp } from '@/components/chat/AgentConnectionLamp'
import {
  AlertTriangle,
  Check,
  Copy,
  FolderOpen,
  Info,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  XCircle
} from '@/components/icons'
import {
  CrashedMark,
  IdleAgentMark,
  NeedsYouButton,
  RunningMark
} from '@/components/sidebar/indicators'
import { SSHHostLamp, type SSHHostState, SSHHostStateWord } from '@/components/ssh/ssh-host-status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogClose,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import { toast } from '@/components/ui/sonner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Caption, Pad, Row } from './kit'
import { MOCK_COMMANDS } from './mocks'

/* --------------------------------------------------------------- Overlays */

export function DialogPreview() {
  return (
    <Pad className="gap-4">
      <Row label="Dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Rename session</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename session</DialogTitle>
              <DialogDescription>The name shows in the tab bar and the sidebar.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ds-dialog-name">Name</Label>
              <Input id="ds-dialog-name" defaultValue="api-server" />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button>Save</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Row>
      <Row label="AlertDialog">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">
              <Trash2 aria-hidden />
              Delete worktree
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete worktree feature/canvas?</AlertDialogTitle>
              <AlertDialogDescription>
                Uncommitted changes in this worktree are lost. The branch stays.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Row>
    </Pad>
  )
}

const SHEET_SIDES = ['top', 'right', 'bottom', 'left'] as const

export function SheetPreview() {
  return (
    <Pad className="gap-4">
      <Row label="side">
        {SHEET_SIDES.map((side) => (
          <Sheet key={side}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="capitalize">
                {side}
              </Button>
            </SheetTrigger>
            <SheetContent side={side}>
              <SheetHeader>
                <SheetTitle>Session details</SheetTitle>
                <SheetDescription>Opened from the {side} edge.</SheetDescription>
              </SheetHeader>
              <dl className="grid grid-cols-[96px_1fr] gap-2 px-4 text-xs">
                <dt className="text-muted-foreground">Shell</dt>
                <dd>zsh</dd>
                <dt className="text-muted-foreground">Started</dt>
                <dd className="tabular-nums">09:12</dd>
              </dl>
              <SheetFooter>
                <SheetClose asChild>
                  <Button variant="outline">Close</Button>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        ))}
      </Row>
      <Caption>Sheets slide on --ease-drawer. Escape or the overlay closes them.</Caption>
    </Pad>
  )
}

type ConfirmCase = 'default' | 'danger' | 'loading' | null

export function ConfirmDialogPreview() {
  const [open, setOpen] = useState<ConfirmCase>(null)
  const close = () => setOpen(null)
  return (
    <Pad className="gap-4">
      <Row label="variant">
        <Button variant="outline" onClick={() => setOpen('default')}>
          Default
        </Button>
        <Button variant="outline" onClick={() => setOpen('danger')}>
          Danger
        </Button>
        <Button variant="outline" onClick={() => setOpen('loading')}>
          Loading
        </Button>
      </Row>
      <Caption>ConfirmDialog from components/ConfirmDialog. Danger focuses Cancel first.</Caption>
      {/* ConfirmDialog renders a fixed overlay inline, not in a portal. Inside the
          transformed canvas world, fixed would pin to the world, so portal it here. */}
      {createPortal(
        <>
          <ConfirmDialog
            isOpen={open === 'default'}
            title="Restart the terminal?"
            message="The shell restarts in the same folder. Scrollback is kept."
            confirmLabel="Restart"
            onConfirm={close}
            onCancel={close}
          />
          <ConfirmDialog
            isOpen={open === 'danger'}
            variant="danger"
            title="Close 3 terminals?"
            message="Running processes in these terminals stop."
            confirmLabel="Close terminals"
            onConfirm={close}
            onCancel={close}
          />
          <ConfirmDialog
            isOpen={open === 'loading'}
            title="Pull latest changes?"
            message="Fetching from origin."
            confirmLabel="Pull"
            isLoading
            onConfirm={close}
            onCancel={close}
          />
        </>,
        document.body
      )}
    </Pad>
  )
}

/* ------------------------------------------------------------------ Menus */

export function DropdownMenuPreview() {
  const [wrap, setWrap] = useState(true)
  const [minimap, setMinimap] = useState(false)
  const [shell, setShell] = useState('zsh')
  return (
    <Pad className="gap-4">
      <Row label="Dropdown">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">View options</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Editor</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
              Word wrap
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={minimap} onCheckedChange={setMinimap}>
              Minimap
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Default shell</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={shell} onValueChange={setShell}>
              {['bash', 'zsh', 'fish'].map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {value}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Open in</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>New tab</DropdownMenuItem>
                <DropdownMenuItem>Split right</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem>
              New terminal
              <DropdownMenuShortcut>Ctrl+T</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
      <Row label="Context">
        <ContextMenu>
          <ContextMenuTrigger className="flex h-20 w-64 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
            Right-click here
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuLabel>src/server/index.ts</ContextMenuLabel>
            <ContextMenuItem>
              <FolderOpen aria-hidden />
              Reveal in explorer
            </ContextMenuItem>
            <ContextMenuItem>
              <Copy aria-hidden />
              Copy path
              <ContextMenuShortcut>Ctrl+Shift+C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem>
              <Pencil aria-hidden />
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive">
              <Trash2 aria-hidden />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Row>
    </Pad>
  )
}

function CommandItems() {
  const groups = [...new Set(MOCK_COMMANDS.map((command) => command.group))]
  return (
    <>
      <CommandEmpty>No commands found.</CommandEmpty>
      {groups.map((group, index) => (
        <div key={group}>
          {index > 0 ? <CommandSeparator /> : null}
          <CommandGroup heading={group}>
            {MOCK_COMMANDS.filter((command) => command.group === group).map((command) => (
              <CommandItem key={command.label} value={command.label}>
                <Terminal aria-hidden />
                <span>{command.label}</span>
                <Kbd className="ml-auto px-1.5 py-0.5">{command.shortcut}</Kbd>
              </CommandItem>
            ))}
          </CommandGroup>
        </div>
      ))}
    </>
  )
}

export function CommandPreview() {
  const [open, setOpen] = useState(false)
  return (
    <Pad className="gap-4">
      <Command className="rounded-xl border border-border">
        <CommandInput placeholder="Type a command" />
        <CommandList className="max-h-56">
          <CommandItems />
        </CommandList>
      </Command>
      <Row label="dialog">
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open CommandDialog
        </Button>
      </Row>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command" />
        <CommandList>
          <CommandItems />
        </CommandList>
      </CommandDialog>
    </Pad>
  )
}

/* ----------------------------------------------------------------- Toasts */

export function ToastPreview() {
  return (
    <Pad className="gap-4">
      <Row label="type">
        <Button variant="outline" size="sm" onClick={() => toast('Session renamed to api-server')}>
          Message
        </Button>
        <Button variant="outline" size="sm" onClick={() => toast.success('Pushed 3 commits')}>
          Success
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.error('Push rejected', { description: 'Pull first, then retry.' })}
        >
          Error
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.warning('Disk almost full', { description: '2 GB left' })}
        >
          Warning
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.info('Update ready', { description: 'Restart to apply.' })}
        >
          Info
        </Button>
      </Row>
      <Row label="flow">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast('Terminal closed', {
              action: { label: 'Undo', onClick: () => toast.success('Terminal restored') }
            })
          }
        >
          With action
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast.promise(new Promise((resolve) => window.setTimeout(resolve, 1400)), {
              loading: 'Cloning repository…',
              success: 'Cloned into ~/code/demo',
              error: 'Clone failed'
            })
          }
        >
          Promise
        </Button>
      </Row>
      <Caption>Real sonner Toaster from components/ui/sonner, no richColors.</Caption>
    </Pad>
  )
}

/* ----------------------------------------------------------------- Status */

const STATUS_CHIPS = [
  { label: 'Connected', icon: Check, className: 'text-success' },
  { label: 'Needs review', icon: AlertTriangle, className: 'text-warning' },
  { label: 'Failed', icon: XCircle, className: 'text-destructive' },
  { label: 'Syncing', icon: Info, className: 'text-connection' }
] as const

const SSH_STATES: SSHHostState[] = [
  'idle',
  'connecting',
  'attention',
  'connected',
  'disconnected',
  'failed'
]

export function StatusPreview() {
  return (
    <Pad className="gap-4">
      <Row label="chips">
        {STATUS_CHIPS.map(({ label, icon: Icon, className }) => (
          <span
            key={label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs',
              className
            )}
          >
            <Icon size={14} aria-hidden />
            {label}
          </span>
        ))}
      </Row>
      <Row label="badges">
        <Badge variant="secondary">Draft</Badge>
        <Badge variant="outline">Read only</Badge>
        <Badge variant="destructive">Conflict</Badge>
      </Row>
      <Row label="sidebar">
        <RunningMark />
        <IdleAgentMark />
        <NeedsYouButton count={2} />
        <CrashedMark />
      </Row>
      <Caption>Status color always rides with a label or an icon.</Caption>
    </Pad>
  )
}

export function ConnectionStatesPreview() {
  return (
    <Pad className="gap-3">
      <span className="label-group text-muted-foreground">SSH host states</span>
      <ul className="flex flex-col gap-1">
        {SSH_STATES.map((state) => (
          <li
            key={state}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-xs hover:bg-row-hover"
          >
            <SSHHostLamp state={state} />
            <span className="font-mono text-foreground">prod-{state}</span>
            <SSHHostStateWord state={state} sessionCount={state === 'connected' ? 3 : 0} />
            <span className="ml-auto font-mono text-muted-foreground">{state}</span>
          </li>
        ))}
      </ul>
      <span className="label-group pt-2 text-muted-foreground">Agent connection lamp</span>
      <div className="flex flex-wrap items-center gap-5 text-xs">
        <span className="flex items-center gap-2">
          <AgentConnectionLamp connected />
          Connected
        </span>
        <span className="flex items-center gap-2">
          <AgentConnectionLamp connected={false} reconnecting />
          Reconnecting
        </span>
        <span className="flex items-center gap-2">
          <AgentConnectionLamp connected={false} />
          Disconnected
        </span>
        <span className="flex items-center gap-2">
          <AgentConnectionLamp connected={false} hostOffline />
          Host offline
        </span>
      </div>
    </Pad>
  )
}

/* ------------------------------------------------------------------ Forms */

export function FormPreview() {
  const [name, setName] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const invalid = submitted && name.trim().length === 0
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (name.trim()) toast.success(`Created ${name.trim()} (mock)`)
  }
  return (
    <form className="flex flex-col gap-4 p-5" onSubmit={onSubmit} noValidate>
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold">New SSH host</h4>
        <p className="text-xs text-muted-foreground">Nothing is saved. Submitting shows a toast.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-form-name">Name</Label>
        <Input
          id="ds-form-name"
          value={name}
          placeholder="staging"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'ds-form-name-error' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {invalid ? (
          <p id="ds-form-name-error" className="text-xs text-destructive">
            Enter a name for the host.
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ds-form-host">Host</Label>
          <Input id="ds-form-host" placeholder="192.0.2.10" spellCheck={false} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ds-form-port">Port</Label>
          <Input id="ds-form-port" inputMode="numeric" defaultValue="22" className="tabular-nums" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-form-auth">Authentication</Label>
        <Select defaultValue="key">
          <SelectTrigger id="ds-form-auth">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="key">SSH key</SelectItem>
            <SelectItem value="agent">SSH agent</SelectItem>
            <SelectItem value="password">Password</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-form-notes">Notes</Label>
        <Textarea id="ds-form-notes" rows={2} placeholder="Optional" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="ds-form-connect" className="font-normal">
          Connect after saving
        </Label>
        <Switch id="ds-form-connect" defaultChecked />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="reset"
          variant="ghost"
          onClick={() => {
            setName('')
            setSubmitted(false)
          }}
        >
          Cancel
        </Button>
        <Button type="submit">
          <Plus aria-hidden />
          Add host
        </Button>
      </div>
    </form>
  )
}
