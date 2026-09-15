import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError } from "../../shared/http/http-error.js";

export type AnalysisProgressEvent = {
  type: "log";
  level: "info" | "warn" | "error";
  elapsedMs: number;
  message: string;
};

type AnalysisTrace = {
  started: number;
  emit: (event: AnalysisProgressEvent) => void;
};

const traces = new AsyncLocalStorage<AnalysisTrace>();

// Progress events for the request that asked for them, sent to that tenant's browser console.
// Events carry identifiers, counts, statuses, titles, and timings, never contract text.
// Outside a traced request every trace call is a no-op.
export function runWithAnalysisTrace<T>(
  emit: (event: AnalysisProgressEvent) => void,
  run: () => Promise<T>,
) {
  return traces.run({ started: performance.now(), emit }, run);
}

export function traceAnalysis(message: string, level: AnalysisProgressEvent["level"] = "info") {
  const trace = traces.getStore();
  if (!trace) return;
  trace.emit({
    type: "log",
    level,
    elapsedMs: Math.round(performance.now() - trace.started),
    message,
  });
}

export function traceAnalysisFailure(stage: string, error: unknown) {
  const reason = error instanceof HttpError
    ? `${error.code}: ${error.message}`
    : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  traceAnalysis(`Failed during ${stage} - ${reason}`, "error");
}
