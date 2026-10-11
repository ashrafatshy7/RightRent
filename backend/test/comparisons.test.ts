import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { defaultPreferences, type AnalysisRecord, type ContractClause, type ContractRecord } from "../src/domain/models.js";
import { classifyClause, isSubstantiveClause } from "../src/modules/analyses/classification.js";
import { linkClauses } from "../src/modules/analyses/clause-linking.service.js";
import { computeDeterministicChecks, deterministicVerdict } from "../src/modules/analyses/deterministic-analysis.service.js";
import { evaluateProtectionChecklistDeterministically } from "../src/modules/analyses/protection-checklist.service.js";
import { alignClauses, assign, numberChanges, wordDiff } from "../src/modules/comparisons/clause-alignment.service.js";
import { compareVersions } from "../src/modules/comparisons/comparison.service.js";
import { extractClausesFromPlainText } from "../src/modules/contracts/pdf-extraction.service.js";

async function synthetic(file: string) {
  const text = await readFile(path.resolve("evaluation/contracts/synthetic", file), "utf8");
  return extractClausesFromPlainText(text).filter(isSubstantiveClause);
}

const version1 = await synthetic("RR-EVAL-006-cross-clause-links.txt");
const version2 = await synthetic("RR-EVAL-006-v2-landlord-revision.txt");

function contract(id: string, clauses: ContractClause[], version: number): ContractRecord {
  return {
    id,
    userId: "tenant",
    originalFileName: `${id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 1,
    storageKey: `${id}.pdf`,
    status: "ANALYZED",
    isScanned: false,
    extractionMs: 0,
    clauses,
    ...(version > 1 ? { previousContractId: "v1", rootContractId: "v1", version } : {}),
    uploadedAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
}

// The offline analysis of a contract, reduced to what a comparison reads.
function analysis(id: string, contractRecord: ContractRecord): AnalysisRecord {
  const graph = linkClauses(contractRecord.clauses);
  const findings = contractRecord.clauses.map((clause) => {
    const profile = graph.profiles.get(clause.id)!;
    const checks = computeDeterministicChecks(profile, graph.contractFacts);
    const verdict = deterministicVerdict(clause, {
      preferences: defaultPreferences,
      profile,
      contractFacts: graph.contractFacts,
      links: graph.links.get(clause.id)!,
      checks,
    });
    return { clauseId: clause.id, severity: classifyClause(verdict.legalAssessment), title: verdict.title };
  });
  return {
    analysisId: id,
    contractId: contractRecord.id,
    schemaVersion: "1.4.0",
    findings,
    protectionReport: evaluateProtectionChecklistDeterministically(contractRecord.clauses),
    preferencesSnapshot: defaultPreferences,
    summary: { critical: 0, warnings: 0, compliant: 0 },
    createdAt: "2026-10-11T00:00:00.000Z",
  } as unknown as AnalysisRecord;
}

test("clauses are matched by content, so an inserted clause does not misalign the rest", () => {
  const alignment = alignClauses(version1, version2).map(({ change, before, after, renumberedOnly }) =>
    [change, before.join("+"), after.join("+"), Boolean(renumberedOnly)]);
  assert.deepEqual(alignment, [
    ["UNCHANGED", "C001", "C001", false],
    ["UNCHANGED", "C002", "C002", false],
    ["UNCHANGED", "C003", "C003", false],
    ["UNCHANGED", "C004", "C004", false],
    ["ADDED", "", "C005", false],
    ["MODIFIED", "C005", "C006", false],
    ["UNCHANGED", "C006", "C007", false],
    ["MODIFIED", "C007", "C008", false],
    ["MODIFIED", "C008", "C009", false],
    // Only "בכפוף לסעיף 8" became "בכפוף לסעיף 9", because old section 8 is now section 9.
    ["UNCHANGED", "C009", "C010", true],
    ["UNCHANGED", "C010", "C011", true],
  ]);
});

test("moved, removed, and split sections are recognized", () => {
  const before = extractClausesFromPlainText([
    "1. תקופה", "תקופת השכירות היא 12 חודשים.",
    "2. תיקונים", "המשכיר יתקן ליקוי דחוף בתוך שלושה ימים. המשכיר יתקן ליקוי רגיל בתוך 30 ימים. השוכר יישא בתיקון נזק שגרם.",
    "3. חיות", "אין להחזיק בעלי חיים.",
    "4. כניסה", "המשכיר ייכנס בתיאום.",
  ].join("\n"));
  const after = extractClausesFromPlainText([
    "1. כניסה", "המשכיר ייכנס בתיאום.",
    "2. תקופה", "תקופת השכירות היא 12 חודשים.",
    "3. תיקונים דחופים", "המשכיר יתקן ליקוי דחוף בתוך שלושה ימים.",
    "4. תיקונים אחרים", "המשכיר יתקן ליקוי רגיל בתוך 30 ימים. השוכר יישא בתיקון נזק שגרם.",
  ].join("\n"));
  assert.deepEqual(alignClauses(before, after).map(({ change, before: from, after: to, moved }) => [change, from.join("+"), to.join("+"), moved]), [
    ["REMOVED", "C003", "", false],
    ["UNCHANGED", "C004", "C001", true],
    ["UNCHANGED", "C001", "C002", false],
    ["SPLIT", "C002", "C003+C004", false],
  ]);
});

test("the assignment is optimal overall, not greedy", () => {
  // Greedy would take (0,0) at cost 0.1 and be left with (1,1) at 0.9; the optimum pairs crosswise.
  assert.deepEqual(assign([[0.1, 0.2], [0.15, 0.9]]), [1, 0]);
  assert.deepEqual(assign([[0.5, 0.1, 0.9]]), [1]);
});

test("a revised clause shows its word changes and the numbers that changed", () => {
  const diff = wordDiff(
    "להבטחת התחייבויות השוכר ימסור ערבות בנקאית בסך 25,000 ש״ח.",
    "להבטחת התחייבויות השוכר ימסור ערבות בנקאית בסך 21,000 ש״ח.",
  );
  assert.deepEqual(diff.filter((part) => part.op !== "equal").map((part) => [part.op, part.text]), [["delete", "25,000"], ["insert", "21,000"]]);
  assert.deepEqual(numberChanges(diff), [{ before: "25,000", after: "21,000" }]);
});

test("each change is classified from the tenant's side", () => {
  const before = contract("v1", version1, 1);
  const after = contract("v2", version2, 2);
  const comparison = compareVersions(before, analysis("a1", before), after, analysis("a2", after));
  const byStatus = (status: string) => comparison.items.filter((item) => item.status === status)
    .map((item) => `${item.before?.label ?? "-"}>${item.after?.label ?? "-"}`);
  assert.deepEqual(byStatus("FIXED"), ["סעיף 8>סעיף 9"]);
  assert.deepEqual(byStatus("NEW_ISSUE"), ["->סעיף 5"]);
  // Entry notice shortened from 24 hours to one hour, and the option rent raised: neither was asked
  // for, and neither trips a rule, which is exactly why they are listed.
  assert.deepEqual(byStatus("UNREQUESTED_CHANGE"), ["סעיף 5>סעיף 6", "סעיף 7>סעיף 8"]);
  assert.deepEqual(byStatus("STILL_OPEN"), ["סעיף 6>סעיף 7", "סעיף 10>סעיף 11"]);
  assert.deepEqual(comparison.items.find((item) => item.status === "FIXED")?.numberChanges, [{ before: "25,000", after: "21,000" }]);
  // Most important first: new problems, then unrequested changes, then what remains, then fixes.
  assert.deepEqual([...new Set(comparison.items.map((item) => item.status))], ["NEW_ISSUE", "UNREQUESTED_CHANGE", "STILL_OPEN", "FIXED", "UNCHANGED"]);
  assert.match(comparison.headline, /1 מתוך 3/u);
  assert.deepEqual(comparison.warnings, []);
});
