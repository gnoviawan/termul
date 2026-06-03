import { AppleLogo, LinuxLogo, WindowsLogo } from '../OsBrandIcons';
import { FeatureVisualFrameRoot, FeatureVisualFrameWindow } from './FeatureVisualFrame';

export function FeatureVisualCrossPlatform() {
  return (
    <FeatureVisualFrameRoot>
      <FeatureVisualFrameWindow className="flex flex-col overflow-hidden">
        <div className="h-8 bg-gradient-to-r from-gray-800 to-gray-900 border-b border-white/10 flex items-center px-3 gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-green-500"></div>
        </div>
        <div className="p-5 font-mono text-xs text-gray-400 min-h-[140px] bg-[#0d0d0d] flex flex-col justify-center items-center gap-4">
          <div className="flex gap-3 w-full">
            <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-white/5 rounded-lg border border-white/5 shadow-inner text-gray-400">
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <AppleLogo className="h-full w-full" />
              </div>
              <span className="text-[10px]">macOS</span>
            </div>
            <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-blue-500/10 rounded-lg border border-blue-500/20 shadow-inner text-blue-400">
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <WindowsLogo className="h-full w-full" />
              </div>
              <span className="text-[10px]">Windows</span>
            </div>
            <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-white/5 rounded-lg border border-white/5 shadow-inner text-gray-400">
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <LinuxLogo className="h-full w-full" />
              </div>
              <span className="text-[10px]">Linux</span>
            </div>
          </div>
          <div className="text-[10px] text-gray-500 font-sans tracking-wide uppercase mt-2">
            Tauri 2.0 Engine
          </div>
        </div>
      </FeatureVisualFrameWindow>
    </FeatureVisualFrameRoot>
  );
}
