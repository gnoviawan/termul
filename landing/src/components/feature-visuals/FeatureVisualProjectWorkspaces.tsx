import { FeatureVisualFrameRoot, FeatureVisualFrameWindow } from './FeatureVisualFrame';

export function FeatureVisualProjectWorkspaces() {
  return (
    <FeatureVisualFrameRoot>
      <FeatureVisualFrameWindow size="md" className="flex min-h-[180px] overflow-hidden">
        <div className="w-28 shrink-0 bg-pitch-black border-r border-white/10 flex flex-col py-3">
          <div className="px-3 mb-2 text-[9px] text-gray-500 font-mono tracking-wider uppercase">
            Projects
          </div>
          <div className="px-2 flex flex-col gap-0.5">
            <div className="px-2 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/25 text-[10px] text-violet-300 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400"></span>
              termul
            </div>
            <div className="px-2 py-1.5 rounded-md text-[10px] text-gray-500 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-600"></span>
              server-api
            </div>
            <div className="px-2 py-1.5 rounded-md text-[10px] text-gray-500 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-600"></span>
              dotfiles
            </div>
          </div>
        </div>
        <div className="flex-1 flex flex-col bg-deep-slate">
          <div className="flex-1 p-4 font-mono text-[10px] text-gray-400 flex flex-col gap-1.5 justify-center">
            <div className="text-gray-500">~/Projects/termul</div>
            <div>
              <span className="text-green-400">➜</span> cargo tauri dev
            </div>
            <div className="text-violet-400/80">Compiling termul v0.1.0...</div>
          </div>
          <div className="h-6 border-t border-white/10 bg-deep-slate flex items-center px-3">
            <span className="text-[9px] text-gray-500 font-mono">
              Workspace: <span className="text-violet-400">termul</span>
            </span>
          </div>
        </div>
      </FeatureVisualFrameWindow>
    </FeatureVisualFrameRoot>
  );
}
