import { Check, Hand, Loader2, Clock } from 'lucide-react';
import { PipelineStep, formatTime } from '@/lib/pipeline';

interface StepDetailProps {
  step: PipelineStep | null;
  stepIndex: number;
  totalSteps: number;
  onMarkDone: () => void;
}

export function StepDetail({ step, stepIndex, totalSteps, onMarkDone }: StepDetailProps) {
  if (!step) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium">No step selected</p>
          <p className="text-sm mt-1">Click "Run Pipeline" to begin</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <span>Step {stepIndex + 1} of {totalSteps}</span>
          <span>•</span>
          <span className="uppercase tracking-wider">{step.type}</span>
        </div>

        <h2 className="text-2xl font-semibold text-foreground mb-4">{step.name}</h2>

        {/* Timer */}
        <div className="flex items-center gap-2 mb-6">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className={`font-mono text-lg ${step.status === 'running' ? 'text-primary' : 'text-foreground'}`}>
            {formatTime(step.elapsedMs)}
          </span>
          {step.status === 'running' && (
            <span className="text-xs text-muted-foreground animate-pulse">elapsed</span>
          )}
        </div>

        {/* Status card */}
        <div className={`rounded-lg border p-5 mb-6 ${
          step.status === 'running' && step.type === 'automated'
            ? 'border-running/30 bg-running/5'
            : step.status === 'running' && step.type === 'manual'
              ? 'border-warning/30 bg-warning/5'
              : step.status === 'completed'
                ? 'border-success/30 bg-success/5'
                : step.status === 'error'
                  ? 'border-destructive/30 bg-destructive/5'
                  : 'border-border bg-card'
        }`}>
          <p className="text-sm text-foreground/80 leading-relaxed">{step.description}</p>

          {/* Progress bar for automated steps */}
          {step.type === 'automated' && step.status === 'running' && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Processing...</span>
                <span>{Math.round(step.progress)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300 ease-linear"
                  style={{ width: `${step.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Automated running indicator */}
          {step.type === 'automated' && step.status === 'running' && (
            <div className="mt-4 flex items-center gap-2 text-sm text-running">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Automated step in progress...</span>
            </div>
          )}

          {/* Manual step action */}
          {step.type === 'manual' && step.status === 'running' && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-2 text-sm text-warning">
                <Hand className="h-4 w-4" />
                <span>Waiting for human action</span>
              </div>
              <button
                onClick={onMarkDone}
                className="flex items-center gap-2 px-5 py-2.5 rounded-md bg-success text-success-foreground hover:bg-success/90 transition-colors text-sm font-semibold"
              >
                <Check className="h-4 w-4" />
                Mark as Done
              </button>
            </div>
          )}

          {/* Completed */}
          {step.status === 'completed' && (
            <div className="mt-4 flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4" />
              <span>Completed in {formatTime(step.elapsedMs)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
