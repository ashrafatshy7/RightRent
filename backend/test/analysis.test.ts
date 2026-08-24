import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { TenantPreferences } from "../src/domain/models.js";
import { redactClauses } from "../src/modules/analyses/anonymization.service.js";
import { classifyClause } from "../src/modules/analyses/classification.js";
import { deterministicVerdict } from "../src/modules/analyses/deterministic-analysis.service.js";
import { detectMissingProtections } from "../src/modules/analyses/protection-checklist.service.js";
import { extractClausesFromPlainText } from "../src/modules/contracts/pdf-extraction.service.js";

type EvaluationCase = {
  id: string;
  contractPath: string;
  preferenceProfileId: string;
  findings: Array<{ clauseId: string; severity: string; legalReferenceIds: string[] }>;
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
    const redaction = redactClauses(extracted);
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
