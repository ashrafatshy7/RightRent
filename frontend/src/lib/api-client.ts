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
  analyzeContract: (token: string, contractId: string, preferences?: TenantPreferences) => request<{ analysis: Analysis }>(
    API_PATHS.analyzeContract(contractId),
    { method: "POST", body: JSON.stringify({ confirmPreferences: true, ...(preferences ? { preferences } : {}) }) },
    token,
  ),
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
