export type Severity = "RED" | "ORANGE" | "OK";

export type TenantPreferences = {
  maxMonthlyRentIls: number;
  repairUrgencyHours: 24 | 48 | 72 | 168;
  leaseLengthMonths: number;
  maxAnnualRentIncreasePercent: number;
  petsRequired: boolean;
  furnishedRequired: boolean;
  acceptsGuarantorRequirement: boolean;
};

export const defaultPreferences: TenantPreferences = {
  maxMonthlyRentIls: 7_000,
  repairUrgencyHours: 72,
  leaseLengthMonths: 12,
  maxAnnualRentIncreasePercent: 5,
  petsRequired: false,
  furnishedRequired: false,
  acceptsGuarantorRequirement: true,
};

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  preferences: TenantPreferences;
  createdAt: string;
  updatedAt: string;
};

export type ClauseLocation = {
  page: number;
  bbox: [number, number, number, number];
};

export type ContractClause = {
  id: string;
  text: string;
  locations: ClauseLocation[];
};

export type ContractRecord = {
  id: string;
  userId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  status: "UPLOADED" | "EXTRACTED" | "ANALYZED" | "FAILED";
  isScanned: boolean;
  clauses: ContractClause[];
  uploadedAt: string;
  updatedAt: string;
};

export type LegalAssessment = {
  violatesLaw: boolean;
  riskWarning: boolean;
  preferenceConflict: boolean;
};

export type Finding = {
  clauseId: string;
  severity: Severity;
  title: string;
  explanation: string;
  legalAssessment: LegalAssessment;
  legalReferences: Array<{ lawReferenceId: string; section: string | null }>;
  locations: ClauseLocation[];
};

export type Protection = {
  protectionId: string;
  status: "MISSING" | "PARTIAL";
  explanation: string;
  suggestedText?: string;
};

export type AnalysisResult = {
  schemaVersion: "1.0.0";
  analysisId: string;
  contractId: string;
  status: "COMPLETED";
  summary: { critical: number; warnings: number; compliant: number };
  findings: Finding[];
  missingProtections: Protection[];
  suggestedAdditions: Protection[];
  privacy: { redactionCompleted: boolean; redactedEntityCount: number };
  markedPdf: { storageKey: string } | null;
  timingMs: {
    extraction: number;
    redaction: number;
    retrievalAndAnalysis: number;
    pdfGeneration: number;
    total: number;
  };
};

export type AnalysisRecord = AnalysisResult & {
  userId: string;
  createdAt: string;
};

export type NegotiationState = "PRIORITIZE" | "STRATEGY" | "DRAFT" | "COUNTER" | "DONE";
export type NegotiationStrategy = "CITE_LAW" | "PROPOSE_ALTERNATIVE" | "CONCEDE";

export type NegotiationRecord = {
  id: string;
  userId: string;
  analysisId: string;
  state: NegotiationState;
  priorities: string[];
  strategies: Record<string, NegotiationStrategy>;
  draft: string | null;
  likelyReplies: string[];
  createdAt: string;
  updatedAt: string;
};

export type LawChunk = {
  id: string;
  section: string | null;
  topic: string;
  kind: "statutory_rule" | "recommended_contract_protection";
  text: string;
  sourceUrl: string;
  contentHash: string;
  updatedAt: string;
  embedding?: number[];
};

export type LawSyncRecord = {
  id: string;
  sourceUrl: string;
  status: "COMPLETED" | "FAILED";
  sectionCount: number;
  contentHash: string;
  syncedAt: string;
  error?: string;
};
