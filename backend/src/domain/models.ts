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
  israelLawId: number;
  lawName: string;
  section: string | null;
  kind: "statutory_rule";
  text: string;
  sourceUrl: string;
  contentHash: string;
  revisionId: number;
};

export type LawEmbeddingStatus = "CANDIDATE" | "ACTIVE" | "RETIRED";

export type LawEmbeddingRecord = {
  id: string;
  referenceId: string;
  israelLawId: number;
  lawName: string;
  section: string | null;
  sourceOrdinal: number;
  sourceUrl: string;
  wikisourceTitle: string;
  revisionId: number;
  revisionTimestamp: string;
  sourceAsOf: string;
  officialFingerprint: string;
  latestOfficialPublicationDate: string;
  contentHash: string;
  status: LawEmbeddingStatus;
  createdAt: string;
  embedding: number[];
};

export type LawSourceStatus =
  | "ACTIVE"
  | "AWAITING_VERIFICATION"
  | "OFFICIAL_UPDATE_PENDING"
  | "WIKISOURCE_CHANGED"
  | "FAILED";

export type LawSourceState = {
  israelLawId: number;
  lawName: string;
  knessetUrl: string;
  wikisourceTitle: string;
  wikisourceUrl: string;
  status: LawSourceStatus;
  latestOfficialPublicationDate: string;
  observedOfficialFingerprint: string;
  observedBindingIds: number[];
  observedAmendingLawIds: number[];
  observedRevisionId: number;
  observedRevisionTimestamp: string;
  observedContentHash: string;
  activeOfficialFingerprint: string | null;
  activeRevisionId: number | null;
  activeSourceAsOf: string | null;
  activeContentHash: string | null;
  candidateOfficialFingerprint: string | null;
  candidateRevisionId: number | null;
  candidateSourceAsOf: string | null;
  candidateContentHash: string | null;
  checkedAt: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationReference: string | null;
  error: string | null;
};

export type LawSyncStatus =
  | "UNCHANGED"
  | "CANDIDATE_STAGED"
  | "OFFICIAL_UPDATE_PENDING"
  | "WIKISOURCE_CHANGED"
  | "FAILED";

export type LawSyncRecord = {
  id: string;
  israelLawId: number;
  status: LawSyncStatus;
  sectionCount: number;
  officialFingerprint: string;
  wikisourceRevisionId: number | null;
  contentHash: string | null;
  checkedAt: string;
  error: string | null;
};
