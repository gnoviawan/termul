import { HugeiconsIcon } from '@hugeicons/react';
import { Tick01Icon } from '@hugeicons/core-free-icons';

export function FeatureVisualMultipleShells() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden pointer-events-none">
      <div className="relative w-[85%] max-w-sm bg-[#0a0a0a] rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
        <div className="p-2 border-b border-white/10 bg-[#161616]">
          <div className="bg-[#0a0a0a] border border-white/10 rounded p-2 flex items-center justify-between text-xs text-gray-300">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]"></span>{' '}
              PowerShell
            </span>
            <span className="text-[10px] text-gray-500">▼</span>
          </div>
        </div>
        <div className="p-2 bg-[#0d0d0d] flex flex-col gap-1 text-xs">
          <div className="px-3 py-2 rounded bg-blue-500/10 text-white flex items-center justify-between border border-blue-500/20">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400"></span> PowerShell
            </div>
            <HugeiconsIcon icon={Tick01Icon} className="w-3 h-3 text-blue-400" />
          </div>
          <div className="px-3 py-2 rounded text-gray-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-white opacity-50"></span> Command Prompt
          </div>
          <div className="px-3 py-2 rounded text-gray-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-orange-400 opacity-50"></span> Ubuntu (WSL)
          </div>
          <div className="px-3 py-2 rounded text-gray-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-yellow-400 opacity-50"></span> Git Bash
          </div>
        </div>
      </div>
    </div>
  );
}
