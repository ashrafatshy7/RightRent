import type { AnalysisRecord, ContractRecord, Finding, Protection, Severity } from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { costInputs, simulateCost } from "../analyses/cost-simulation.service.js";
import { currentCpi } from "../market/cpi.service.js";
import { alignClauses, numberChanges, wordDiff, type AlignmentChange, type DiffPart } from "./clause-alignment.service.js";

// What changed between two analyzed versions of a contract, from the tenant's side: which problems
// the landlord fixed, which remain, which are new, and - the part that is easy to miss - which
// clauses changed although the tenant never asked for it.

export type ComparisonStatus =
  | "NEW_ISSUE"
  | "WORSENED"
  | "UNREQUESTED_CHANGE"
  | "STILL_OPEN"
  | "IMPROVED"
  | "FIXED"
  | "UNCHANGED";

export type ComparisonSide = {
  clauseIds: string[];
  label: string;
  text: string;
  severity: Severity | null;
  title: string | null;
};

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

export type ContractComparison = {
  base: VersionSummary;
  target: VersionSummary;
  headline: string;
  counts: Record<ComparisonStatus, number>;
  items: ComparisonItem[];
  protections: Array<{ protectionId: string; title: string; before: Protection["status"] | null; after: Protection["status"] | null }>;
  cost: { before: number | null; after: number | null };
  warnings: string[];
};

type VersionSummary = {
  analysisId: string;
  contractId: string;
  version: number;
  fileName: string;
  createdAt: string;
  summary: AnalysisRecord["summary"];
};

const STATUS_ORDER: ComparisonStatus[] = ["NEW_ISSUE", "WORSENED", "UNREQUESTED_CHANGE", "STILL_OPEN", "IMPROVED", "FIXED", "UNCHANGED"];
const SEVERITY_RANK: Record<Severity, number> = { OK: 0, ORANGE: 1, RED: 2 };

function worst(findings: Finding[]): Finding | null {
  return [...findings].sort((left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity])[0] ?? null;
}

function side(contract: ContractRecord, analysis: AnalysisRecord, clauseIds: string[]): ComparisonSide | null {
  if (!clauseIds.length) return null;
  const clauses = clauseIds.map((id) => contract.clauses.find((clause) => clause.id === id)).filter((clause) => clause !== undefined);
  const findings = clauseIds.map((id) => analysis.findings.find((finding) => finding.clauseId === id)).filter((finding) => finding !== undefined);
  const first = clauses[0];
  const finding = worst(findings);
  return {
    clauseIds,
    label: first?.sectionLabel ? `סעיף ${first.sectionLabel}${first.heading ? ` · ${first.heading}` : ""}` : clauseIds.join(", "),
    text: clauses.map((clause) => clause.text).join("\n"),
    severity: finding?.severity ?? null,
    title: finding && finding.severity !== "OK" ? finding.title : null,
  };
}

// The status of one aligned pair, read from the tenant's side. A problem counts when its severity
// is RED or ORANGE; a clause with no finding (a title, a page number) counts as fine.
function statusOf(change: AlignmentChange, before: ComparisonSide | null, after: ComparisonSide | null): ComparisonStatus {
  const was = SEVERITY_RANK[before?.severity ?? "OK"];
  const is = SEVERITY_RANK[after?.severity ?? "OK"];
  if (change === "REMOVED") return was > 0 ? "FIXED" : "UNREQUESTED_CHANGE";
  if (change === "ADDED") return is > 0 ? "NEW_ISSUE" : "UNREQUESTED_CHANGE";
  if (was > 0 && is === 0) return "FIXED";
  if (was === 0 && is > 0) return "NEW_ISSUE";
  if (is > was) return "WORSENED";
  if (is < was) return "IMPROVED";
  if (was > 0) return "STILL_OPEN";
  // Fine before and after: unchanged, unless the text changed - a change the tenant did not ask for.
  return change === "UNCHANGED" ? "UNCHANGED" : "UNREQUESTED_CHANGE";
}

// Hebrew agreement: "בעיה אחת" but "3 בעיות", and a conjunction before a digit takes a maqaf ("ו־2").
function counted(count: number, one: string, many: string) {
  return count === 1 ? one : `${count} ${many}`;
}

function headline(counts: Record<ComparisonStatus, number>, issuesBefore: number) {
  const parts: string[] = [];
  const fixed = counts.FIXED + counts.IMPROVED;
  parts.push(issuesBefore
    ? `המשכיר תיקן או שיפר ${fixed} מתוך ${counted(issuesBefore, "הבעיה", "הבעיות")} שמצאנו בגרסה הקודמת`
    : "בגרסה הקודמת לא מצאנו בעיות");
  const added = counts.NEW_ISSUE + counts.WORSENED;
  if (added) parts.push(added === 1 ? "נוספה או החמירה בעיה אחת" : `נוספו או החמירו ${added} בעיות`);
  const unrequested = counts.UNREQUESTED_CHANGE;
  if (unrequested) parts.push(unrequested === 1 ? "סעיף אחד השתנה בלי שביקשתם" : `${unrequested} סעיפים השתנו בלי שביקשתם`);
  const last = parts.pop()!;
  const sentence = parts.length ? `${parts.join(", ")} ו${/^\d/u.test(last) ? "־" : ""}${last}.` : `${last}.`;
  return unrequested ? `${sentence} כדאי לוודא שהשינויים האלה מקובלים עליכם.` : sentence;
}

async function totalCost(analysis: AnalysisRecord, annualInflationPercent: number) {
  if (!analysis.financialTerms) return null;
  const simulation = simulateCost(costInputs(analysis.financialTerms, analysis.financialOverrides), {
    annualInflationPercent,
    includeOption: false,
    exitAfterMonth: null,
    replacementAfterMonths: 2,
    lateVacatingDays: 0,
    latePaymentDays: 0,
  }, analysis.preferencesSnapshot);
  return simulation.ready ? simulation.totals.total : null;
}

export function compareVersions(
  baseContract: ContractRecord,
  base: AnalysisRecord,
  targetContract: ContractRecord,
  target: AnalysisRecord,
): Omit<ContractComparison, "cost"> {
  const analyzed = (contract: ContractRecord, analysis: AnalysisRecord) => {
    const findingIds = new Set(analysis.findings.map((finding) => finding.clauseId));
    return contract.clauses.filter((clause) => findingIds.has(clause.id));
  };
  const items = alignClauses(analyzed(baseContract, base), analyzed(targetContract, target)).map<ComparisonItem>((alignment) => {
    const before = side(baseContract, base, alignment.before);
    const after = side(targetContract, target, alignment.after);
    const diff = before && after && alignment.change !== "UNCHANGED" ? wordDiff(before.text, after.text) : null;
    return {
      status: statusOf(alignment.change, before, after),
      change: alignment.change,
      moved: alignment.moved,
      renumberedOnly: alignment.renumberedOnly ?? false,
      before,
      after,
      diff,
      numberChanges: diff ? numberChanges(diff) : [],
    };
  });
  items.sort((left, right) => STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status));
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, items.filter((item) => item.status === status).length])) as Record<ComparisonStatus, number>;
  const issuesBefore = base.findings.filter((finding) => finding.severity !== "OK").length;

  const protectionIds = [...new Set([...base.protectionReport, ...target.protectionReport].map((item) => item.protectionId))];
  const protections = protectionIds.map((protectionId) => {
    const before = base.protectionReport.find((item) => item.protectionId === protectionId);
    const after = target.protectionReport.find((item) => item.protectionId === protectionId);
    return { protectionId, title: (after ?? before)!.title, before: before?.status ?? null, after: after?.status ?? null };
  });

  const warnings: string[] = [];
  if (JSON.stringify(base.preferencesSnapshot) !== JSON.stringify(target.preferencesSnapshot)) {
    warnings.push("שתי הגרסאות נותחו עם העדפות שונות, ולכן חלק מההבדלים בממצאים נובעים מההעדפות ולא מהחוזה.");
  }
  if (base.schemaVersion !== target.schemaVersion) {
    warnings.push("שתי הגרסאות נותחו בגרסאות שונות של המערכת; ייתכן שחלק מההבדלים נובעים מכך.");
  }

  const summary = (contract: ContractRecord, analysis: AnalysisRecord): VersionSummary => ({
    analysisId: analysis.analysisId,
    contractId: contract.id,
    version: contract.version ?? 1,
    fileName: contract.originalFileName,
    createdAt: analysis.createdAt,
    summary: analysis.summary,
  });
  return {
    base: summary(baseContract, base),
    target: summary(targetContract, target),
    headline: headline(counts, issuesBefore),
    counts,
    items,
    protections,
    warnings,
  };
}

// Only versions of the same contract are compared: the target must descend from the same first
// version as the base, and both must belong to the tenant.
export async function compareAnalyses(baseAnalysisId: string, targetAnalysisId: string, userId: string): Promise<ContractComparison> {
  const store = await getStore();
  const [base, target] = await Promise.all([store.getAnalysis(baseAnalysisId), store.getAnalysis(targetAnalysisId)]);
  if (!base || !target || base.userId !== userId || target.userId !== userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  const [baseContract, targetContract] = await Promise.all([store.getContract(base.contractId), store.getContract(target.contractId)]);
  if (!baseContract || !targetContract) {
    throw new HttpError(404, "CONTRACT_NOT_FOUND", "A compared contract is no longer available.");
  }
  const root = (contract: ContractRecord) => contract.rootContractId ?? contract.id;
  if (root(baseContract) !== root(targetContract) || baseContract.id === targetContract.id) {
    throw new HttpError(409, "NOT_VERSIONS_OF_ONE_CONTRACT", "Only two different versions of the same contract can be compared.");
  }
  const comparison = compareVersions(baseContract, base, targetContract, target);
  const { last12MonthsPercent } = await currentCpi();
  return {
    ...comparison,
    cost: { before: await totalCost(base, last12MonthsPercent), after: await totalCost(target, last12MonthsPercent) },
  };
}
