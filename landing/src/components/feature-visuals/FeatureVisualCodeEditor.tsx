import { FeatureVisualFrameRoot, FeatureVisualFrameWindow } from './FeatureVisualFrame';

export function FeatureVisualCodeEditor() {
  return (
    <FeatureVisualFrameRoot>
      <FeatureVisualFrameWindow size="md" className="flex min-h-[180px] flex-col overflow-hidden">
        <div className="h-8 bg-deep-slate border-b border-white/10 flex items-center px-3 gap-2">
          <div className="text-[10px] text-amber-400/90 font-mono">main.rs</div>
          <div className="text-[9px] text-gray-600">•</div>
          <div className="text-[10px] text-gray-500 font-mono">README.md</div>
          <div className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400/80" title="Unsaved"></div>
        </div>
        <div className="flex flex-1 min-h-[150px]">
          <div className="flex-1 bg-deep-slate p-3 font-mono text-[10px] flex flex-col gap-0.5 border-r border-white/5">
            <div>
              <span className="text-purple-400">use</span>{' '}
              <span className="text-gray-300">tauri::</span>
              <span className="text-amber-300">Manager</span>;
            </div>
            <div className="mt-1">
              <span className="text-purple-400">fn</span>{' '}
              <span className="text-blue-400">main</span>
              <span className="text-gray-400">()</span>{' '}
              <span className="text-gray-400">{'{'}</span>
            </div>
            <div className="pl-3">
              <span className="text-gray-500">// workspace entry</span>
            </div>
            <div className="pl-3">
              <span className="text-purple-400">tauri::Builder</span>
              <span className="text-gray-400">::</span>
              <span className="text-blue-400">default</span>
              <span className="text-gray-400">()</span>
            </div>
          </div>
          <div className="flex-1 bg-graphite p-3 text-[10px] flex flex-col gap-2">
            <div className="text-[9px] text-gray-500 font-mono uppercase tracking-wide">Preview</div>
            <div className="text-gray-300 font-medium"># Termul</div>
            <div className="text-gray-500 leading-relaxed">
              A workspace terminal with editor and browser tabs.
            </div>
            <div className="mt-1 p-2 rounded border border-white/10 bg-white/[0.02] text-[9px] text-gray-500 font-mono text-center">
              mermaid diagram
            </div>
          </div>
        </div>
      </FeatureVisualFrameWindow>
    </FeatureVisualFrameRoot>
  );
}
