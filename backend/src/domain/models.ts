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
  extractionMs: number;
  clauses: ContractClause[];
  uploadedAt: string;
  updatedAt: string;
};

export type LegalAssessment = {
  violatesLaw: boolean;
  riskWarning: boolean;
  preferenceConflict: boolean;
};

export type LegalReference = {
  lawReferenceId: string;
  lawName: string;
  section: string | null;
  sourceUrl: string;
  revisionId: number | null;
  // A short excerpt of the retrieved statutory text and the date it was fetched as of, so a
  // tenant (or a reviewer) can see what was actually retrieved without following the link.
  excerpt: string | null;
  sourceAsOf: string | null;
};

// Internal reason bucket behind a severity, kept separate from Severity itself (RED/ORANGE/OK stay
// the only tenant-facing labels). Derived deterministically from legalAssessment, never from the LLM.
export type FindingCategory =
  | "legal_compliance"
  | "contractual_risk"
  | "tenant_preference"
  | "informational";

// How sure the analysis is about a finding. Never shown to the tenant as a raw label (section 24) -
// it only softens or firms up the generated wording.
export type ConfidenceLevel = "high" | "medium" | "low";

// A coarse subject tag used to cluster findings that are about the same underlying issue (e.g. a
// guarantee's amount, realization terms, and return deadline) so the UI does not present near-
// duplicate cards as unrelated problems.
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

// A legally defined numeric limit checked in code, never left to the model to compute (section 12).
// Present on a finding only when a matching deterministic rule applies to its clause.
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

export type Finding = {
  clauseId: string;
  severity: Severity;
  category: FindingCategory;
  topic: FindingTopic;
  confidence: ConfidenceLevel;
  title: string;
  // The exact contract text the finding is about, verbatim (verified server-side against the
  // clause; see resolveClauseQuote in analysis.service.ts).
  clauseQuote: string;
  // What this finding means for the tenant in plain Hebrew - the primary, first-visible content.
  plainLanguageExplanation: string;
  whyItMatters: string;
  recommendedAction?: string;
  suggestedReplacementText?: string;
  // The detailed legal reasoning, secondary/expandable in the UI (kept as `explanation` for
  // backward compatibility with existing consumers).
  explanation: string;
  legalAssessment: LegalAssessment;
  legalReferences: LegalReference[];
  deterministicChecks?: DeterministicCheck[];
  // Other finding IDs (clauseIds) that share this finding's topic, for "related issues" grouping.
  relatedFindingIds: string[];
  locations: ClauseLocation[];
};

export type Protection = {
  protectionId: string;
  title: string;
  status: "COVERED" | "PARTIAL" | "MISSING";
  explanation: string;
  relevantClauseIds: string[];
  legalReferences: LegalReference[];
  suggestedText?: string;
};

export type AnalysisResult = {
  schemaVersion: "1.1.0";
  analysisId: string;
  contractId: string;
  status: "COMPLETED";
  summary: { critical: number; warnings: number; compliant: number };
  // A plain-language, one-sentence summary of the overall risk, and up to five clauseIds (from
  // `findings`, most important first) so the UI can lead with what matters most (section 19-20).
  headline: string;
  keyFindingIds: string[];
  findings: Finding[];
  protectionReport: Protection[];
  missingProtections: Protection[];
  suggestedAdditions: Protection[];
  preferencesSnapshot: TenantPreferences;
  analysisInputHash: string;
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
  sourceAsOf: string;
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
  observedSectionCount: number;
  observedSectionsHash: string;
  observedSectionKeys: string[];
  activeOfficialFingerprint: string | null;
  activeRevisionId: number | null;
  activeSourceAsOf: string | null;
  activeContentHash: string | null;
  activeSectionCount: number | null;
  activeSectionsHash: string | null;
  activeSectionKeys: string[];
  candidateOfficialFingerprint: string | null;
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
  sectionsHash: string | null;
  checkedAt: string;
  expiresAt: Date;
  error: string | null;
};
