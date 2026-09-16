export type UserRole = "TENANT" | "ADMIN";

export type TenantPreferences = {
  maxMonthlyRentIls: number;
  repairUrgencyHours: 24 | 48 | 72 | 168;
  leaseLengthMonths: number;
  maxAnnualRentIncreasePercent: number;
  petsRequired: boolean;
  furnishedRequired: boolean;
  acceptsGuarantorRequirement: boolean;
};

export type PublicUser = {
  id: string;
  email: string;
  role: UserRole;
  preferences: TenantPreferences;
  createdAt: string;
};

export type AuthResponse = { token: string; user: PublicUser };

export type UploadedContract = {
  id: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  status: "EXTRACTED";
  isScanned: boolean;
  scannedPages: number[];
  pageCount: number;
  clauseCount: number;
  extractionMs: number;
  uploadedAt: string;
};

export type Severity = "RED" | "ORANGE" | "OK";
export type ProtectionStatus = "COVERED" | "PARTIAL" | "MISSING";

// Internal reason bucket behind a severity - RED/ORANGE/OK stay the only tenant-facing labels.
export type FindingCategory = "legal_compliance" | "contractual_risk" | "tenant_preference" | "informational";
export type ConfidenceLevel = "high" | "medium" | "low";
export type FindingTopic =
  | "rent_and_term"
  | "guarantee_security"
  | "entry_privacy"
  | "repairs_maintenance"
  | "charges_payments"
  | "termination_renewal"
  | "waiver_liability"
  | "pets_and_use"
  | "handover_condition"
  | "other";

export type DeterministicCheck = {
  ruleId: string;
  label: string;
  legalReferenceId: string;
  contractValue: number;
  legalLimit: number;
  calculatedLimit: number;
  difference: number;
  unit: "ILS" | "days";
  passesRule: boolean;
};

export type LegalReference = {
  lawReferenceId: string;
  lawName: string;
  section: string | null;
  sourceUrl: string;
  revisionId: number | null;
  excerpt: string | null;
  sourceAsOf: string | null;
};

export type ClauseLocation = { page: number; bbox: [number, number, number, number] };

export type Finding = {
  clauseId: string;
  severity: Severity;
  category: FindingCategory;
  topic: FindingTopic;
  confidence: ConfidenceLevel;
  title: string;
  clauseQuote: string;
  plainLanguageExplanation: string;
  whyItMatters: string;
  recommendedAction?: string;
  suggestedReplacementText?: string;
  explanation: string;
  legalAssessment: {
    violatesLaw: boolean;
    riskWarning: boolean;
    preferenceConflict: boolean;
  };
  legalReferences: LegalReference[];
  deterministicChecks?: DeterministicCheck[];
  relatedFindingIds: string[];
  locations: ClauseLocation[];
};

export type Protection = {
  protectionId: string;
  title: string;
  status: ProtectionStatus;
  explanation: string;
  relevantClauseIds: string[];
  legalReferences: LegalReference[];
  suggestedText?: string;
};

export type Analysis = {
  schemaVersion: "1.1.0";
  analysisId: string;
  contractId: string;
  status: "COMPLETED";
  createdAt: string;
  summary: { critical: number; warnings: number; compliant: number };
  headline: string;
  keyFindingIds: string[];
  findings: Finding[];
  protectionReport: Protection[];
  missingProtections: Protection[];
  suggestedAdditions: Protection[];
  preferencesSnapshot: TenantPreferences;
  privacy: {
    redactionCompleted: boolean;
    redactedEntityCount: number;
    mode: "REGEX_TEST_ONLY" | "REGEX_AND_DICTABERT";
    model: string | null;
  };
  disclaimer: { notLegalAdvice: true; humanReviewRecommended: true };
  markedPdf: { storageKey: string } | null;
  timingMs: {
    extraction: number;
    redaction: number;
    retrievalAndAnalysis: number;
    pdfGeneration: number;
    total: number;
    target: number;
    targetMet: boolean;
  };
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
  observedRevisionId: number;
  observedRevisionTimestamp: string;
  observedContentHash: string;
  observedSectionCount: number;
  observedSectionsHash: string;
  observedSectionKeys: string[];
  activeRevisionId: number | null;
  activeSourceAsOf: string | null;
  activeContentHash: string | null;
  activeSectionCount: number | null;
  activeSectionsHash: string | null;
  activeSectionKeys: string[];
  candidateRevisionId: number | null;
  candidateSourceAsOf: string | null;
  candidateContentHash: string | null;
  candidateSectionCount: number | null;
  candidateSectionsHash: string | null;
  candidateSectionKeys: string[];
  checkedAt: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationReference: string | null;
  error: string | null;
};

export type Readiness = {
  status: "ready" | "not_ready";
  database: boolean;
  analysisProvider: "deterministic" | "anthropic";
  activeLaws?: string;
  activeEmbeddingCount?: number;
  vectorSearch?: boolean;
  piiNer?: { ready: boolean; model: string };
  timestamp: string;
};

export type LawApproval = {
  revisionId: number;
  contentHash: string;
  sectionCount: number;
  sectionsHash: string;
  confirmedComplete: true;
  verifiedBy: string;
  verificationReference: string;
};
