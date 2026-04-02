import { useEffect, useRef } from 'react';
import { Trash2, Terminal } from 'lucide-react';
import { LogEntry } from '@/lib/pipeline';

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

export function LogPanel({ logs, onClear }: LogPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="h-64 border-t border-border bg-card flex flex-col shrink-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Logs</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{logs.length}</span>
        </div>
        <button
          onClick={onClear}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Trash2 className="h-3 w-3" />
          Clear
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 font-mono-log text-xs space-y-0.5">
        {logs.length === 0 ? (
          <div className="text-muted-foreground text-center mt-8">No logs yet. Run the pipeline to see output.</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="flex gap-3 animate-fade-in-up leading-relaxed">
              <span className="text-muted-foreground shrink-0">
                {log.timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="text-primary shrink-0 w-40 truncate">[{log.stepName}]</span>
              <span className="text-foreground/80">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
