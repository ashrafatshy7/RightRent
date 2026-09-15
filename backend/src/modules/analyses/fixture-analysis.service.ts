import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContractRecord, Protection } from "../../domain/models.js";
import type { ProviderVerdict } from "./ai-providers.js";

const backendRoot = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_PATH = path.resolve(backendRoot, "fixtures/tel-aviv-comprehensive-analysis.json");

type FixtureReference = {
  id: string;
  lawName: string;
  section: string | null;
  sourceUrl: string;
  revisionId: number | null;
  excerpt: string | null;
  sourceAsOf: string | null;
};

type FixtureFile = {
  sourceFile: string;
  capturedAt: string;
  rawClauses: Array<{ id: string; text: string }>;
  findingsByClauseId: Record<string, { verdict: Omit<ProviderVerdict, "usage">; references: FixtureReference[] }>;
  protectionReport: Protection[];
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureFile;

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

// One whole-document check, not a per-clause one: the fixture only replays its captured Claude
// output when the uploaded PDF extracts to exactly the clauses it was captured from (same IDs, same
// raw pre-redaction text, in order). This is deliberately stricter than matching by clause ID alone
// - clause IDs are positional (e.g. "C012"), so a different contract could easily reuse one - and it
// compares raw text rather than post-redaction text so the match doesn't depend on which PII_NER_MODE
// happens to be configured. Anything that doesn't match falls back to the free deterministic
// heuristic instead of serving another contract's canned answers.
export function matchesFixtureContract(contract: ContractRecord): boolean {
  if (contract.clauses.length !== fixture.rawClauses.length) return false;
  return contract.clauses.every((clause, index) => {
    const expected = fixture.rawClauses[index]!;
    return clause.id === expected.id && normalize(clause.text) === normalize(expected.text);
  });
}

export function fixtureVerdict(clauseId: string) {
  return fixture.findingsByClauseId[clauseId];
}

export function fixtureProtectionReport(): Protection[] {
  return fixture.protectionReport;
}
