import { HugeiconsIcon } from '@hugeicons/react';
import { Tick01Icon } from '@hugeicons/core-free-icons';
import { FeatureVisualFrameRoot, FeatureVisualFrameWindow } from './FeatureVisualFrame';

export function FeatureVisualMultipleShells() {
  return (
    <FeatureVisualFrameRoot>
      <FeatureVisualFrameWindow className="flex flex-col overflow-hidden">
        <div className="p-2 border-b border-white/10 bg-deep-slate">
          <div className="bg-graphite border border-white/10 rounded p-2 flex items-center justify-between text-xs text-gray-300">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]"></span>{' '}
              PowerShell
            </span>
            <span className="text-[10px] text-gray-500">▼</span>
          </div>
        </div>
        <div className="p-2 bg-deep-slate flex flex-col gap-1 text-xs">
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
      </FeatureVisualFrameWindow>
    </FeatureVisualFrameRoot>
  );
}
