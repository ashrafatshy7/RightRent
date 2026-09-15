import { API_BASE_URL, API_PATHS } from "../config/app";
import type {
  Analysis,
  AuthResponse,
  LawApproval,
  LawSourceState,
  PublicUser,
  Readiness,
  TenantPreferences,
  UploadedContract,
} from "../types/api";

type ApiErrorBody = { error?: { code?: string; message?: string } };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function messageForError(error: unknown, fallback = "משהו השתבש. נסו שוב.") {
  return error instanceof Error ? error.message : fallback;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  acceptedStatuses: readonly number[] = [],
): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    throw new ApiError(
      response.status,
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "הבקשה נכשלה. נסו שוב.",
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const PROGRESS_STREAM_TYPE = "application/x-ndjson";
const LOG_PREFIX = "%c[RightRent analysis]";
const LOG_PREFIX_STYLE = "color:#0f766e;font-weight:600";

type AnalysisStreamEvent =
  | { type: "log"; level: "info" | "warn" | "error"; elapsedMs: number; message: string }
  | { type: "result"; status: number; analysis: Analysis }
  | { type: "error"; status: number; error: { code?: string; message?: string } };

function logAnalysisEvent(event: Extract<AnalysisStreamEvent, { type: "log" }>) {
  const write = event.level === "error" ? console.error : event.level === "warn" ? console.warn : console.log;
  write(`${LOG_PREFIX} +${(event.elapsedMs / 1_000).toFixed(1)}s%c ${event.message}`, LOG_PREFIX_STYLE, "");
}

// Runs the analysis while printing the server's progress events to the browser console (F12).
async function analyzeWithConsoleProgress(token: string, contractId: string, preferences?: TenantPreferences) {
  console.log(`${LOG_PREFIX}%c Requesting analysis of contract ${contractId}...`, LOG_PREFIX_STYLE, "");
  const response = await fetch(`${API_BASE_URL}${API_PATHS.analyzeContract(contractId)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: PROGRESS_STREAM_TYPE,
    },
    body: JSON.stringify({ confirmPreferences: true, ...(preferences ? { preferences } : {}) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    console.error(`${LOG_PREFIX}%c Request rejected with HTTP ${response.status}`, LOG_PREFIX_STYLE, "", body.error ?? {});
    throw new ApiError(
      response.status,
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "הבקשה נכשלה. נסו שוב.",
    );
  }
  if (!response.body || !response.headers.get("content-type")?.includes(PROGRESS_STREAM_TYPE)) {
    return response.json() as Promise<{ analysis: Analysis }>;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split("\n");
    buffered = done ? "" : lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as AnalysisStreamEvent;
      if (event.type === "log") {
        logAnalysisEvent(event);
      } else if (event.type === "result") {
        console.log(`${LOG_PREFIX}%c Analysis ready - full result:`, LOG_PREFIX_STYLE, "", event.analysis);
        return { analysis: event.analysis };
      } else {
        console.error(`${LOG_PREFIX}%c Analysis failed with HTTP ${event.status}`, LOG_PREFIX_STYLE, "", event.error);
        throw new ApiError(
          event.status,
          event.error.code ?? "REQUEST_FAILED",
          event.error.message ?? "הבקשה נכשלה. נסו שוב.",
        );
      }
    }
    if (done) break;
  }
  console.error(`${LOG_PREFIX}%c The progress stream ended without a result.`, LOG_PREFIX_STYLE, "");
  throw new ApiError(502, "ANALYSIS_STREAM_ENDED", "הניתוח נקטע לפני שהסתיים. נסו שוב.");
}

export const api = Object.freeze({
  register: (email: string, password: string) => request<AuthResponse>(API_PATHS.register, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }),
  login: (email: string, password: string) => request<AuthResponse>(API_PATHS.login, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }),
  me: (token: string) => request<{ user: PublicUser }>(API_PATHS.me, {}, token),
  getPreferences: (token: string) => request<{ preferences: TenantPreferences }>(API_PATHS.preferences, {}, token),
  updatePreferences: (token: string, preferences: TenantPreferences) => request<{ preferences: TenantPreferences }>(
    API_PATHS.preferences,
    { method: "PUT", body: JSON.stringify(preferences) },
    token,
  ),
  uploadContract: (token: string, file: File) => {
    const body = new FormData();
    body.append("contract", file);
    return request<{ contract: UploadedContract }>(API_PATHS.uploadContract, { method: "POST", body }, token);
  },
  analyzeContract: analyzeWithConsoleProgress,
  getAnalysis: (token: string, analysisId: string) => request<{ analysis: Analysis }>(API_PATHS.analysis(analysisId), {}, token),
  getHistory: (token: string) => request<{ analyses: Analysis[] }>(API_PATHS.history, {}, token),
  deleteHistory: (token: string, analysisId: string) => request<void>(API_PATHS.historyItem(analysisId), { method: "DELETE" }, token),
  getReadiness: () => request<Readiness>(API_PATHS.readiness, {}, undefined, [503]),
  getLawStatus: (token: string) => request<{ laws: LawSourceState[] }>(API_PATHS.adminLawStatus, {}, token),
  syncLaws: (token: string) => request<{ checks: Array<{ israelLawId: number; status: string; error: string | null }> }>(
    API_PATHS.adminLawSync,
    { method: "POST" },
    token,
  ),
  approveLaw: (token: string, israelLawId: number, approval: LawApproval) => request<{ law: LawSourceState }>(
    API_PATHS.approveLaw(israelLawId),
    { method: "POST", body: JSON.stringify(approval) },
    token,
  ),
  markedPdfUrl: (analysisId: string) => `${API_BASE_URL}${API_PATHS.markedPdf(analysisId)}`,
  getMarkedPdf: async (token: string, analysisId: string) => {
    const response = await fetch(`${API_BASE_URL}${API_PATHS.markedPdf(analysisId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new ApiError(response.status, "MARKED_PDF_FAILED", "לא ניתן לפתוח את הקובץ המסומן.");
    return response.blob();
  },
});
