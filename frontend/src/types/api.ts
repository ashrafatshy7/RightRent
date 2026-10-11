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
  version: number;
  previousContractId: string | null;
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
  formula?: string;
  sourceClauseIds?: string[];
};

export type ClauseRelation =
  | "SAME_SECTION"
  | "REFERENCES"
  | "REFERENCED_BY"
  | "OVERRIDES"
  | "OVERRIDDEN_BY"
  | "DEFINES_VALUE"
  | "RELATED_TOPIC"
  | "SIMILAR_TEXT";

export type ContextClause = { clauseId: string; relation: ClauseRelation; reason: string; usedInAnalysis: boolean };

export type CrossClauseIssueKind = "CONFLICT" | "OVERRIDE" | "COMBINED_EFFECT";
export type CrossClauseIssue = { kind: CrossClauseIssueKind; clauseIds: string[]; explanation: string };

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
  sectionLabel?: string;
  heading?: string;
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
  contextClauses?: ContextClause[];
  crossClauseIssue?: CrossClauseIssue;
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

export type TermSource = { clauseId: string; quote: string; verified: boolean; origin: "RULE" | "MODEL"; conflict?: boolean };
export type SourcedNumber = TermSource & { value: number };
export type IndexationFrequency = "MONTHLY" | "ANNUAL" | "AT_RENEWAL" | "UNKNOWN";
export type ChargeKind = "ARNONA" | "WATER" | "ELECTRICITY" | "GAS" | "VAAD_BAYIT" | "BUILDING_INSURANCE" | "SPECIAL_BUILDING_EXPENSES" | "CONTENTS_INSURANCE" | "OTHER";
export type OneTimeCostKind = "BROKER_FEE" | "LEGAL_FEE" | "CLEANING" | "OTHER";
export type SecurityKind = "BANK_GUARANTEE" | "CASH_DEPOSIT" | "PROMISSORY_NOTE" | "GUARANTOR" | "OTHER";
export type EarlyExitKind = "UNTIL_REPLACEMENT" | "UNTIL_END" | "FIXED_MONTHS" | "FIXED_AMOUNT" | "ALLOWED_WITH_NOTICE" | "NOT_ALLOWED";

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
  unknowns: string[];
};

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

export type CostScenario = {
  annualInflationPercent: number;
  includeOption: boolean;
  exitAfterMonth: number | null;
  replacementAfterMonths: number;
  lateVacatingDays: number;
  latePaymentDays: number;
};

export type CostLine = { id: string; label: string; amount: number; formula: string; sourceClauseIds: string[] };
export type CostMonth = {
  month: number;
  period: string | null;
  phase: "TERM" | "OPTION" | "EXIT" | "LATE";
  baseRent: number;
  increase: number;
  indexation: number;
  charges: number;
  oneTime: number;
  penalties: number;
  total: number;
  cumulative: number;
};

export type CostSimulation = {
  ready: boolean;
  missing: Array<"monthlyRent" | "leaseTermMonths">;
  months: CostMonth[];
  totals: { rent: number; increases: number; indexation: number; charges: number; oneTime: number; penalties: number; total: number; averageMonthly: number };
  baselineTotal: number;
  security: { total: number; cashLocked: number; returnDays: number | null };
  budget: { maxMonthlyRentIls: number; peakMonthlyRent: number; firstMonthOverBudget: number | null };
  increase: { effectiveAnnualPercent: number; preferenceMax: number; exceedsPreference: boolean };
  lines: CostLine[];
  notes: string[];
  scenario: CostScenario;
};

export type CpiSnapshot = {
  source: "CBS" | "ASSUMPTION";
  latestPeriod: string | null;
  last12MonthsPercent: number;
  monthly: Array<{ period: string; percent: number }>;
  fetchedAt: string;
};

export type CostInputs = {
  monthlyRent: number | null;
  leaseTermMonths: number | null;
  indexation: { linked: boolean; frequency: "MONTHLY" | "ANNUAL" | "AT_RENEWAL"; floorAtBase: boolean; assumedFrequency: boolean };
  option: { months: number | null; rent: number | null; increasePercent: number | null };
  earlyExit: { kind: EarlyExitKind | null; months: number | null; amount: number | null; noticeDays: number | null; clauseId: string | null };
};

export type Analysis = {
  schemaVersion: string;
  analysisId: string;
  contractId: string;
  status: "COMPLETED";
  createdAt: string;
  summary: { critical: number; warnings: number; compliant: number };
  headline: string;
  keyFindingIds: string[];
  findings: Finding[];
  // Absent on analyses saved before clauses were linked.
  crossClauseIssues?: Array<CrossClauseIssue & { severity: Severity }>;
  clauseLinking?: boolean;
  protectionReport: Protection[];
  // Absent on analyses saved before the cost simulator.
  financialTerms?: FinancialTerms;
  financialOverrides?: FinancialOverrides;
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

// A history entry: the analysis with its contract's name and place in the version history.
export type ContractVersionInfo = {
  id: string;
  originalFileName: string;
  version: number;
  rootContractId: string;
  previousContractId: string | null;
};
export type HistoryAnalysis = Analysis & { contract: ContractVersionInfo | null };

export type ComparisonStatus = "NEW_ISSUE" | "WORSENED" | "UNREQUESTED_CHANGE" | "STILL_OPEN" | "IMPROVED" | "FIXED" | "UNCHANGED";
export type AlignmentChange = "UNCHANGED" | "MODIFIED" | "ADDED" | "REMOVED" | "SPLIT" | "MERGED";
export type ComparisonSide = { clauseIds: string[]; label: string; text: string; severity: Severity | null; title: string | null };
export type DiffPart = { op: "equal" | "insert" | "delete"; text: string };
export type ComparisonItem = {
  status: ComparisonStatus;
  change: AlignmentChange;
  moved: boolean;
  renumberedOnly: boolean;
  before: ComparisonSide | null;
  after: ComparisonSide | null;
  diff: DiffPart[] | null;
  numberChanges: Array<{ before: string; after: string }>;
};
export type VersionSummary = {
  analysisId: string;
  contractId: string;
  version: number;
  fileName: string;
  createdAt: string;
  summary: { critical: number; warnings: number; compliant: number };
};
export type ContractComparison = {
  base: VersionSummary;
  target: VersionSummary;
  headline: string;
  counts: Record<ComparisonStatus, number>;
  items: ComparisonItem[];
  protections: Array<{ protectionId: string; title: string; before: ProtectionStatus | null; after: ProtectionStatus | null }>;
  cost: { before: number | null; after: number | null };
  warnings: string[];
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
