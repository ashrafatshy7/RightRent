import type {
  AnalysisRecord,
  DeterministicCheck,
  Finding,
  IssueStrategy,
  NegotiationDraft,
  NegotiationIssue,
  NegotiationRecord,
  Protection,
} from "../../domain/models.js";

// Deterministic checks behind the negotiation agent's precision guarantees: every law section the
// drafted message names must come from a legal reference of an issue it raises, and every number
// in it must already appear in the analysis, the law excerpts, or the tenant's own words. Nothing
// the model writes is trusted on these two points.

const SEVERITY_ORDER = { RED: 0, ORANGE: 1, SUGGESTION: 2, TENANT: 3 } as const;
const HEBREW = /[֐-׿]/u;

function formatAmount(value: number, unit: DeterministicCheck["unit"]) {
  const amount = value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return unit === "ILS" ? `${amount} ₪` : `${amount} ימים`;
}

function checkFact(check: DeterministicCheck) {
  const verdict = check.passesRule ? "עומד בדרישת החוק" : "חורג מהמותר בחוק";
  return `${check.label}: בחוזה ${formatAmount(check.contractValue, check.unit)}, `
    + `המקסימום לפי החוק ${formatAmount(check.calculatedLimit, check.unit)}`
    + `${check.formula ? ` (${check.formula})` : ""} - ${verdict}.`;
}

function flaggedBecause(finding: Finding) {
  return [
    finding.legalAssessment.violatesLaw ? "סותר את החוק" : null,
    finding.legalAssessment.riskWarning ? "סיכון חוזי לשוכר" : null,
    finding.legalAssessment.preferenceConflict ? "מתנגש עם ההעדפות של השוכר" : null,
    finding.crossClauseIssue ? `בעייתי בשילוב עם סעיפים אחרים: ${finding.crossClauseIssue.explanation}` : null,
  ].filter((reason): reason is string => reason !== null);
}

function findingIssue(finding: Finding, relevantPreferences: (finding: Finding) => string[]): NegotiationIssue {
  return {
    issueId: finding.clauseId,
    kind: "CLAUSE",
    severity: finding.severity === "RED" ? "RED" : "ORANGE",
    title: finding.title,
    summary: finding.plainLanguageExplanation,
    whyItMatters: finding.whyItMatters || null,
    contractSection: finding.sectionLabel ?? null,
    clauseQuote: finding.clauseQuote || null,
    suggestedText: finding.suggestedReplacementText ?? null,
    facts: (finding.deterministicChecks ?? []).map(checkFact),
    flaggedBecause: flaggedBecause(finding),
    explanation: finding.explanation || null,
    recommendedAction: finding.recommendedAction ?? null,
    relevantPreferences: relevantPreferences(finding),
    legalReferences: finding.legalReferences,
  };
}

function protectionIssue(protection: Protection): NegotiationIssue {
  return {
    issueId: `protection:${protection.protectionId}`,
    kind: "MISSING_PROTECTION",
    severity: "SUGGESTION",
    title: protection.title,
    summary: protection.explanation,
    whyItMatters: null,
    contractSection: null,
    clauseQuote: null,
    suggestedText: protection.suggestedText ?? null,
    facts: [],
    flaggedBecause: [protection.status === "MISSING" ? "הגנה שחסרה בחוזה" : "הגנה שהחוזה נותן רק בחלקה"],
    explanation: null,
    recommendedAction: null,
    relevantPreferences: [],
    legalReferences: protection.legalReferences,
  };
}

// `relevantPreferences` describes the tenant's preferences that bear on a finding (see
// negotiation-context.ts); the analysis alone knows none.
export function negotiationIssues(
  analysis: AnalysisRecord,
  relevantPreferences: (finding: Finding) => string[] = () => [],
): NegotiationIssue[] {
  const issues = [
    ...analysis.findings.filter((finding) => finding.severity !== "OK").map((finding) => findingIssue(finding, relevantPreferences)),
    ...analysis.missingProtections.filter((item) => item.status !== "COVERED").map(protectionIssue),
  ];
  return issues.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
}

// What the agent proposes first: the clauses the analysis flagged, most severe first. Missing
// protections are offered as optional additions, unless they are all there is.
export function defaultPriorities(issues: NegotiationIssue[]) {
  const flagged = issues.filter((issue) => issue.severity === "RED" || issue.severity === "ORANGE");
  return (flagged.length ? flagged : issues).map((issue) => issue.issueId);
}

export function issueById(record: Pick<NegotiationRecord, "issues">, issueId: string) {
  return record.issues.find((issue) => issue.issueId === issueId) ?? null;
}

// --- numbers ---------------------------------------------------------------------------------

// "1." / "2)" at the start of a line is list numbering, not a claim.
const LIST_MARKER = /^[ \t]*\d{1,2}[.)][ \t]+/gmu;
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/gu;

export function numbersIn(text: string): number[] {
  return [...text.replace(LIST_MARKER, "").matchAll(NUMBER)].map((match) => Number(match[0].replaceAll(",", "")));
}

function issueTexts(issue: NegotiationIssue) {
  return [
    issue.title,
    issue.summary,
    issue.whyItMatters,
    issue.contractSection,
    issue.clauseQuote,
    issue.suggestedText,
    issue.explanation,
    issue.recommendedAction,
    ...issue.facts,
    ...issue.flaggedBecause,
    ...issue.relevantPreferences,
    ...issue.legalReferences.flatMap((reference) => [reference.lawName, reference.section, reference.excerpt]),
  ].filter((text): text is string => Boolean(text));
}

// What numbers may be checked against. `context` is absent only in narrow unit tests.
type GroundingSource = Pick<NegotiationRecord, "issues" | "messages"> & Partial<Pick<NegotiationRecord, "context">>;

// Every number the agent may use: those in the analysis, the law excerpts, the contract and its
// terms, the tenant's preferences, and what the tenant said.
export function groundedNumbers(record: GroundingSource) {
  const texts = [
    ...record.issues.flatMap(issueTexts),
    ...(record.context?.preferences ?? []),
    ...(record.context?.contractTerms ?? []),
    ...(record.context?.clauses ?? []).flatMap((clause) => [clause.header ?? "", clause.text]),
    ...record.messages.filter((message) => message.role === "TENANT").map((message) => message.text),
  ];
  return new Set(texts.flatMap(numbersIn));
}

export function ungroundedNumbers(text: string, grounded: Set<number>) {
  return [...new Set(numbersIn(text).filter((value) => !grounded.has(value)))];
}

// --- law sections ------------------------------------------------------------------------------

const SECTION_MENTION = /סעיף\s+(\d+(?:\.\d+)*[א-ת]{0,2}(?:\s*\([^)\s]{1,4}\))*)/gu;

function normalizeSection(value: string) {
  return value.replace(/^סעיף\s*/u, "").replace(/\([^)]*\)/gu, "").replace(/["'״׳\s]/gu, "");
}

export function sectionMentions(text: string) {
  return [...text.matchAll(SECTION_MENTION)].map((match) => normalizeSection(match[1]!));
}

// A mention matches a law section exactly ("25י" also covers "25י(א)"), or a contract section
// itself or one of its subsections ("9" covers "9.2").
function mentionMatches(mention: string, lawSections: string[], contractSections: string[]) {
  return lawSections.includes(mention)
    || contractSections.some((label) => mention === label || mention.startsWith(`${label}.`));
}

// --- validation --------------------------------------------------------------------------------

// `message` goes back to the model in a tool error (English, like every prompt); `warning` is shown
// to the tenant when their own edit trips the same check.
export type GroundingProblem = { message: string; warning: string };

function textProblems(
  record: GroundingSource,
  text: string,
  lawSections: string[],
  contractSections: string[],
): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  if (/\[[A-Z_]{3,}\]/u.test(text)) {
    problems.push({
      message: "The message contains a redaction placeholder such as [LANDLORD_NAME]. Write around the missing detail instead of copying the placeholder.",
      warning: "ההודעה כוללת סימון של פרט שהוסתר (למשל [LANDLORD_NAME]). כדאי להחליף אותו בטקסט רגיל.",
    });
  }
  if (/https?:\/\/|www\.|@[a-z0-9-]+\./iu.test(text)) {
    problems.push({
      message: "The message contains a link or an email address. Remove it.",
      warning: "ההודעה כוללת קישור או כתובת דוא\"ל.",
    });
  }
  const unknownSections = [...new Set(sectionMentions(text))]
    .filter((mention) => !mentionMatches(mention, lawSections, contractSections));
  if (unknownSections.length) {
    problems.push({
      message: `The message names section(s) ${unknownSections.join(", ")}, which are neither a section of a legal reference cited in requests nor a contract section of a raised issue. Name only sections you cite.`,
      warning: `ההודעה מזכירה את ${unknownSections.map((section) => `סעיף ${section}`).join(", ")}, שאינו מופיע במקורות המשפטיים של הסעיפים שבהודעה.`,
    });
  }
  // Section numbers were checked above; only the remaining numbers are amounts, periods, and dates.
  const loose = ungroundedNumbers(text.replace(SECTION_MENTION, ""), groundedNumbers(record));
  if (loose.length) {
    problems.push({
      message: `The message states number(s) ${loose.join(", ")} that appear nowhere in the analysis, the law excerpts, or the tenant's messages. Use only those numbers, or ask the tenant for the figure.`,
      warning: `ההודעה כוללת מספרים שלא מופיעים בניתוח החוזה, בחוק או במה שכתבת בשיחה: ${loose.join(", ")}. כדאי לוודא שהם נכונים.`,
    });
  }
  return problems;
}

function includedIssues(record: Pick<NegotiationRecord, "issues" | "priorities" | "strategies">) {
  return record.priorities
    .filter((issueId) => record.strategies[issueId] && record.strategies[issueId]!.kind !== "CONCEDE")
    .map((issueId) => issueById(record, issueId))
    .filter((issue): issue is NegotiationIssue => issue !== null);
}

// Checks a draft written by the agent. Any problem rejects it, and the model is asked to fix it.
export function agentDraftProblems(
  record: GroundingSource & Pick<NegotiationRecord, "priorities" | "strategies">,
  draft: Pick<NegotiationDraft, "text" | "requests">,
): string[] {
  const problems: string[] = [];
  const included = includedIssues(record);
  const includedIds = new Set(included.map((issue) => issue.issueId));
  const seen = new Set<string>();
  const citedSections: string[] = [];
  let citedCount = 0;

  for (const request of draft.requests) {
    if (seen.has(request.issueId)) problems.push(`Issue ${request.issueId} appears more than once in requests.`);
    seen.add(request.issueId);
    const issue = issueById(record, request.issueId);
    if (!issue || !includedIds.has(request.issueId)) {
      problems.push(`Issue ${request.issueId} is not one the tenant chose to raise (conceded or not prioritized). Remove it from the message and from requests.`);
      continue;
    }
    for (const referenceId of request.lawReferenceIds) {
      const reference = issue.legalReferences.find((item) => item.lawReferenceId === referenceId);
      if (!reference) {
        problems.push(`Legal reference ${referenceId} does not belong to issue ${issue.issueId}. Cite only that issue's own references.`);
      } else {
        citedCount += 1;
        if (reference.section) citedSections.push(normalizeSection(reference.section));
      }
    }
    if (record.strategies[issue.issueId]?.kind === "CITE_LAW" && !request.lawReferenceIds.length) {
      problems.push(`The tenant chose to rely on the law for issue ${issue.issueId}, so its request must cite at least one of its legal references.`);
    }
  }
  const messageNumbers = new Set(numbersIn(draft.text.replace(SECTION_MENTION, "")));
  for (const issue of included) {
    if (!seen.has(issue.issueId)) problems.push(`The message leaves out issue ${issue.issueId} ("${issue.title}"), which the tenant chose to raise.`);
    // The tenant's own figures are the point of their request; a draft that swaps them for the
    // analysis' suggestion (or drops them) does not say what the tenant asked for.
    const request = record.strategies[issue.issueId]?.request ?? "";
    const dropped = [...new Set(numbersIn(request.replace(SECTION_MENTION, "")))].filter((value) => !messageNumbers.has(value));
    if (dropped.length) {
      problems.push(`The message drops the figure(s) ${dropped.join(", ")} from the tenant's recorded request for issue ${issue.issueId} ("${issue.title}"). Write the tenant's own ask as recorded in STATUS, not the analysis' suggestion.`);
    }
  }

  if (!HEBREW.test(draft.text)) problems.push("The message must be written in Hebrew.");
  if (draft.text.trim().length < 60) problems.push("The message is too short to carry the tenant's requests.");
  if (/חוק/u.test(draft.text) && citedCount === 0) {
    problems.push("The message refers to the law but no request cites a legal reference. Cite the reference the claim relies on, or remove the claim.");
  }
  const contractSections = included.map((issue) => issue.contractSection).filter((label): label is string => Boolean(label));
  problems.push(...textProblems(record, draft.text, citedSections, contractSections).map((problem) => problem.message));
  return problems;
}

// Checks a tenant's own edit. The tenant decides what to send, so problems are only shown as
// warnings next to the message.
export function tenantDraftWarnings(
  record: GroundingSource & Pick<NegotiationRecord, "priorities" | "strategies">,
  text: string,
) {
  const included = includedIssues(record);
  const lawSections = included.flatMap((issue) => issue.legalReferences)
    .map((reference) => reference.section)
    .filter((section): section is string => Boolean(section))
    .map(normalizeSection);
  const contractSections = included.map((issue) => issue.contractSection).filter((label): label is string => Boolean(label));
  return textProblems(record, text, lawSections, contractSections).map((problem) => problem.warning);
}

export function strategyProblems(
  record: GroundingSource & Pick<NegotiationRecord, "priorities">,
  issueId: string,
  strategy: IssueStrategy,
  concessionConfirmed: boolean,
): string[] {
  const issue = issueById(record, issueId);
  if (!issue || !record.priorities.includes(issueId)) {
    return [`Issue ${issueId} is not among the tenant's priorities.`];
  }
  const problems: string[] = [];
  if (strategy.kind === "CITE_LAW" && !issue.legalReferences.length) {
    problems.push(`Issue ${issueId} has no legal reference, so CITE_LAW is not available. Use PROPOSE_ALTERNATIVE or CONCEDE.`);
  }
  if (strategy.kind === "CONCEDE") {
    if (issue.severity === "RED" && !concessionConfirmed) {
      problems.push(`Issue ${issueId} conflicts with the law. Before conceding it, tell the tenant that such a clause may be void anyway and get their explicit confirmation, then set concessionConfirmed=true.`);
    }
    return problems;
  }
  if (!strategy.request || !HEBREW.test(strategy.request)) {
    problems.push("request must state the concrete ask in Hebrew.");
  }
  const grounded = groundedNumbers(record);
  for (const [field, text] of [["request", strategy.request], ["fallback", strategy.fallback]] as const) {
    const loose = text ? ungroundedNumbers(text, grounded) : [];
    if (loose.length) {
      problems.push(`${field} states number(s) ${loose.join(", ")} that appear nowhere in the analysis, the law excerpts, or the tenant's messages. Ask the tenant for the figure instead of choosing one.`);
    }
  }
  return problems;
}

const MAX_TENANT_ISSUES = 10;

// A topic the tenant raised that the analysis did not flag. Its wording comes from the model, so
// it is held to the same number rule as everything else.
export function tenantIssueProblems(
  record: GroundingSource,
  title: string,
  description: string,
): string[] {
  const problems: string[] = [];
  if (record.issues.filter((issue) => issue.kind === "TENANT_REQUEST").length >= MAX_TENANT_ISSUES) {
    problems.push(`At most ${MAX_TENANT_ISSUES} topics of the tenant's own can be added.`);
  }
  if (!HEBREW.test(title) || !HEBREW.test(description)) problems.push("title and description must be in Hebrew.");
  const loose = ungroundedNumbers(`${title}\n${description}`, groundedNumbers(record));
  if (loose.length) problems.push(`Number(s) ${loose.join(", ")} do not appear in the tenant's messages or the analysis.`);
  return problems;
}
