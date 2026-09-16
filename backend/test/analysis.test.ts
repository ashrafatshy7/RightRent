import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { FindingCategory, FindingTopic, TenantPreferences } from "../src/domain/models.js";
import { redactClauses } from "../src/modules/analyses/anonymization.service.js";
import {
  categoryForAssessment,
  classifyClause,
  isSubstantiveClause,
  resolveClauseQuote,
} from "../src/modules/analyses/classification.js";
import {
  computeDeterministicChecks,
  deterministicVerdict,
} from "../src/modules/analyses/deterministic-analysis.service.js";
import {
  detectMissingProtections,
  evaluateProtectionChecklistDeterministically,
} from "../src/modules/analyses/protection-checklist.service.js";
import { extractClausesFromPlainText } from "../src/modules/contracts/pdf-extraction.service.js";

type EvaluationCase = {
  id: string;
  contractPath: string;
  preferenceProfileId: string;
  findings: Array<{
    clauseId: string;
    severity: string;
    category?: FindingCategory;
    topic?: FindingTopic;
    legalReferenceIds: string[];
  }>;
  missingProtectionIds: string[];
  privacy: { rawValuesThatMustBeAbsent: string[]; requiredPlaceholders: string[] };
};

const evaluationRoot = path.resolve("evaluation");
const annotations = JSON.parse(
  await readFile(path.join(evaluationRoot, "annotations/expected-findings.json"), "utf8"),
) as { cases: EvaluationCase[] };
const profiles = JSON.parse(
  await readFile(path.join(evaluationRoot, "preferences/tenant-profiles.json"), "utf8"),
) as { profiles: Array<TenantPreferences & { id: string }> };

for (const evaluationCase of annotations.cases) {
  test(`${evaluationCase.id} satisfies the executable analysis specification`, async () => {
    const source = await readFile(path.join(evaluationRoot, evaluationCase.contractPath), "utf8");
    const extracted = extractClausesFromPlainText(source);
    const redaction = await redactClauses(extracted);
    const modelBoundText = redaction.clauses.map((clause) => clause.text).join("\n");
    const profile = profiles.profiles.find((item) => item.id === evaluationCase.preferenceProfileId);
    assert.ok(profile);

    for (const raw of evaluationCase.privacy.rawValuesThatMustBeAbsent) {
      assert.equal(modelBoundText.includes(raw), false, `${raw} reached the model-bound payload`);
    }
    for (const placeholder of evaluationCase.privacy.requiredPlaceholders) {
      assert.equal(modelBoundText.includes(placeholder), true, `${placeholder} is missing`);
    }

    const verdicts = redaction.clauses.map((clause) => ({
      clauseId: clause.id,
      verdict: deterministicVerdict(clause, modelBoundText, profile),
    }));
    for (const expected of evaluationCase.findings) {
      const actual = verdicts.find((item) => item.clauseId === expected.clauseId);
      assert.ok(actual);
      assert.equal(classifyClause(actual.verdict.legalAssessment), expected.severity);
      if (expected.category) {
        assert.equal(categoryForAssessment(actual.verdict.legalAssessment), expected.category);
      }
      if (expected.topic) {
        assert.equal(actual.verdict.topic, expected.topic);
      }
      for (const referenceId of expected.legalReferenceIds) {
        assert.ok(actual.verdict.legalReferenceIds.includes(referenceId));
      }
    }

    const missing = detectMissingProtections(redaction.clauses).map((item) => item.protectionId);
    for (const expected of evaluationCase.missingProtectionIds) assert.ok(missing.includes(expected));
  });
}

test("classification is deterministic and never lets a violation become OK", () => {
  assert.equal(classifyClause({ violatesLaw: true, riskWarning: false, preferenceConflict: false }), "RED");
  assert.equal(classifyClause({ violatesLaw: false, riskWarning: true, preferenceConflict: false }), "ORANGE");
  assert.equal(classifyClause({ violatesLaw: false, riskWarning: false, preferenceConflict: true }), "ORANGE");
  assert.equal(classifyClause({ violatesLaw: false, riskWarning: false, preferenceConflict: false }), "OK");
});

test("category is derived from the same assessment as severity, independently of the model", () => {
  assert.equal(categoryForAssessment({ violatesLaw: true, riskWarning: true, preferenceConflict: true }), "legal_compliance");
  assert.equal(categoryForAssessment({ violatesLaw: false, riskWarning: true, preferenceConflict: true }), "contractual_risk");
  assert.equal(categoryForAssessment({ violatesLaw: false, riskWarning: false, preferenceConflict: true }), "tenant_preference");
  assert.equal(categoryForAssessment({ violatesLaw: false, riskWarning: false, preferenceConflict: false }), "informational");
});

test("non-substantive clauses (headers, page numbers, the document title) are filtered from findings", () => {
  assert.equal(isSubstantiveClause({ id: "C000", text: "חוזה שכירות למגורים — תרחיש הערכה RR-EVAL-005, תל אביב", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "עמוד 2 מתוך 5", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "12/03/2026", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "----------", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "   ", locations: [] }), false);
  assert.equal(
    isSubstantiveClause({ id: "C001", text: "תקופת השכירות היא שנים עשר חודשים.", locations: [] }),
    true,
  );
});

test("a quote is trusted only when it is genuinely part of the clause, otherwise a safe excerpt is used", () => {
  const clause = { id: "C001", text: "  להבטחת התחייבויות השוכר ימסור השוכר למשכיר ערבות בנקאית בסך 30,000 ש״ח.  ", locations: [] };
  assert.equal(
    resolveClauseQuote(clause, "ערבות בנקאית בסך 30,000 ש״ח"),
    "ערבות בנקאית בסך 30,000 ש״ח",
  );
  // A candidate the model invented (not present in the clause) never reaches the tenant verbatim.
  const fallback = resolveClauseQuote(clause, "הדירה תימסר כשהיא מרוהטת במלואה");
  assert.equal(fallback, clause.text.trim());
});

test("computeDeterministicChecks reports the security-deposit cap as a pure numeric calculation", () => {
  const clause = { id: "C007", text: "להבטחת התחייבויות השוכר ימסור השוכר למשכיר ערבות בנקאית בסך 30,000 ש״ח.", locations: [] };
  const fullText = "תקופת השכירות היא שנים עשר חודשים. דמי השכירות החודשיים הם 6,000 ש״ח.\n" + clause.text;
  const preferences: TenantPreferences = {
    maxMonthlyRentIls: 7_000,
    repairUrgencyHours: 72,
    leaseLengthMonths: 12,
    maxAnnualRentIncreasePercent: 5,
    petsRequired: false,
    furnishedRequired: false,
    acceptsGuarantorRequirement: true,
  };
  const checks = computeDeterministicChecks(clause, fullText, preferences);
  const securityCheck = checks.find((check) => check.ruleId === "IL-RLL-25Y-SECURITY-CAP");
  assert.ok(securityCheck);
  assert.equal(securityCheck.contractValue, 30_000);
  assert.equal(securityCheck.calculatedLimit, 18_000);
  assert.equal(securityCheck.difference, 12_000);
  assert.equal(securityCheck.passesRule, false);
});

test("a landlord-only early-termination right is PARTIAL, not COVERED, for the tenant protection checklist", () => {
  const clause = {
    id: "C012",
    text: "המשכיר רשאי לבטל את החוזה בכל עת בהודעה מוקדמת של 30 יום, מבלי שלשוכר תהיה זכות מקבילה לביטול מוקדם של החוזה.",
    locations: [],
  };
  const protections = evaluateProtectionChecklistDeterministically([clause]);
  const earlyTermination = protections.find((item) => item.protectionId === "RR-REC-EARLY-TERMINATION");
  assert.ok(earlyTermination);
  assert.equal(earlyTermination.status, "PARTIAL");
});
