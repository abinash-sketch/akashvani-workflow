import { Check, X, Loader2, Circle, Hand } from 'lucide-react';
import { PipelineStep, formatTime } from '@/lib/pipeline';

interface StepSidebarProps {
  steps: PipelineStep[];
  activeStepIndex: number;
  onSelectStep: (index: number) => void;
}

function StatusIcon({ status, type }: { status: PipelineStep['status']; type: PipelineStep['type'] }) {
  switch (status) {
    case 'completed':
      return (
        <div className="h-6 w-6 rounded-full bg-success/20 flex items-center justify-center animate-pop-in">
          <Check className="h-3.5 w-3.5 text-success" />
        </div>
      );
    case 'running':
      return (
        <div className="h-6 w-6 rounded-full bg-running/20 flex items-center justify-center animate-pulse-ring">
          {type === 'manual' ? (
            <Hand className="h-3.5 w-3.5 text-warning" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 text-running animate-spin-slow" />
          )}
        </div>
      );
    case 'error':
      return (
        <div className="h-6 w-6 rounded-full bg-destructive/20 flex items-center justify-center">
          <X className="h-3.5 w-3.5 text-destructive" />
        </div>
      );
    default:
      return (
        <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
          <Circle className="h-3 w-3 text-idle" />
        </div>
      );
  }
}

export function StepSidebar({ steps, activeStepIndex, onSelectStep }: StepSidebarProps) {
  return (
    <aside className="w-72 border-r border-border bg-sidebar shrink-0 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pipeline Steps</h2>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {steps.map((step, i) => {
          const isActive = i === activeStepIndex;
          return (
            <button
              key={step.id}
              onClick={() => onSelectStep(i)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all duration-200 group relative ${
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
              } ${step.status === 'completed' ? 'animate-flash-green' : ''}`}
            >
              {isActive && (
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />
              )}
              <div className="relative">
                <StatusIcon status={step.status} type={step.type} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{step.name}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  {step.status === 'running' ? (
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${step.type === 'manual' ? 'text-warning' : 'text-primary'}`}>
                      {step.type === 'manual' ? 'Awaiting Action' : 'Processing...'}
                    </span>
                  ) : step.status === 'completed' ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-success">
                      Done
                    </span>
                  ) : step.status === 'error' ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
                      Error
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {step.type === 'manual' ? 'Manual' : 'Auto'}
                    </span>
                  )}
                  {(step.status === 'completed' || step.status === 'running') && (
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {formatTime(step.elapsedMs)}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">{i + 1}/{steps.length}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
