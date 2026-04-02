export type StepStatus = 'idle' | 'running' | 'completed' | 'error';
export type StepType = 'automated' | 'manual';

export interface PipelineStep {
  id: string;
  name: string;
  type: StepType;
  status: StepStatus;
  description: string;
  elapsedMs: number;
  progress: number; // 0-100 for automated steps
  simulationDuration?: number; // ms, for automated
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  stepName: string;
  message: string;
}

export interface PipelineState {
  steps: PipelineStep[];
  logs: LogEntry[];
  activeStepIndex: number;
  pipelineRunning: boolean;
  pipelineStartTime: number | null;
  pipelineElapsedMs: number;
  completed: boolean;
}

export type PipelineAction =
  | { type: 'START_PIPELINE' }
  | { type: 'ACTIVATE_STEP'; index: number }
  | { type: 'UPDATE_STEP_PROGRESS'; index: number; progress: number }
  | { type: 'UPDATE_STEP_ELAPSED'; index: number; elapsed: number }
  | { type: 'COMPLETE_STEP'; index: number }
  | { type: 'ERROR_STEP'; index: number }
  | { type: 'ADD_LOG'; entry: Omit<LogEntry, 'id'> }
  | { type: 'CLEAR_LOGS' }
  | { type: 'UPDATE_GLOBAL_ELAPSED'; elapsed: number }
  | { type: 'PIPELINE_COMPLETE' }
  | { type: 'RESET' };

let logCounter = 0;

export const STEPS_CONFIG: Omit<PipelineStep, 'status' | 'elapsedMs' | 'progress' | 'simulationDuration'>[] = [
  { id: 'compress', name: 'Compress Episodes', type: 'automated', description: 'Compressing video episodes for optimal file size and quality.' },
  { id: 'copy', name: 'Copy to System', type: 'automated', description: 'Copying compressed files to the processing system.' },
  { id: 'upload-gdrive', name: 'Upload to Google Drive', type: 'automated', description: 'Uploading files to shared Google Drive folder.' },
  { id: 'word-to-srt', name: 'Convert Word file to SRT', type: 'automated', description: 'Converting Word document transcripts to SRT subtitle format.' },
  { id: 'review-pass1', name: 'Language Expert Review — Pass 1', type: 'manual', description: 'Review line breaks and timing using Feltiv\'s review functionality. Check for accuracy of transcription and proper segmentation.' },
  { id: 'align-srt', name: 'Align SRT in Premiere Pro', type: 'manual', description: 'Open Premiere Pro and align the SRT file with the video timeline. Verify sync accuracy across all segments.' },
  { id: 'review-pass2', name: 'Language Expert Review — Pass 2', type: 'manual', description: 'Second review pass: verify alignment corrections, check reading speed compliance, and validate formatting standards.' },
  { id: 'final-qc', name: 'Final SRT for QC', type: 'manual', description: 'Quality control check on the final SRT file. Verify all timestamps, character limits, and style guidelines are met.' },
  { id: 'review-pass3', name: 'Language Expert Review — Pass 3', type: 'manual', description: 'Final expert review: confirm all corrections from previous passes, sign off on subtitle quality.' },
  { id: 'sls', name: 'SLS', type: 'automated', description: 'Running Subtitle Language Service processing.' },
  { id: 'slc', name: 'SLC', type: 'automated', description: 'Running Subtitle Language Compliance checks.' },
  { id: 'roman-script', name: 'Roman Script Conversion', type: 'automated', description: 'Converting subtitles to Roman script transliteration.' },
];

export function createInitialState(): PipelineState {
  return {
    steps: STEPS_CONFIG.map(s => ({
      ...s,
      status: 'idle' as StepStatus,
      elapsedMs: 0,
      progress: 0,
    })),
    logs: [],
    activeStepIndex: -1,
    pipelineRunning: false,
    pipelineStartTime: null,
    pipelineElapsedMs: 0,
    completed: false,
  };
}

export function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case 'START_PIPELINE':
      return {
        ...state,
        pipelineRunning: true,
        pipelineStartTime: Date.now(),
        pipelineElapsedMs: 0,
        completed: false,
      };
    case 'ACTIVATE_STEP': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, status: 'running' as StepStatus, elapsedMs: 0, progress: 0, simulationDuration: s.type === 'automated' ? 3000 + Math.random() * 5000 : undefined } : s
      );
      return { ...state, steps, activeStepIndex: action.index };
    }
    case 'UPDATE_STEP_PROGRESS': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, progress: action.progress } : s
      );
      return { ...state, steps };
    }
    case 'UPDATE_STEP_ELAPSED': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, elapsedMs: action.elapsed } : s
      );
      return { ...state, steps };
    }
    case 'COMPLETE_STEP': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, status: 'completed' as StepStatus, progress: 100 } : s
      );
      return { ...state, steps };
    }
    case 'ERROR_STEP': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, status: 'error' as StepStatus } : s
      );
      return { ...state, steps };
    }
    case 'ADD_LOG':
      return { ...state, logs: [...state.logs, { ...action.entry, id: `log-${++logCounter}` }] };
    case 'CLEAR_LOGS':
      return { ...state, logs: [] };
    case 'UPDATE_GLOBAL_ELAPSED':
      return { ...state, pipelineElapsedMs: action.elapsed };
    case 'PIPELINE_COMPLETE':
      return { ...state, pipelineRunning: false, completed: true };
    case 'RESET':
      logCounter = 0;
      return createInitialState();
    default:
      return state;
  }
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const FAKE_LOG_MESSAGES: Record<string, string[]> = {
  'compress': ['Scanning input directory...', 'Found 12 episode files', 'Compressing batch_01.mp4...', 'Compressing batch_02.mp4...', 'Verifying output integrity...', 'Compression complete'],
  'copy': ['Initializing file transfer...', 'Copying compressed files to /system/intake/', 'Transferred 4.2 GB...', 'Verifying checksums...', 'Copy complete'],
  'upload-gdrive': ['Authenticating with Google Drive API...', 'Creating folder structure...', 'Uploading episode_01.mp4 (1.2 GB)...', 'Uploading episode_02.mp4 (980 MB)...', 'Upload verification passed', 'All files uploaded successfully'],
  'word-to-srt': ['Parsing Word document...', 'Extracting text blocks...', 'Converting timestamps to SRT format...', 'Validating subtitle timing...', 'Generated 847 subtitle entries', 'SRT conversion complete'],
  'sls': ['Initializing SLS engine...', 'Loading language models...', 'Processing subtitle segments...', 'Running linguistic analysis...', 'SLS processing complete'],
  'slc': ['Starting compliance checks...', 'Checking character limits...', 'Validating reading speed...', 'Verifying formatting rules...', 'All compliance checks passed'],
  'roman-script': ['Loading transliteration models...', 'Converting Devanagari to Roman script...', 'Processing 847 entries...', 'Validating transliteration accuracy...', 'Roman script conversion complete'],
};
