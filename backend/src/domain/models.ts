export type Severity = "RED" | "ORANGE" | "OK";

// The kinds of security a tenant can agree to give; "OTHER" is only ever read from a contract.
export const ACCEPTED_SECURITY_KINDS = ["BANK_GUARANTEE", "CASH_DEPOSIT", "PROMISSORY_NOTE", "GUARANTOR"] as const;
export type AcceptedSecurityKind = (typeof ACCEPTED_SECURITY_KINDS)[number];
export const ADDITIONAL_NOTES_MAX_LENGTH = 500;

export type TenantPreferences = {
  maxMonthlyRentIls: number;
  // The longest acceptable time to fix an urgent defect.
  repairUrgencyHours: 24 | 48 | 72 | 168;
  leaseLengthMonths: number;
  maxAnnualRentIncreasePercent: number;
  petsRequired: boolean;
  furnishedRequired: boolean;
  // The only kinds of security the tenant agrees to give.
  acceptedSecurityKinds: AcceptedSecurityKind[];
  // Rent plus the recurring charges the tenant pays (arnona, vaad bayit, ...); null when not set.
  maxMonthlyTotalCostIls: number | null;
  acceptsIndexation: boolean;
  earlyExitRequired: boolean;
  // Bringing in a roommate or subletting.
  roommatesRequired: boolean;
  renewalOptionRequired: boolean;
  // The least notice the landlord must give before entering; null when it does not matter.
  minEntryNoticeHours: 24 | 48 | null;
  acceptsBrokerFee: boolean;
  // Anything else the tenant cares about, in their own words; read only by Claude.
  additionalNotes: string;
};

export const defaultPreferences: TenantPreferences = {
  maxMonthlyRentIls: 7_000,
  repairUrgencyHours: 72,
  leaseLengthMonths: 12,
  maxAnnualRentIncreasePercent: 5,
  petsRequired: false,
  furnishedRequired: false,
  acceptedSecurityKinds: [...ACCEPTED_SECURITY_KINDS],
  maxMonthlyTotalCostIls: null,
  acceptsIndexation: true,
  earlyExitRequired: false,
  roommatesRequired: false,
  renewalOptionRequired: false,
  minEntryNoticeHours: null,
  acceptsBrokerFee: true,
  additionalNotes: "",
};

type StoredPreferences = Partial<TenantPreferences> & { acceptsGuarantorRequirement?: boolean };

// Preferences saved before a field existed lack it, and older ones say acceptsGuarantorRequirement
// instead of acceptedSecurityKinds. Every saved set is read through this, always in the same key
// order, so two equal sets also hash and compare equal (see analysisInputHash and compareVersions).
export function normalizePreferences(stored: StoredPreferences = {}): TenantPreferences {
  const { acceptsGuarantorRequirement, ...current } = stored;
  const merged: TenantPreferences = { ...defaultPreferences, ...current };
  const kinds = current.acceptedSecurityKinds
    ?? ACCEPTED_SECURITY_KINDS.filter((kind) => kind !== "GUARANTOR" || acceptsGuarantorRequirement !== false);
  const ordered = Object.fromEntries(
    (Object.keys(defaultPreferences) as Array<keyof TenantPreferences>).map((key) => [key, merged[key]]),
  ) as TenantPreferences;
  return { ...ordered, acceptedSecurityKinds: ACCEPTED_SECURITY_KINDS.filter((kind) => kinds.includes(kind)) };
}

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
  // The contract's own numbering ("9", "9.2") and short heading ("בטוחות"), when the clause starts
  // with a numbered heading. `id` stays positional; these exist so the tenant sees the contract's own
  // labels and so a "see section 9" reference can be resolved to a clause.
  sectionLabel?: string;
  heading?: string;
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
  // A revised contract (e.g. the landlord's answer to requested changes) points to the version it
  // replaces; all versions share the first one's ID as rootContractId. Absent on a first version.
  previousContractId?: string;
  rootContractId?: string;
  version?: number;
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
  // How the limit was computed, with the contract's own numbers ("min(6,000 × 12 ÷ 3, 3 × 6,000)"),
  // and the clauses those numbers came from (the rent and lease term are often defined elsewhere).
  formula?: string;
  sourceClauseIds?: string[];
};

// Why another clause was read together with this one (see clause-linking.service.ts).
export type ClauseRelation =
  | "SAME_SECTION"
  | "REFERENCES"
  | "REFERENCED_BY"
  | "OVERRIDES"
  | "OVERRIDDEN_BY"
  | "DEFINES_VALUE"
  | "RELATED_TOPIC"
  | "SIMILAR_TEXT";

export type ContextClause = {
  clauseId: string;
  relation: ClauseRelation;
  // A short Hebrew reason shown to the tenant ("מגדיר את דמי השכירות החודשיים").
  reason: string;
  // Whether the analysis actually relied on this clause (cited by the model, or the source of a
  // deterministic fact), as opposed to merely having been supplied as context.
  usedInAnalysis: boolean;
};

export type CrossClauseIssueKind = "CONFLICT" | "OVERRIDE" | "COMBINED_EFFECT";

// A problem that exists only in the combination of clauses: two clauses that contradict each other,
// one that cancels a protection given by another, or terms that are harmless alone but not together.
export type CrossClauseIssue = {
  kind: CrossClauseIssueKind;
  clauseIds: string[];
  explanation: string;
};

export type Finding = {
  clauseId: string;
  // The clause's own numbering and heading (see ContractClause), copied for display.
  sectionLabel?: string;
  heading?: string;
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
  // The other clauses this one was analyzed together with, and an issue that exists only in their
  // combination.
  contextClauses?: ContextClause[];
  crossClauseIssue?: CrossClauseIssue;
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

// Where a financial term was read from. A value is "verified" when its quote is verbatim contract
// text and contains the number itself; unverified values are shown for confirmation and are not
// counted until the tenant confirms them. `conflict` marks a value the model and the local rules
// read differently.
export type TermSource = {
  clauseId: string;
  quote: string;
  verified: boolean;
  origin: "RULE" | "MODEL";
  conflict?: boolean;
};

export type SourcedNumber = TermSource & { value: number };

export type IndexationFrequency = "MONTHLY" | "ANNUAL" | "AT_RENEWAL" | "UNKNOWN";
export type ChargeKind =
  | "ARNONA"
  | "WATER"
  | "ELECTRICITY"
  | "GAS"
  | "VAAD_BAYIT"
  | "BUILDING_INSURANCE"
  | "SPECIAL_BUILDING_EXPENSES"
  | "CONTENTS_INSURANCE"
  | "OTHER";
export type OneTimeCostKind = "BROKER_FEE" | "LEGAL_FEE" | "CLEANING" | "OTHER";
export type SecurityKind = "BANK_GUARANTEE" | "CASH_DEPOSIT" | "PROMISSORY_NOTE" | "GUARANTOR" | "OTHER";
export type EarlyExitKind =
  | "UNTIL_REPLACEMENT"
  | "UNTIL_END"
  | "FIXED_MONTHS"
  | "FIXED_AMOUNT"
  | "ALLOWED_WITH_NOTICE"
  | "NOT_ALLOWED";

// The money terms of a contract, read so the cost simulator can turn them into shekels. Values come
// from local rules and, with the Anthropic provider, from Claude; either way every number is checked
// against the clause it cites before it is trusted (see financial-terms.service.ts).
export type FinancialTerms = {
  monthlyRent: SourcedNumber | null;
  leaseTermMonths: SourcedNumber | null;
  leaseStart: (TermSource & { value: string }) | null;
  indexation: (TermSource & { index: "CPI" | "USD" | "OTHER"; frequency: IndexationFrequency; floorAtBase: boolean }) | null;
  annualIncreasePercent: SourcedNumber | null;
  option: { months: SourcedNumber | null; rent: SourcedNumber | null; increasePercent: SourcedNumber | null };
  charges: Array<TermSource & { kind: ChargeKind; payer: "TENANT" | "LANDLORD"; monthlyAmount: number | null }>;
  oneTimeCosts: Array<TermSource & { kind: OneTimeCostKind; amount: number | null; timing: "START" | "END" }>;
  securities: Array<TermSource & { kind: SecurityKind; amount: number | null; returnDays: number | null }>;
  lateVacating: (TermSource & { perDay: number | null; dailyRentMultiple: number | null }) | null;
  latePayment: (TermSource & { perDay: number | null; monthlyInterestPercent: number | null }) | null;
  earlyExit: (TermSource & { kind: EarlyExitKind; months: number | null; amount: number | null; noticeDays: number | null }) | null;
  // Plain Hebrew notes on what the contract leaves unstated ("לא צוין סכום הארנונה").
  unknowns: string[];
};

// The tenant's corrections and confirmations of financial terms, kept on the analysis. Setting a
// value confirms it; amounts the contract leaves out (arnona, vaad bayit) can be estimated here.
export type FinancialOverrides = {
  monthlyRent?: number;
  leaseTermMonths?: number;
  leaseStart?: string;
  indexationLinked?: boolean;
  indexationFrequency?: Exclude<IndexationFrequency, "UNKNOWN">;
  annualIncreasePercent?: number;
  optionMonths?: number;
  optionRent?: number;
  optionIncreasePercent?: number;
  securityAmount?: number;
  lateVacatingPerDay?: number;
  latePaymentPerDay?: number;
  earlyExitKind?: EarlyExitKind;
  earlyExitMonths?: number;
  earlyExitNoticeDays?: number;
  chargeAmounts?: Partial<Record<ChargeKind, number>>;
  oneTimeAmounts?: Partial<Record<OneTimeCostKind, number>>;
};

export type AnalysisResult = {
  schemaVersion: "1.5.0";
  analysisId: string;
  contractId: string;
  status: "COMPLETED";
  summary: { critical: number; warnings: number; compliant: number };
  // A plain-language, one-sentence summary of the overall risk, and up to five clauseIds (from
  // `findings`, most important first) so the UI can lead with what matters most (section 19-20).
  headline: string;
  keyFindingIds: string[];
  findings: Finding[];
  // Cross-clause issues reported on findings, merged so a conflict reported from both of its clauses
  // appears once, at the severity of its most severe finding.
  crossClauseIssues: Array<CrossClauseIssue & { severity: Severity }>;
  // Whether related clauses were supplied as context (CLAUSE_LINKING), recorded for evaluation runs.
  clauseLinking: boolean;
  protectionReport: Protection[];
  financialTerms: FinancialTerms;
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
  financialOverrides?: FinancialOverrides;
};

export type NegotiationState = "PRIORITIZE" | "STRATEGY" | "DRAFT" | "COUNTER" | "DONE";
export type NegotiationStrategy = "CITE_LAW" | "PROPOSE_ALTERNATIVE" | "CONCEDE";
// How the agent addresses the tenant and how the tenant speaks in the drafted message - Hebrew
// verbs and adjectives agree with it ("אני מבקש" / "אני מבקשת").
export type AddressForm = "MASCULINE" | "FEMININE" | "PLURAL";

// Something the tenant can raise with the landlord: a flagged clause, a protection the contract
// leaves out (both snapshotted from the analysis when the negotiation starts), or a request the
// tenant brought up themselves during the conversation.
export type NegotiationIssue = {
  issueId: string;
  kind: "CLAUSE" | "MISSING_PROTECTION" | "TENANT_REQUEST";
  severity: "RED" | "ORANGE" | "SUGGESTION" | "TENANT";
  title: string;
  summary: string;
  whyItMatters: string | null;
  // The clause's own numbering in the contract ("סעיף 7"), when it has one.
  contractSection: string | null;
  clauseQuote: string | null;
  suggestedText: string | null;
  // Values computed in code from the contract and the law (deterministic checks), stated in Hebrew.
  facts: string[];
  legalReferences: LegalReference[];
};

export type IssueStrategy = {
  kind: NegotiationStrategy;
  // The concrete ask, in Hebrew, as agreed with the tenant (null when the tenant concedes).
  request: string | null;
  // The least the tenant would still accept, when they named one.
  fallback: string | null;
};

export type NegotiationDraft = {
  text: string;
  // Which issues the message raises and which of their legal references it relies on.
  requests: Array<{ issueId: string; lawReferenceIds: string[] }>;
  editedByTenant: boolean;
  // Problems the deterministic checks found in a tenant's own edit (an agent draft has none).
  warnings: string[];
};

export type LikelyReply = {
  issueId: string | null;
  landlordReply: string;
  suggestedResponse: string;
};

export type NegotiationChatMessage = {
  id: string;
  role: "AGENT" | "TENANT";
  text: string;
  quickReplies: string[];
  createdAt: string;
};

export type NegotiationRecord = {
  id: string;
  userId: string;
  analysisId: string;
  // Records written before the conversational agent have no version and are started over.
  agentVersion: 2;
  state: NegotiationState;
  addressForm: AddressForm | null;
  issues: NegotiationIssue[];
  priorities: string[];
  strategies: Record<string, IssueStrategy>;
  draft: NegotiationDraft | null;
  likelyReplies: LikelyReply[];
  // What the tenant sees, unredacted.
  messages: NegotiationChatMessage[];
  // What the model sees: Anthropic message params with tenant text already redacted, kept so the
  // conversation continues with its tool calls and thinking blocks intact.
  modelMessages: unknown[];
  // Results owed for tool calls that ended the previous turn; sent first in the next user message.
  pendingToolResults: unknown[];
  tenantTurns: number;
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
  // The candidate changes the approved text with neither a new Knesset publication nor an
  // approved deferred amendment entering into force to account for it.
  candidateUnmatched: boolean;
  checkedAt: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationReference: string | null;
  error: string | null;
};

export type LawSyncStatus =
  | "UNCHANGED"
  | "CANDIDATE_STAGED"
  | "AUTO_APPROVED"
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
