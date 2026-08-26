import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.resolve(process.env.EVALUATION_RESULTS_DIR ?? path.join(root, "results"));
const annotations = JSON.parse(await readFile(path.join(root, "annotations/expected-findings.json"), "utf8"));

let files = [];
try {
  files = (await readdir(resultsDirectory)).filter((name) => name.endsWith(".json"));
} catch {
  console.error(`Release gate requires result JSON files in ${resultsDirectory}.`);
  process.exit(1);
}
const results = await Promise.all(files.map(async (name) =>
  JSON.parse(await readFile(path.join(resultsDirectory, name), "utf8"))));
const byCase = new Map(results.map((result) => [result.caseId, result]));
const failures = [];
if (annotations.cases.length < 10) failures.push("The legally annotated evaluation set must contain at least 10 contracts.");

let expectedViolations = 0;
let foundViolations = 0;
let predictedWarnings = 0;
let correctWarnings = 0;
let expectedProtections = 0;
let foundProtections = 0;

for (const expectedCase of annotations.cases) {
  const result = byCase.get(expectedCase.id);
  if (!result?.analysis || typeof result.modelBoundText !== "string") {
    failures.push(`${expectedCase.id} is missing an analysis or captured modelBoundText.`);
    continue;
  }
  const expectedByClause = new Map(expectedCase.findings.map((finding) => [finding.clauseId, finding]));
  for (const expected of expectedCase.findings) {
    const actual = result.analysis.findings?.find((finding) => finding.clauseId === expected.clauseId);
    if (expected.legalAssessment.violatesLaw) {
      expectedViolations += 1;
      if (actual?.severity === "RED" && actual.legalAssessment?.violatesLaw) foundViolations += 1;
      else failures.push(`${expectedCase.id}/${expected.clauseId} is an expected violation that was not RED.`);
    }
  }
  for (const actual of result.analysis.findings ?? []) {
    if (!["RED", "ORANGE"].includes(actual.severity)) continue;
    predictedWarnings += 1;
    if (expectedByClause.get(actual.clauseId)?.severity === actual.severity) correctWarnings += 1;
  }
  const reportedProtections = new Set(
    (result.analysis.protectionReport ?? [])
      .filter((item) => item.status !== "COVERED")
      .map((item) => item.protectionId),
  );
  expectedProtections += expectedCase.missingProtectionIds.length;
  foundProtections += expectedCase.missingProtectionIds.filter((id) => reportedProtections.has(id)).length;
  for (const rawValue of expectedCase.privacy.rawValuesThatMustBeAbsent) {
    if (result.modelBoundText.includes(rawValue)) failures.push(`${expectedCase.id} leaked PII into modelBoundText.`);
  }
  if ((result.analysis.timingMs?.total ?? Number.POSITIVE_INFINITY) > 90_000) {
    failures.push(`${expectedCase.id} exceeded the 90-second target.`);
  }
}

const recall = expectedViolations ? foundViolations / expectedViolations : 0;
const precision = predictedWarnings ? correctWarnings / predictedWarnings : 0;
const protectionRecall = expectedProtections ? foundProtections / expectedProtections : 1;
if (recall < 0.9) failures.push(`Violation recall ${(recall * 100).toFixed(1)}% is below 90%.`);
if (precision < 0.95) failures.push(`RED/ORANGE precision ${(precision * 100).toFixed(1)}% is below 95%.`);
if (protectionRecall < 0.85) failures.push(`Protection recall ${(protectionRecall * 100).toFixed(1)}% is below 85%.`);

console.log(JSON.stringify({
  contracts: annotations.cases.length,
  recall,
  precision,
  protectionRecall,
  failures,
}, null, 2));
if (failures.length) process.exitCode = 1;
