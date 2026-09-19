import type { ContractClause, FindingCategory, LegalAssessment, Severity } from "../../domain/models.js";

export function classifyClause(assessment: LegalAssessment): Severity {
  if (assessment.violatesLaw) return "RED";
  if (assessment.riskWarning || assessment.preferenceConflict) return "ORANGE";
  return "OK";
}

// The tenant-facing severity (RED/ORANGE/OK) stays the only top-level label. This derives the
// internal reason bucket behind it, deterministically from the same assessment - never from the
// model - so legal problems, negotiation points, and preference mismatches stay distinguishable
// even though they can render at the same severity (e.g. riskWarning and preferenceConflict are
// both ORANGE, but one is a contractual risk and the other is a personal preference mismatch).
export function categoryForAssessment(assessment: LegalAssessment): FindingCategory {
  if (assessment.violatesLaw) return "legal_compliance";
  if (assessment.riskWarning) return "contractual_risk";
  if (assessment.preferenceConflict) return "tenant_preference";
  return "informational";
}

const PAGE_MARKER = /^\s*(?:עמוד|עמ['׳]?\.?)\s*\d+(?:\s*(?:מתוך|\/)\s*\d+)?\s*$/u;
const NUMBER_OR_DATE_ONLY = /^\s*\d{1,4}(?:[./-]\d{1,2}(?:[./-]\d{2,4})?)?\s*$/u;
const SEPARATOR_ONLY = /^[\s\-–—_=*.]{1,80}$/u;
const DOCUMENT_TITLE_ONLY = /^\s*חוזה\s+שכירות(?:\s+למגורים)?\s*(?:[—–-].*)?$/u;

// A clause the tenant should never see a finding card for: a page number, a bare separator, a date
// stamp, or the document's own title line. These carry no reviewable content, so calling the model
// on them (or showing "no contractual content to review" as if it were a finding) only adds noise
// and cost (section 16 of the brief). Real substantive clauses, however short, are never matched
// here - only these explicit, narrow junk patterns.
export function isSubstantiveClause(clause: ContractClause): boolean {
  const text = clause.text.trim();
  if (!text) return false;
  if (PAGE_MARKER.test(text) || NUMBER_OR_DATE_ONLY.test(text) || SEPARATOR_ONLY.test(text)) return false;
  if (DOCUMENT_TITLE_ONLY.test(text) && text.split(/\s+/u).length <= 12) return false;
  return true;
}

function normalizeForQuoteMatch(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

// Some PDF extractors (notably ones that place Hebrew glyphs one at a time instead of as normal
// text runs) inject a stray single space between every character of the extracted clause text.
// Collapsing runs of whitespace to one space (normalizeForQuoteMatch) does nothing for that case -
// every gap is already exactly one space - so the verbatim check needs to ignore whitespace
// entirely to recognize a genuinely-verbatim candidate against such a clause.
function stripWhitespace(text: string) {
  return text.replace(/\s+/gu, "");
}

// clauseQuote is supposed to be the exact contract text, but it comes from a language model, so it
// is never trusted blindly: this accepts it only when it is genuinely a substring of the clause
// (whitespace-insensitive), and otherwise falls back to a safe excerpt of the real clause text -
// never to an unverifiable, possibly-paraphrased quote (section 5 and section 23 of the brief).
export function resolveClauseQuote(clause: ContractClause, candidate: string): string {
  const normalizedClause = normalizeForQuoteMatch(clause.text);
  const normalizedCandidate = normalizeForQuoteMatch(candidate);
  const compactCandidate = stripWhitespace(candidate);
  if (compactCandidate && stripWhitespace(clause.text).includes(compactCandidate)) return normalizedCandidate;
  if (normalizedClause.length <= 280) return normalizedClause;
  return `${normalizedClause.slice(0, 277)}...`;
}
