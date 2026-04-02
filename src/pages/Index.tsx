import { useReducer, useCallback, useEffect, useRef } from 'react';
import { pipelineReducer, createInitialState, FAKE_LOG_MESSAGES } from '@/lib/pipeline';
import { TopBar } from '@/components/TopBar';
import { StepSidebar } from '@/components/StepSidebar';
import { StepDetail } from '@/components/StepDetail';
import { LogPanel } from '@/components/LogPanel';
import { SummaryPanel } from '@/components/SummaryPanel';

export default function Index() {
  const [state, dispatch] = useReducer(pipelineReducer, undefined, createInitialState);
  const automationRef = useRef<number | null>(null);
  const globalTimerRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const stepStartRef = useRef<number>(0);
  const globalStartRef = useRef<number>(0);

  const addLog = useCallback((stepName: string, message: string) => {
    dispatch({ type: 'ADD_LOG', entry: { timestamp: new Date(), stepName, message } });
  }, []);

  // Global timer
  useEffect(() => {
    if (state.pipelineRunning && state.pipelineStartTime) {
      globalStartRef.current = state.pipelineStartTime;
      globalTimerRef.current = window.setInterval(() => {
        dispatch({ type: 'UPDATE_GLOBAL_ELAPSED', elapsed: Date.now() - globalStartRef.current });
      }, 100);
    }
    return () => { if (globalTimerRef.current) clearInterval(globalTimerRef.current); };
  }, [state.pipelineRunning, state.pipelineStartTime]);

  // Per-step timer
  useEffect(() => {
    const idx = state.activeStepIndex;
    if (idx >= 0 && state.steps[idx]?.status === 'running') {
      stepStartRef.current = Date.now();
      stepTimerRef.current = window.setInterval(() => {
        dispatch({ type: 'UPDATE_STEP_ELAPSED', index: idx, elapsed: Date.now() - stepStartRef.current });
      }, 100);
    }
    return () => { if (stepTimerRef.current) clearInterval(stepTimerRef.current); };
  }, [state.activeStepIndex, state.steps[state.activeStepIndex]?.status]);

  const activateStep = useCallback((index: number) => {
    dispatch({ type: 'ACTIVATE_STEP', index });
  }, []);

  // Run automated step simulation
  useEffect(() => {
    const idx = state.activeStepIndex;
    if (idx < 0) return;
    const step = state.steps[idx];
    if (!step || step.type !== 'automated' || step.status !== 'running') return;
    if (!step.simulationDuration) return;

    const duration = step.simulationDuration;
    const messages = FAKE_LOG_MESSAGES[step.id] || ['Processing...', 'Working...', 'Done.'];
    const msgInterval = duration / (messages.length + 1);
    let msgIndex = 0;

    // Progress ticker
    const startTime = Date.now();
    const progressInterval = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min((elapsed / duration) * 100, 99);
      dispatch({ type: 'UPDATE_STEP_PROGRESS', index: idx, progress });
    }, 100);

    // Log messages
    const logTimer = window.setInterval(() => {
      if (msgIndex < messages.length) {
        addLog(step.name, messages[msgIndex]);
        msgIndex++;
      }
    }, msgInterval);

    // Completion
    automationRef.current = window.setTimeout(() => {
      clearInterval(progressInterval);
      clearInterval(logTimer);
      addLog(step.name, 'Done.');
      dispatch({ type: 'COMPLETE_STEP', index: idx });
      // Advance
      if (idx + 1 < state.steps.length) {
        setTimeout(() => activateStep(idx + 1), 400);
      } else {
        dispatch({ type: 'PIPELINE_COMPLETE' });
      }
    }, duration);

    return () => {
      clearInterval(progressInterval);
      clearInterval(logTimer);
      if (automationRef.current) clearTimeout(automationRef.current);
    };
  }, [state.activeStepIndex, state.steps, addLog, activateStep]);

  // Manual step: log waiting
  useEffect(() => {
    const idx = state.activeStepIndex;
    if (idx < 0) return;
    const step = state.steps[idx];
    if (!step || step.type !== 'manual' || step.status !== 'running') return;
    addLog(step.name, 'Waiting for human action...');
  }, [state.activeStepIndex, state.steps[state.activeStepIndex]?.status, addLog]);

  const handleRun = useCallback(() => {
    dispatch({ type: 'START_PIPELINE' });
    addLog('Pipeline', 'Pipeline started');
    setTimeout(() => activateStep(0), 200);
  }, [addLog, activateStep]);

  const handleMarkDone = useCallback(() => {
    const idx = state.activeStepIndex;
    if (idx < 0) return;
    addLog(state.steps[idx].name, 'Marked as complete by user');
    dispatch({ type: 'COMPLETE_STEP', index: idx });
    if (idx + 1 < state.steps.length) {
      setTimeout(() => activateStep(idx + 1), 400);
    } else {
      dispatch({ type: 'PIPELINE_COMPLETE' });
    }
  }, [state.activeStepIndex, state.steps, addLog, activateStep]);

  const handleReset = useCallback(() => {
    if (automationRef.current) clearTimeout(automationRef.current);
    dispatch({ type: 'RESET' });
  }, []);

  const activeStep = state.activeStepIndex >= 0 ? state.steps[state.activeStepIndex] : null;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar
        pipelineRunning={state.pipelineRunning}
        completed={state.completed}
        elapsedMs={state.pipelineElapsedMs}
        onRun={handleRun}
        onReset={handleReset}
      />
      <div className="flex flex-1 overflow-hidden">
        <StepSidebar
          steps={state.steps}
          activeStepIndex={state.activeStepIndex}
          onSelectStep={() => {}}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          {state.completed ? (
            <SummaryPanel
              steps={state.steps}
              totalElapsedMs={state.pipelineElapsedMs}
              onReset={handleReset}
            />
          ) : (
            <StepDetail
              step={activeStep}
              stepIndex={state.activeStepIndex}
              totalSteps={state.steps.length}
              onMarkDone={handleMarkDone}
            />
          )}
          <LogPanel logs={state.logs} onClear={() => dispatch({ type: 'CLEAR_LOGS' })} />
        </div>
      </div>
    </div>
  );
}
