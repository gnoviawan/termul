import { useState } from 'react'
import { Download, Terminal, ExternalLink, AlertCircle, CheckCircle2, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { openerApi } from '@/lib/api'
import { toast } from 'sonner'

interface CloudflaredSetupModalProps {
  isOpen: boolean
  onClose: () => void
}

export function CloudflaredSetupModal({ isOpen, onClose }: CloudflaredSetupModalProps): React.JSX.Element {
  const [step, setStep] = useState(1)

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text)
    toast.success('Command copied')
  }

  const steps = [
    {
      title: "Install Cloudflared",
      description: "Use your system's package manager to install the official Cloudflare Tunnel CLI.",
      content: (
        <div className="space-y-4 py-4">
          {/* Windows Options */}
          <div className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider px-1">Windows Options</h4>
            
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground px-1 italic">via Scoop (Recommended for Devs):</p>
              <div className="flex items-center gap-2 bg-terminal-bg rounded border border-white/5 p-2 pr-1 font-mono text-xs">
                <span className="text-muted-foreground shrink-0 select-none">$</span>
                <span className="text-terminal-fg truncate flex-1">scoop install cloudflared</span>
                <button onClick={() => copyToClipboard('scoop install cloudflared')} className="p-1.5 hover:bg-white/10 rounded transition-colors text-muted-foreground">
                  <Copy size={12} />
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground px-1 italic">via Winget:</p>
              <div className="flex items-center gap-2 bg-terminal-bg rounded border border-white/5 p-2 pr-1 font-mono text-xs">
                <span className="text-muted-foreground shrink-0 select-none">$</span>
                <span className="text-terminal-fg truncate flex-1">winget install Cloudflare.cloudflared</span>
                <button onClick={() => copyToClipboard('winget install Cloudflare.cloudflared')} className="p-1.5 hover:bg-white/10 rounded transition-colors text-muted-foreground">
                  <Copy size={12} />
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground px-1 italic">via Chocolatey:</p>
              <div className="flex items-center gap-2 bg-terminal-bg rounded border border-white/5 p-2 pr-1 font-mono text-xs">
                <span className="text-muted-foreground shrink-0 select-none">$</span>
                <span className="text-terminal-fg truncate flex-1">choco install cloudflared</span>
                <button onClick={() => copyToClipboard('choco install cloudflared')} className="p-1.5 hover:bg-white/10 rounded transition-colors text-muted-foreground">
                  <Copy size={12} />
                </button>
              </div>
            </div>
          </div>

          {/* macOS */}
          <div className="space-y-2 pt-2">
            <h4 className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider px-1">macOS</h4>
            <div className="flex items-center gap-2 bg-terminal-bg rounded border border-white/5 p-2 pr-1 font-mono text-xs text-terminal-fg">
              <span className="text-muted-foreground shrink-0 select-none">$</span>
              <span className="text-terminal-fg truncate flex-1">brew install cloudflared</span>
              <button onClick={() => copyToClipboard('brew install cloudflared')} className="p-1.5 hover:bg-white/10 rounded transition-colors text-muted-foreground">
                <Copy size={12} />
              </button>
            </div>
          </div>
        </div>
      )
    },
    {
      title: "Verify & Authenticate",
      description: "Check if it's working and decide if you need to login.",
      content: (
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider px-1">1. Verify Version</h4>
            <div className="bg-terminal-bg rounded border border-white/5 p-3 font-mono text-xs text-terminal-fg opacity-80">
              $ cloudflared --version
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider px-1">2. Authentication (Optional)</h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              If you want to use a <strong>Named Tunnel</strong> with your own domain, you must run:
            </p>
            <div className="flex items-center gap-2 bg-terminal-bg rounded border border-white/5 p-2 pr-1 font-mono text-xs text-terminal-fg">
               <span className="text-muted-foreground shrink-0 select-none">$</span>
               <span className="text-terminal-fg truncate flex-1">cloudflared tunnel login</span>
               <button onClick={() => copyToClipboard('cloudflared tunnel login')} className="p-1.5 hover:bg-white/10 rounded transition-colors text-muted-foreground">
                <Copy size={12} />
              </button>
            </div>
            <p className="text-[10px] text-amber-500 italic bg-amber-500/5 p-2 rounded">
              * Not required for "Quick Tunnels" (random URLs).
            </p>
          </div>
        </div>
      )
    }
  ]

  const activeStep = steps[step - 1]

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Cloudflare Tunnel Setup
          </DialogTitle>
          <DialogDescription>
            Expose local apps to the internet securely.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
           <div className="flex items-center gap-2 mb-6 px-1">
              {[1, 2].map((i) => (
                <div key={i} className="flex-1 flex items-center gap-2">
                  <div className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors shrink-0",
                    step === i ? "bg-primary border-primary text-primary-foreground" : 
                    step > i ? "bg-green-500 border-green-500 text-white" : "border-muted-foreground/30 text-muted-foreground"
                  )}>
                    {step > i ? <CheckCircle2 size={12} /> : i}
                  </div>
                  {i < 2 && <div className={cn("h-px flex-1 rounded-full", step > i ? "bg-green-500" : "bg-border")} />}
                </div>
              ))}
           </div>

           <div className="min-h-[260px]">
              <h3 className="font-semibold text-base mb-1">{activeStep.title}</h3>
              <p className="text-[13px] text-muted-foreground mb-4">{activeStep.description}</p>
              {activeStep.content}
           </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 border-t pt-4">
          {step > 1 && (
            <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>Back</Button>
          )}
          {step < 2 ? (
            <Button size="sm" onClick={() => setStep(step + 1)}>Next: Verify</Button>
          ) : (
            <Button size="sm" onClick={onClose}>Finish Setup</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
