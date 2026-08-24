import type { LegalAssessment, Severity } from "../../domain/models.js";

export function classifyClause(assessment: LegalAssessment): Severity {
  if (assessment.violatesLaw) return "RED";
  if (assessment.riskWarning || assessment.preferenceConflict) return "ORANGE";
  return "OK";
}
