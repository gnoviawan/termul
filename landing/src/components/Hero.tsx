import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, GitBranchIcon, ConsoleIcon } from "@hugeicons/core-free-icons";
import { Button } from "./Button";
import { GITHUB_REPO_URL, LATEST_RELEASE_URL } from "../lib/links";

const Hero = () => {
  return (
    <section className="relative pt-40 pb-20 px-6 flex flex-col items-center justify-center text-center overflow-hidden">
      <video autoPlay loop muted playsInline className="absolute inset-0 w-full h-full object-cover z-0 opacity-100 pointer-events-none">
        <source src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260424_064411_9e9d7f84-9277-41f4-ab10-59172d89e6be.mp4" type="video/mp4" />
      </video>
      <div className="relative z-10 w-full flex flex-col items-center text-slate-950">
      <h1 className="text-5xl md:text-7xl font-medium tracking-tighter mb-6 max-w-4xl text-balance animate-in delay-100 drop-shadow-[0_2px_16px_rgba(255,255,255,0.55)]">
        A modern, project-aware<br />
        <span className="text-slate-600">terminal manager.</span>
      </h1>

      <p className="text-lg md:text-xl max-w-2xl mb-10 animate-in delay-200 text-gray-400">
        Termul treats workspaces as first-class citizens. Organize terminals by project with persistent sessions, snapshots, and a clean tabbed interface.
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-4 w-full max-w-md mb-20 animate-in delay-300">
        <Button 
          as="a" 
          href={LATEST_RELEASE_URL} 
          target="_blank" 
          rel="noreferrer" 
          size="lg" 
          className="w-full sm:w-auto"
        >
          Download for Free <HugeiconsIcon icon={ArrowRight01Icon} className="w-4 h-4" />
        </Button>
        <Button as="a" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" variant="outline" size="lg" className="w-full sm:w-auto">
          View on GitHub
        </Button>
      </div>
      
      <div className="relative w-full max-w-5xl mx-auto mt-10 rounded-2xl border border-white/10 overflow-hidden shadow-2xl shadow-white/5 animate-in delay-400">
        <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent z-10 pointer-events-none"></div>
        
        <div className="aspect-[16/9] bg-[#0a0a0a] flex flex-col text-left">
          <div className="h-12 bg-black border-b border-white/10 flex items-end px-2 gap-2">
            <div className="flex gap-1.5 px-3 pb-4">
              <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
              <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50"></div>
            </div>
            <div className="flex items-center h-[34px] gap-1">
               <div className="bg-[#161616] border border-b-0 border-white/10 rounded-t-lg px-4 h-full text-xs text-gray-300 flex items-center gap-2 min-w-[140px]">
                 <HugeiconsIcon icon={ConsoleIcon} className="w-3.5 h-3.5 text-blue-400" />
                 termul
               </div>
               <div className="px-4 h-full text-xs text-gray-500 flex items-center gap-2 hover:bg-white/5 rounded-t-lg cursor-pointer transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] min-w-[140px]">
                 <HugeiconsIcon icon={ConsoleIcon} className="w-3.5 h-3.5" />
                 server
               </div>
            </div>
          </div>
          <div className="flex-1 p-6 font-mono text-sm text-gray-300 flex flex-col gap-2 relative overflow-hidden bg-[#0d0d0d]">
            <div className="text-gray-500">gnoviawan@macbook termul %</div>
            <div><span className="text-green-400">npm</span> <span className="text-blue-400">run</span> tauri dev</div>
            <div className="mt-4 text-gray-400">
              <span className="text-blue-400 font-bold">Info</span> Watching D:\Projects\termul\src-tauri for changes...<br/>
              <span className="text-blue-400 font-bold">Info</span> Compiling termul v0.1.0 (D:\Projects\termul\src-tauri)<br/>
              <span className="text-green-400 font-bold">Finished</span> dev [unoptimized + debuginfo] target(s) in 2.45s<br/>
            </div>
            
            <div className="absolute bottom-0 right-0 w-64 h-64 bg-blue-500/10 blur-[100px] pointer-events-none"></div>
            <div className="absolute top-0 left-0 w-64 h-64 bg-purple-500/10 blur-[100px] pointer-events-none"></div>
          </div>
          <div className="h-7 bg-[#050505] border-t border-white/10 flex items-center justify-between px-4 text-[11px] text-gray-500 font-mono z-20">
            <div className="flex items-center gap-4">
              <span>project: termul</span>
              <span className="flex items-center gap-1.5 text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded"><HugeiconsIcon icon={GitBranchIcon} className="w-3 h-3" /> main</span>
            </div>
            <div>Tauri 2.0 • React 18</div>
          </div>
        </div>
        </div>
      </div>
    </section>
  );
};

export default Hero;