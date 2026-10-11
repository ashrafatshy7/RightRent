export const APP = Object.freeze({
  name: "RightRent",
  hebrewName: "רייטרנט",
  tagline: "זכות לפני חתימה",
  sessionStorageKey: "rightrent.session.v1",
  maxPdfBytes: 10 * 1024 * 1024,
});

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
export const API_BASE_URL = configuredApiUrl?.replace(/\/$/u, "") ?? "";

export const ROUTES = Object.freeze({
  landing: "/",
  login: "/login",
  register: "/register",
  app: "/app",
  upload: "/app/upload",
  preferences: "/app/preferences",
  history: "/app/history",
  analysis: (analysisId: string) => `/app/analysis/${analysisId}`,
  compare: (baseAnalysisId: string, targetAnalysisId: string) => `/app/compare/${baseAnalysisId}/${targetAnalysisId}`,
  // Uploading a revised version of a contract analyzed in `fromAnalysisId`.
  uploadVersion: (previousContractId: string, fromAnalysisId: string) =>
    `/app/upload?previous=${encodeURIComponent(previousContractId)}&from=${encodeURIComponent(fromAnalysisId)}`,
  adminLaws: "/app/admin/laws",
});

export const API_PATHS = Object.freeze({
  register: "/api/auth/register",
  login: "/api/auth/login",
  me: "/api/auth/me",
  preferences: "/api/users/preferences",
  uploadContract: "/api/contracts/upload",
  analyzeContract: (contractId: string) => `/api/contracts/${contractId}/analyze`,
  contractFile: (contractId: string) => `/api/contracts/${contractId}/file`,
  analysis: (analysisId: string) => `/api/analyses/${analysisId}`,
  markedPdf: (analysisId: string) => `/api/analyses/${analysisId}/marked-pdf`,
  costSimulation: (analysisId: string) => `/api/analyses/${analysisId}/cost-simulation`,
  financialOverrides: (analysisId: string) => `/api/analyses/${analysisId}/financial-overrides`,
  history: "/api/history",
  comparison: (baseAnalysisId: string, targetAnalysisId: string) => `/api/comparisons/${baseAnalysisId}/${targetAnalysisId}`,
  historyItem: (analysisId: string) => `/api/history/${analysisId}`,
  readiness: "/api/health/ready",
  adminLawStatus: "/api/admin/laws/status",
  adminLawSync: "/api/admin/laws/sync",
  approveLaw: (israelLawId: number) => `/api/admin/laws/${israelLawId}/approve`,
});
