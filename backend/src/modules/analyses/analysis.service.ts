import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import type {
  AnalysisRecord,
  ContractClause,
  ContractRecord,
  Finding,
  LawChunk,
  LegalReference,
  Protection,
  TenantPreferences,
} from "../../domain/models.js";
import { getStore, type DataStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import {
  analyzeProtectionsWithClaude,
  analyzeWithClaude,
  embedText,
  type ProviderVerdict,
} from "./ai-providers.js";
import { redactClauses } from "./anonymization.service.js";
import { classifyClause } from "./classification.js";
import { deterministicVerdict } from "./deterministic-analysis.service.js";
import { retrieveLawCorpus } from "./law-corpus.service.js";
import { createMarkedPdf } from "./marked-pdf.service.js";
import { MONITORED_LAW_SOURCES } from "../law/law-source.catalog.js";
import {
  evaluateProtectionChecklistDeterministically,
  PROTECTION_CHECKLIST,
} from "./protection-checklist.service.js";

type RetrievedReference = {
  id: string;
  lawName: string;
  section: string | null;
  sourceUrl: string;
  revisionId: number | null;
};

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

function legalReference(reference: RetrievedReference): LegalReference {
  return {
    lawReferenceId: reference.id,
    lawName: reference.lawName,
    section: reference.section,
    sourceUrl: reference.sourceUrl,
    revisionId: reference.revisionId,
  };
}

function chunkReference(chunk: LawChunk): RetrievedReference {
  return {
    id: chunk.id,
    lawName: chunk.lawName,
    section: chunk.section,
    sourceUrl: chunk.sourceUrl,
    revisionId: chunk.revisionId,
  };
}

async function providerVerdict(
  clause: ContractClause,
  fullText: string,
  preferences: TenantPreferences,
) {
  if (env.analysisProvider !== "anthropic") {
    const verdict = deterministicVerdict(clause, fullText, preferences);
    const knownSections: Record<string, { section: string; title: string }> = {
      "IL-RLL-25Y-SECURITY-CAP": { section: "25י", title: "חוק השכירות והשאילה, תשל״א–1971" },
      "IL-RLL-25Z-REPAIRS": { section: "25ז", title: "חוק השכירות והשאילה, תשל״א–1971" },
    };
    return {
      verdict,
      references: verdict.legalReferenceIds.flatMap<RetrievedReference>((id) => {
        const known = knownSections[id];
        return known ? [{
          id,
          lawName: known.title,
          section: known.section,
          sourceUrl: "https://main.knesset.gov.il/apps/legislation/main/laws/2000596",
          revisionId: null,
        }] : [];
      }),
    };
  }
  const embedding = await embedText(clause.text);
  const lawSections = await retrieveLawCorpus(embedding, 5);
  return {
    verdict: await analyzeWithClaude(clause, lawSections, preferences),
    references: lawSections.map(chunkReference),
  };
}

function toFinding(
  clause: ContractClause,
  verdict: ProviderVerdict,
  context: RetrievedReference[],
): Finding {
  const references = verdict.legalReferenceIds
    .map((id) => context.find((item) => item.id === id))
    .filter((item): item is RetrievedReference => Boolean(item))
    .map(legalReference);

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

async function protectionReport(clauses: ContractClause[]): Promise<Protection[]> {
  if (env.analysisProvider !== "anthropic") {
    return evaluateProtectionChecklistDeterministically(clauses);
  }
  const checklistQuery = PROTECTION_CHECKLIST
    .map((item) => `${item.title}: ${item.description}`)
    .join("\n");
  const lawSections = await retrieveLawCorpus(await embedText(checklistQuery), 5);
  const providerReport = await analyzeProtectionsWithClaude(clauses, PROTECTION_CHECKLIST, lawSections);
  const context = lawSections.map(chunkReference);
  return providerReport.map((item) => {
    const checklistItem = PROTECTION_CHECKLIST.find((candidate) => candidate.protectionId === item.protectionId)!;
    return {
      protectionId: item.protectionId,
      title: checklistItem.title,
      status: item.status,
      explanation: item.explanation,
      relevantClauseIds: item.relevantClauseIds,
      legalReferences: item.legalReferenceIds
        .map((id) => context.find((reference) => reference.id === id))
        .filter((reference): reference is RetrievedReference => Boolean(reference))
        .map(legalReference),
      ...(item.status === "COVERED" ? {} : {
        suggestedText: item.suggestedText ?? checklistItem.suggestedText,
      }),
    };
  });
}

async function analysisInputHash(
  contract: ContractRecord,
  preferences: TenantPreferences,
  store: DataStore,
) {
  const lawCorpus = env.analysisProvider === "anthropic"
    ? (await store.listLawSourceStates())
      .filter((state) => state.status === "ACTIVE")
      .map((state) => ({
        israelLawId: state.israelLawId,
        fingerprint: state.activeOfficialFingerprint,
        revisionId: state.activeRevisionId,
        contentHash: state.activeContentHash,
      }))
      .sort((left, right) => left.israelLawId - right.israelLawId)
    : "deterministic-fixture-v1";
  return createHash("sha256").update(JSON.stringify({
    clauses: contract.clauses.map(({ id, text }) => ({ id, text })),
    preferences,
    provider: env.analysisProvider,
    lawCorpus,
  })).digest("hex");
}

export async function analyzeContract(
  contractId: string,
  userId: string,
  preferences: TenantPreferences,
) {
  const store = await getStore();
  const contract = await store.getContract(contractId);
  if (!contract || contract.userId !== userId) {
    throw new HttpError(404, "CONTRACT_NOT_FOUND", "The contract was not found.");
  }
  if (env.analysisProvider === "anthropic") {
    const activeIds = new Set(
      (await store.listLawSourceStates())
        .filter((state) => state.status === "ACTIVE")
        .map((state) => state.israelLawId),
    );
    const unavailable = MONITORED_LAW_SOURCES
      .map((source) => source.israelLawId)
      .filter((israelLawId) => !activeIds.has(israelLawId));
    if (unavailable.length) {
      throw new HttpError(
        503,
        "INCOMPLETE_VERIFIED_LAW_CORPUS",
        "Analysis is disabled until every monitored law has an approved active version.",
        { unavailableIsraelLawIds: unavailable },
      );
    }
  }
  const inputHash = await analysisInputHash(contract, preferences, store);
  const existing = await store.findAnalysisByInput(contractId, inputHash);
  if (existing) return { analysis: existing, created: false };

  const started = performance.now();
  const redactionStarted = performance.now();
  const redaction = await redactClauses(contract.clauses);
  const redactionMs = Math.round(performance.now() - redactionStarted);
  const fullText = redaction.clauses.map((clause) => clause.text).join("\n");

  const analysisStarted = performance.now();
  const verdicts = await mapWithConcurrency(redaction.clauses, 3, (clause) =>
    providerVerdict(clause, fullText, preferences));
  const findings = redaction.clauses.map((clause, index) =>
    toFinding(clause, verdicts[index]!.verdict, verdicts[index]!.references));
  const protections = await protectionReport(redaction.clauses);
  const incompleteProtections = protections.filter((item) => item.status !== "COVERED");
  const analysisMs = Math.round(performance.now() - analysisStarted);

  const analysisId = randomUUID();
  const pdfStarted = performance.now();
  const source = await readFile(path.join(env.uploadDirectory, contract.storageKey));
  const markedPdfStorageKey = await createMarkedPdf(source, analysisId, findings);
  const pdfMs = Math.round(performance.now() - pdfStarted);
  const createdAt = new Date().toISOString();
  const pipelineMs = Math.round(performance.now() - started);
  const totalMs = (contract.extractionMs ?? 0) + pipelineMs;
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
    protectionReport: protections,
    missingProtections: incompleteProtections,
    suggestedAdditions: incompleteProtections,
    preferencesSnapshot: structuredClone(preferences),
    analysisInputHash: inputHash,
    privacy: {
      redactionCompleted: true,
      redactedEntityCount: redaction.redactedEntityCount,
      mode: redaction.mode,
      model: redaction.model,
    },
    disclaimer: { notLegalAdvice: true, humanReviewRecommended: true },
    markedPdf: { storageKey: markedPdfStorageKey },
    timingMs: {
      extraction: contract.extractionMs ?? 0,
      redaction: redactionMs,
      retrievalAndAnalysis: analysisMs,
      pdfGeneration: pdfMs,
      total: totalMs,
      target: env.analysisTargetMs,
      targetMet: totalMs <= env.analysisTargetMs,
    },
    userId,
    createdAt,
  };

  try {
    await store.createAnalysis(record);
    await store.updateContract({ ...contract, status: "ANALYZED", updatedAt: createdAt });
  } catch (error) {
    await rm(path.join(env.markedPdfDirectory, markedPdfStorageKey), { force: true });
    if (error instanceof Error && "code" in error && error.code === 11_000) {
      const raced = await store.findAnalysisByInput(contractId, inputHash);
      if (raced?.userId === userId) return { analysis: raced, created: false };
    }
    throw error;
  }
  return { analysis: record, created: true };
}

export function publicAnalysis(record: AnalysisRecord) {
  const { userId: _userId, createdAt, ...result } = record;
  return { ...result, createdAt };
}
