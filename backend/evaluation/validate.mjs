import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function readJson(relativePath) {
  const contents = await readFile(path.join(evaluationRoot, relativePath), "utf8");
  return JSON.parse(contents);
}

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listJsonFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat().filter((filePath) => filePath.endsWith(".json"));
}

for (const jsonPath of await listJsonFiles(evaluationRoot)) {
  try {
    JSON.parse(await readFile(jsonPath, "utf8"));
  } catch (error) {
    failures.push(`${path.relative(evaluationRoot, jsonPath)} is invalid JSON: ${error.message}`);
  }
}

const annotations = await readJson("annotations/expected-findings.json");
const lawCorpus = await readJson("law/fair-rental-law-sections.json");
const tenantProfiles = await readJson("preferences/tenant-profiles.json");
const expectedFindingsSchema = await readJson("schemas/expected-findings.schema.json");
const tenantProfilesSchema = await readJson("schemas/tenant-profiles.schema.json");
const analysisResultSchema = await readJson("schemas/analysis-result.schema.json");

for (const [name, schema] of [
  ["expected findings", expectedFindingsSchema],
  ["tenant profiles", tenantProfilesSchema],
  ["analysis result", analysisResultSchema],
]) {
  try {
    ajv.compile(schema);
  } catch (error) {
    failures.push(`${name} JSON Schema is invalid: ${error.message}`);
  }
}
const validateExpectedFindings = ajv.compile(expectedFindingsSchema);
const validateTenantProfiles = ajv.compile(tenantProfilesSchema);
check(validateExpectedFindings(annotations), `Expected-findings data violates its schema: ${ajv.errorsText(validateExpectedFindings.errors)}`);
check(validateTenantProfiles(tenantProfiles), `Tenant-profile data violates its schema: ${ajv.errorsText(validateTenantProfiles.errors)}`);

const lawIds = new Set(lawCorpus.sections.map((section) => section.id));
const profileIds = new Set(tenantProfiles.profiles.map((profile) => profile.id));
const caseIds = new Set();

check(
  lawIds.size === lawCorpus.sections.length,
  "Law corpus contains duplicate section IDs.",
);
check(
  profileIds.size === tenantProfiles.profiles.length,
  "Tenant profiles contain duplicate IDs.",
);
check(
  annotations.lawCorpusVersion === lawCorpus.corpusVersion,
  "Annotation and law-corpus versions do not match.",
);

for (const evaluationCase of annotations.cases) {
  check(!caseIds.has(evaluationCase.id), `Duplicate case ID: ${evaluationCase.id}`);
  caseIds.add(evaluationCase.id);
  check(
    profileIds.has(evaluationCase.preferenceProfileId),
    `${evaluationCase.id} references unknown profile ${evaluationCase.preferenceProfileId}.`,
  );

  let contractText = "";
  try {
    contractText = await readFile(
      path.join(evaluationRoot, evaluationCase.contractPath),
      "utf8",
    );
  } catch (error) {
    failures.push(`${evaluationCase.id} contract cannot be read: ${error.message}`);
    continue;
  }

  const fixtureClauseIds = [...contractText.matchAll(/^\[(C\d{3})\]$/gm)].map(
    (match) => match[1],
  );
  check(
    new Set(fixtureClauseIds).size === fixtureClauseIds.length,
    `${evaluationCase.id} contains duplicate clause IDs.`,
  );
  check(
    JSON.stringify(fixtureClauseIds) === JSON.stringify(evaluationCase.requiredClauseIds),
    `${evaluationCase.id} requiredClauseIds do not match the contract fixture.`,
  );

  for (const finding of evaluationCase.findings) {
    check(
      fixtureClauseIds.includes(finding.clauseId),
      `${evaluationCase.id} finding references unknown clause ${finding.clauseId}.`,
    );
    for (const referenceId of finding.legalReferenceIds) {
      check(
        lawIds.has(referenceId),
        `${evaluationCase.id} finding references unknown law ID ${referenceId}.`,
      );
    }

    const assessment = finding.legalAssessment;
    const expectedSeverity = assessment.violatesLaw
      ? "RED"
      : assessment.riskWarning || assessment.preferenceConflict
        ? "ORANGE"
        : "OK";
    check(
      finding.severity === expectedSeverity,
      `${evaluationCase.id}/${finding.clauseId} severity violates the deterministic rule.`,
    );
    check(
      finding.severity !== "RED" || finding.legalReferenceIds.length > 0,
      `${evaluationCase.id}/${finding.clauseId} is RED without a legal reference.`,
    );
  }

  for (const protectionId of evaluationCase.missingProtectionIds) {
    check(
      lawIds.has(protectionId),
      `${evaluationCase.id} references unknown protection ${protectionId}.`,
    );
  }

  for (const rawValue of evaluationCase.privacy.rawValuesThatMustBeAbsent) {
    check(
      contractText.includes(rawValue),
      `${evaluationCase.id} privacy value is not present in its source fixture: ${rawValue}`,
    );
  }

  if (evaluationCase.promptInjection.present) {
    check(
      evaluationCase.promptInjection.mustBeIgnored,
      `${evaluationCase.id} contains prompt injection but does not require it to be ignored.`,
    );
    check(
      fixtureClauseIds.includes(evaluationCase.promptInjection.clauseId),
      `${evaluationCase.id} prompt injection references an unknown clause.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`Evaluation validation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Evaluation validation passed: ${annotations.cases.length} cases, ` +
      `${lawCorpus.sections.length} law/protection entries, ` +
      `${tenantProfiles.profiles.length} tenant profiles.`,
  );
}
