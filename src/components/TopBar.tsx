import { Play, RotateCcw, Zap } from 'lucide-react';
import { formatTime } from '@/lib/pipeline';

interface TopBarProps {
  pipelineRunning: boolean;
  completed: boolean;
  elapsedMs: number;
  onRun: () => void;
  onReset: () => void;
}

export function TopBar({ pipelineRunning, completed, elapsedMs, onRun, onReset }: TopBarProps) {
  return (
    <header className="h-14 border-b border-border bg-card flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-3">
        <Zap className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold text-foreground tracking-tight">Akashvani Pipeline</h1>
      </div>

      <div className="flex items-center gap-6">
        <div className="font-mono text-sm text-muted-foreground">
          {pipelineRunning || completed ? (
            <span className={pipelineRunning ? 'text-primary' : 'text-success'}>
              {formatTime(elapsedMs)}
            </span>
          ) : (
            <span>00:00:00</span>
          )}
        </div>

        {completed ? (
          <button
            onClick={onReset}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors text-sm font-medium"
          >
            <RotateCcw className="h-4 w-4" />
            Run Again
          </button>
        ) : (
          <button
            onClick={onRun}
            disabled={pipelineRunning}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
          >
            <Play className="h-4 w-4" />
            Run Pipeline
          </button>
        )}
      </div>
    </header>
  );
}
