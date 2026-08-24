import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import type {
  AnalysisRecord,
  ContractClause,
  Finding,
  LawChunk,
  TenantPreferences,
} from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { analyzeWithClaude, embedText, type ProviderVerdict } from "./ai-providers.js";
import { redactClauses } from "./anonymization.service.js";
import { classifyClause } from "./classification.js";
import { deterministicVerdict } from "./deterministic-analysis.service.js";
import { activeLawCorpus } from "./law-corpus.service.js";
import { createMarkedPdf } from "./marked-pdf.service.js";
import { detectMissingProtections } from "./protection-checklist.service.js";

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

async function providerVerdict(
  clause: ContractClause,
  fullText: string,
  preferences: TenantPreferences,
  corpus: LawChunk[],
) {
  if (env.analysisProvider !== "anthropic") {
    return deterministicVerdict(clause, fullText, preferences);
  }
  const store = await getStore();
  const embedding = await embedText(clause.text);
  const stored = await store.getLawChunks();
  const lawSections = stored.some((item) => item.embedding?.length)
    ? await store.searchLawChunks(embedding, 5)
    : corpus.slice(0, 5);
  return analyzeWithClaude(clause, lawSections, preferences);
}

function toFinding(clause: ContractClause, verdict: ProviderVerdict, corpus: LawChunk[]): Finding {
  const references = verdict.legalReferenceIds
    .map((id) => corpus.find((item) => item.id === id))
    .filter((item): item is LawChunk => Boolean(item))
    .map((item) => ({ lawReferenceId: item.id, section: item.section }));

  if (verdict.legalAssessment.violatesLaw && references.length === 0) {
    throw new HttpError(
      502,
      "UNSUPPORTED_LEGAL_CLAIM",
      `The analysis marked ${clause.id} as illegal without a retrieved legal reference.`,
    );
  }

  return {
    clauseId: clause.id,
    severity: classifyClause(verdict.legalAssessment),
    title: verdict.title,
    explanation: verdict.explanation,
    legalAssessment: verdict.legalAssessment,
    legalReferences: references,
    locations: clause.locations,
  };
}

export async function analyzeContract(
  contractId: string,
  userId: string,
  preferences: TenantPreferences,
) {
  const store = await getStore();
  const existing = await store.findAnalysisByContract(contractId);
  if (existing) {
    if (existing.userId !== userId) throw new HttpError(404, "CONTRACT_NOT_FOUND", "The contract was not found.");
    return { analysis: existing, created: false };
  }

  const contract = await store.getContract(contractId);
  if (!contract || contract.userId !== userId) {
    throw new HttpError(404, "CONTRACT_NOT_FOUND", "The contract was not found.");
  }

  const started = performance.now();
  const redactionStarted = performance.now();
  const redaction = redactClauses(contract.clauses);
  const redactionMs = Math.round(performance.now() - redactionStarted);
  const corpus = await activeLawCorpus();
  const fullText = redaction.clauses.map((clause) => clause.text).join("\n");

  const analysisStarted = performance.now();
  const verdicts = await mapWithConcurrency(redaction.clauses, 3, (clause) =>
    providerVerdict(clause, fullText, preferences, corpus));
  const findings = redaction.clauses.map((clause, index) =>
    toFinding(clause, verdicts[index]!, corpus));
  const missingProtections = detectMissingProtections(redaction.clauses);
  const analysisMs = Math.round(performance.now() - analysisStarted);

  const analysisId = randomUUID();
  const pdfStarted = performance.now();
  const source = await readFile(path.join(env.uploadDirectory, contract.storageKey));
  const markedPdfStorageKey = await createMarkedPdf(source, analysisId, findings);
  const pdfMs = Math.round(performance.now() - pdfStarted);
  const createdAt = new Date().toISOString();
  const record: AnalysisRecord = {
    schemaVersion: "1.0.0",
    analysisId,
    contractId,
    status: "COMPLETED",
    summary: {
      critical: findings.filter((finding) => finding.severity === "RED").length,
      warnings: findings.filter((finding) => finding.severity === "ORANGE").length,
      compliant: findings.filter((finding) => finding.severity === "OK").length,
    },
    findings,
    missingProtections,
    suggestedAdditions: missingProtections,
    privacy: { redactionCompleted: true, redactedEntityCount: redaction.redactedEntityCount },
    markedPdf: { storageKey: markedPdfStorageKey },
    timingMs: {
      extraction: 0,
      redaction: redactionMs,
      retrievalAndAnalysis: analysisMs,
      pdfGeneration: pdfMs,
      total: Math.round(performance.now() - started),
    },
    userId,
    createdAt,
  };

  try {
    await store.createAnalysis(record);
    await store.updateContract({ ...contract, status: "ANALYZED", updatedAt: createdAt });
  } catch (error) {
    await rm(path.join(env.markedPdfDirectory, markedPdfStorageKey), { force: true });
    throw error;
  }
  return { analysis: record, created: true };
}

export function publicAnalysis(record: AnalysisRecord) {
  const { userId: _userId, createdAt, ...result } = record;
  return { ...result, createdAt };
}
