import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import type {
  AnalysisRecord,
  ConfidenceLevel,
  ContractClause,
  ContractRecord,
  DeterministicCheck,
  Finding,
  FindingTopic,
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
  PROTECTION_REQUEST_FINGERPRINT,
  VERDICT_REQUEST_FINGERPRINT,
  type ProviderVerdict,
} from "./ai-providers.js";
import { traceAnalysis, traceAnalysisFailure } from "./analysis-logger.js";
import { redactClauses } from "./anonymization.service.js";
import { categoryForAssessment, classifyClause, isSubstantiveClause, resolveClauseQuote } from "./classification.js";
import {
  computeDeterministicChecks,
  DETERMINISTIC_RULE_LAW_INFO,
  deterministicVerdict,
} from "./deterministic-analysis.service.js";
import { fixtureProtectionReport, fixtureVerdict, matchesFixtureContract } from "./fixture-analysis.service.js";
import { retrieveLawCorpus } from "./law-corpus.service.js";
import { createMarkedPdf } from "./marked-pdf.service.js";
import { MONITORED_LAW_SOURCES } from "../law/law-source.catalog.js";
import {
  evaluateProtectionChecklistDeterministically,
  PROTECTION_CHECKLIST,
} from "./protection-checklist.service.js";

// The schema/logic version behind AnalysisResult and Finding, folded into analysisInputHash below
// so that a change here always produces a fresh analysis instead of returning a previously saved
// record in the old shape (see findAnalysisByInput).
const ANALYSIS_SCHEMA_VERSION = "1.1.0";

type RetrievedReference = {
  id: string;
  lawName: string;
  section: string | null;
  sourceUrl: string;
  revisionId: number | null;
  excerpt: string | null;
  sourceAsOf: string | null;
};

type LawCorpusFingerprint =
  | Array<{
    israelLawId: number;
    fingerprint: string | null;
    revisionId: number | null;
    contentHash: string | null;
  }>
  | "deterministic-fixture-v1";

// Everything a saved Claude result depends on besides its own input: the tenant, their confirmed
// preferences, and the exact verified law versions used for retrieval.
type AiResultScope = {
  userId: string;
  preferences: TenantPreferences;
  lawCorpus: LawCorpusFingerprint;
};

const AI_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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

const REFERENCE_EXCERPT_MAX_CHARS = 320;

function legalReference(reference: RetrievedReference): LegalReference {
  return {
    lawReferenceId: reference.id,
    lawName: reference.lawName,
    section: reference.section,
    sourceUrl: reference.sourceUrl,
    revisionId: reference.revisionId,
    excerpt: reference.excerpt,
    sourceAsOf: reference.sourceAsOf,
  };
}

function chunkReference(chunk: LawChunk): RetrievedReference {
  return {
    id: chunk.id,
    lawName: chunk.lawName,
    section: chunk.section,
    sourceUrl: chunk.sourceUrl,
    revisionId: chunk.revisionId,
    excerpt: chunk.text.length > REFERENCE_EXCERPT_MAX_CHARS
      ? `${chunk.text.slice(0, REFERENCE_EXCERPT_MAX_CHARS - 3)}...`
      : chunk.text,
    sourceAsOf: chunk.sourceAsOf,
  };
}

// A deterministic numeric rule is not backed by an embedding-retrieved chunk (its citation is a
// fixed code-level fact - see DETERMINISTIC_RULE_LAW_INFO), so it needs its own reference builder
// rather than a lookup into the RAG-retrieved context.
function deterministicRuleReference(legalReferenceId: string): RetrievedReference | null {
  const info = DETERMINISTIC_RULE_LAW_INFO[legalReferenceId];
  if (!info) return null;
  return {
    id: legalReferenceId,
    lawName: info.lawName,
    section: info.section,
    sourceUrl: info.sourceUrl,
    revisionId: null,
    excerpt: null,
    sourceAsOf: null,
  };
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Saves each paid Claude result, so retrying after a later step fails does not pay for it again.
async function reuseOrCompute<T>(store: DataStore, key: string, compute: () => Promise<T>) {
  const saved = await store.getAiResult(key);
  if (saved !== null) return { value: saved as T, reused: true };
  const value = await compute();
  await store.saveAiResult(key, value, new Date(Date.now() + AI_RESULT_TTL_MS));
  return { value, reused: false };
}

async function providerVerdict(
  clause: ContractClause,
  fullText: string,
  store: DataStore,
  scope: AiResultScope,
  useFixture: boolean,
): Promise<{ verdict: ProviderVerdict; references: RetrievedReference[]; reused: boolean; checks: DeterministicCheck[] }> {
  const checks = computeDeterministicChecks(clause, fullText, scope.preferences);
  if (env.analysisProvider !== "anthropic") {
    // Replays the real Claude output captured once for the known fixture contract (see
    // fixture-analysis.service.ts) instead of spending a live call - useful for frontend work
    // without a per-request bill. Anything that isn't that exact contract, or a clause the capture
    // didn't cover, falls back to the free deterministic heuristic below.
    if (useFixture) {
      const entry = fixtureVerdict(clause.id);
      if (entry) return { verdict: entry.verdict, references: entry.references, reused: true, checks };
    }
    const verdict = deterministicVerdict(clause, fullText, scope.preferences);
    return {
      verdict,
      references: verdict.legalReferenceIds
        .map((id) => deterministicRuleReference(id))
        .filter((reference): reference is RetrievedReference => Boolean(reference)),
      reused: false,
      checks,
    };
  }
  // `checks` is derived from fullText (other clauses can supply the monthly rent behind this
  // clause's guarantee cap, for example), which is not otherwise part of this cache key, so it must
  // be included explicitly - otherwise a later contract whose other clauses changed could reuse a
  // verdict computed against stale deterministic facts.
  const key = sha256({
    kind: "clause-verdict",
    request: VERDICT_REQUEST_FINGERPRINT,
    ...scope,
    clauseText: clause.text,
    deterministicChecks: checks,
  });
  const { value, reused } = await reuseOrCompute(store, key, async () => {
    const lawSections = await retrieveLawCorpus(await embedText(clause.text), 5);
    return {
      verdict: await analyzeWithClaude(clause, lawSections, scope.preferences, checks),
      references: lawSections.map(chunkReference),
    };
  });
  return { ...value, reused, checks };
}

function toFinding(
  clause: ContractClause,
  verdict: ProviderVerdict,
  context: RetrievedReference[],
  checks: DeterministicCheck[],
): Finding {
  // A failed deterministic check (a numeric legal limit computed in code, not by the model - see
  // computeDeterministicChecks) always wins: the model can add to it but can never soften it away.
  // This is the "do not let the LLM invent these values" / "do not downgrade a strong legal
  // conflict" guarantee from the brief, enforced in code rather than trusted to prompting alone.
  const failedCheck = checks.find((check) => !check.passesRule);
  const legalAssessment = failedCheck
    ? { ...verdict.legalAssessment, violatesLaw: true }
    : verdict.legalAssessment;
  const legalReferenceIds = failedCheck && !verdict.legalReferenceIds.includes(failedCheck.legalReferenceId)
    ? [...verdict.legalReferenceIds, failedCheck.legalReferenceId]
    : verdict.legalReferenceIds;

  const references = legalReferenceIds
    .map((id) => context.find((item) => item.id === id) ?? deterministicRuleReference(id))
    .filter((item): item is RetrievedReference => Boolean(item))
    .map(legalReference);

  if (legalAssessment.violatesLaw && references.length === 0) {
    throw new HttpError(
      502,
      "UNSUPPORTED_LEGAL_CLAIM",
      `The analysis marked ${clause.id} as illegal without a retrieved legal reference.`,
    );
  }
  return {
    clauseId: clause.id,
    severity: classifyClause(legalAssessment),
    category: categoryForAssessment(legalAssessment),
    topic: verdict.topic,
    confidence: failedCheck ? "high" : verdict.confidence,
    title: verdict.title,
    clauseQuote: resolveClauseQuote(clause, verdict.clauseQuote),
    plainLanguageExplanation: verdict.plainLanguageExplanation,
    whyItMatters: verdict.whyItMatters,
    ...(verdict.recommendedAction ? { recommendedAction: verdict.recommendedAction } : {}),
    ...(verdict.suggestedReplacementText ? { suggestedReplacementText: verdict.suggestedReplacementText } : {}),
    explanation: verdict.explanation,
    legalAssessment,
    legalReferences: references,
    ...(checks.length ? { deterministicChecks: checks } : {}),
    relatedFindingIds: [],
    locations: clause.locations,
  };
}

// Findings about the same underlying topic (e.g. a guarantee's amount, realization terms, and
// return deadline) get cross-linked so the UI can show "related issues" instead of presenting near-
// duplicate cards as unrelated problems (section 17 of the brief). OK findings and the catch-all
// "other" topic are never linked - grouping them would not help the tenant.
function withRelatedFindingIds(findings: Finding[]): Finding[] {
  const clauseIdsByTopic = new Map<FindingTopic, string[]>();
  for (const finding of findings) {
    if (finding.severity === "OK" || finding.topic === "other") continue;
    const group = clauseIdsByTopic.get(finding.topic) ?? [];
    group.push(finding.clauseId);
    clauseIdsByTopic.set(finding.topic, group);
  }
  return findings.map((finding) => {
    const group = clauseIdsByTopic.get(finding.topic);
    if (!group || group.length < 2) return finding;
    const relatedFindingIds = group.filter((clauseId) => clauseId !== finding.clauseId);
    return relatedFindingIds.length ? { ...finding, relatedFindingIds } : finding;
  });
}

const SEVERITY_PRIORITY: Record<Finding["severity"], number> = { RED: 0, ORANGE: 1, OK: 2 };
const CONFIDENCE_PRIORITY: Record<ConfidenceLevel, number> = { high: 0, medium: 1, low: 2 };

// Default ordering for the whole findings list (section 20): most severe first, then - within the
// same severity - the findings the analysis is most sure about. A stable sort keeps clauses with
// equal priority in their original document order.
function byPriority(left: Finding, right: Finding) {
  const severityDelta = SEVERITY_PRIORITY[left.severity] - SEVERITY_PRIORITY[right.severity];
  if (severityDelta !== 0) return severityDelta;
  return CONFIDENCE_PRIORITY[left.confidence] - CONFIDENCE_PRIORITY[right.confidence];
}

function computeHeadline(summary: { critical: number; warnings: number; compliant: number }): string {
  if (summary.critical > 0) {
    return "מצאנו בחוזה סעיפים שדורשים טיפול לפני החתימה.";
  }
  if (summary.warnings > 0) {
    return "החוזה תקין ברובו, אך יש כמה סעיפים שכדאי לבדוק ולנסות לשפר לפני החתימה.";
  }
  return "לא מצאנו בעיות משמעותיות בחוזה. עדיין מומלץ לעבור על הפרטים לפני החתימה.";
}

async function protectionReport(
  clauses: ContractClause[],
  store: DataStore,
  scope: AiResultScope,
  useFixture: boolean,
): Promise<{ protections: Protection[]; reused: boolean }> {
  if (env.analysisProvider !== "anthropic") {
    if (useFixture) return { protections: fixtureProtectionReport(), reused: true };
    return { protections: evaluateProtectionChecklistDeterministically(clauses), reused: false };
  }
  const key = sha256({
    kind: "protection-report",
    request: PROTECTION_REQUEST_FINGERPRINT,
    userId: scope.userId,
    lawCorpus: scope.lawCorpus,
    clauses: clauses.map(({ id, text }) => ({ id, text })),
  });
  const { value, reused } = await reuseOrCompute(store, key, async () => {
    const checklistQuery = PROTECTION_CHECKLIST
      .map((item) => `${item.title}: ${item.description}`)
      .join("\n");
    const lawSections = await retrieveLawCorpus(await embedText(checklistQuery), 5);
    const providerReport = await analyzeProtectionsWithClaude(clauses, PROTECTION_CHECKLIST, lawSections);
    const context = lawSections.map(chunkReference);
    return providerReport.map<Protection>((item) => {
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
  });
  return { protections: value, reused };
}

async function lawCorpusFingerprint(store: DataStore): Promise<LawCorpusFingerprint> {
  if (env.analysisProvider !== "anthropic") return "deterministic-fixture-v1";
  return (await store.listLawSourceStates())
    .filter((state) => state.status === "ACTIVE")
    .map((state) => ({
      israelLawId: state.israelLawId,
      fingerprint: state.activeOfficialFingerprint,
      revisionId: state.activeRevisionId,
      contentHash: state.activeContentHash,
    }))
    .sort((left, right) => left.israelLawId - right.israelLawId);
}

function analysisInputHash(
  contract: ContractRecord,
  preferences: TenantPreferences,
  lawCorpus: LawCorpusFingerprint,
) {
  return sha256({
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    clauses: contract.clauses.map(({ id, text }) => ({ id, text })),
    preferences,
    provider: env.analysisProvider,
    lawCorpus,
  });
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
  const useFixture = env.analysisProvider === "fixture" && matchesFixtureContract(contract);
  const providerLabel = env.analysisProvider === "anthropic"
    ? `anthropic (${env.anthropicModel})`
    : env.analysisProvider === "fixture"
      ? useFixture ? "fixture (replaying captured Claude output)" : "fixture (no match, using deterministic heuristic)"
      : "deterministic";
  traceAnalysis(`Starting contract ${contractId}: ${contract.clauses.length} clauses, provider ${providerLabel}.`);
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
      traceAnalysis(`Verified law corpus is incomplete; inactive laws: ${unavailable.join(", ")}.`, "error");
      throw new HttpError(
        503,
        "INCOMPLETE_VERIFIED_LAW_CORPUS",
        "Analysis is disabled until every monitored law has an approved active version.",
        { unavailableIsraelLawIds: unavailable },
      );
    }
    traceAnalysis(`Verified law corpus ready: ${activeIds.size}/${MONITORED_LAW_SOURCES.length} laws active.`);
  }
  const lawCorpus = await lawCorpusFingerprint(store);
  const inputHash = analysisInputHash(contract, preferences, lawCorpus);
  const existing = await store.findAnalysisByInput(contractId, inputHash);
  if (existing) {
    traceAnalysis(`Same contract, preferences, and law versions were already analyzed; reusing analysis ${existing.analysisId}.`);
    return { analysis: existing, created: false };
  }
  const scope: AiResultScope = { userId, preferences, lawCorpus };

  let stage = "PII redaction";
  try {
    const started = performance.now();
    traceAnalysis("Removing personal details locally before any cloud request...");
    const redactionStarted = performance.now();
    const redaction = await redactClauses(contract.clauses);
    const redactionMs = Math.round(performance.now() - redactionStarted);
    traceAnalysis(`Redaction done in ${redactionMs} ms: ${redaction.redactedEntityCount} details removed (${redaction.mode}${redaction.model ? `, ${redaction.model}` : ""}).`);
    const fullText = redaction.clauses.map((clause) => clause.text).join("\n");

    // Headers, page numbers, and other non-substantive clauses (e.g. the document's own title line,
    // which the extractor turns into its own clause) never get a finding of their own - the
    // protection checklist still sees every clause, since a protection could in principle be stated
    // anywhere, but generating a per-clause verdict for junk content only adds cost and noise
    // (section 16 of the brief).
    const analyzableClauses = redaction.clauses.filter(isSubstantiveClause);
    const skippedClauseCount = redaction.clauses.length - analyzableClauses.length;
    if (skippedClauseCount > 0) {
      traceAnalysis(`Skipping ${skippedClauseCount} non-substantive clause(s) (headers/page numbers/document title).`);
    }

    // The protection checklist reads only the redacted clauses, so it runs alongside clause analysis.
    stage = "clause analysis and protection checklist";
    const clauseCount = analyzableClauses.length;
    traceAnalysis(`Analyzing ${clauseCount} clauses (3 at a time) and checking ${PROTECTION_CHECKLIST.length} recommended protections in parallel...`);
    const analysisStarted = performance.now();
    let completedClauses = 0;
    const verdictsPromise = mapWithConcurrency(analyzableClauses, 3, async (clause) => {
      const clauseStarted = performance.now();
      const result = await providerVerdict(clause, fullText, store, scope, useFixture);
      completedClauses += 1;
      const { legalAssessment, legalReferenceIds, title, usage } = result.verdict;
      const cited = legalReferenceIds
        .map((id) => result.references.find((reference) => reference.id === id))
        .filter((reference): reference is RetrievedReference => Boolean(reference))
        .map((reference) => `${reference.lawName}${reference.section ? ` §${reference.section}` : ""}`);
      const cost = result.reused
        ? " | reused from an earlier attempt, no new tokens"
        : usage ? ` | ${usage.inputTokens ?? "?"} input / ${usage.outputTokens ?? "?"} output tokens` : "";
      traceAnalysis(
        `[${completedClauses}/${clauseCount}] ${clause.id} -> ${classifyClause(legalAssessment)} "${title}"`
          + ` | violatesLaw=${legalAssessment.violatesLaw} riskWarning=${legalAssessment.riskWarning}`
          + ` preferenceConflict=${legalAssessment.preferenceConflict}`
          + ` | laws retrieved ${result.references.length}, cited ${cited.length ? cited.join("; ") : "none"}`
          + `${cost} | ${Math.round(performance.now() - clauseStarted)} ms`,
      );
      return result;
    });
    const protectionsPromise = (async () => {
      const protectionsStarted = performance.now();
      const { protections, reused } = await protectionReport(redaction.clauses, store, scope, useFixture);
      for (const protection of protections) {
        traceAnalysis(`  ${protection.protectionId} -> ${protection.status}${protection.relevantClauseIds.length ? ` (clauses ${protection.relevantClauseIds.join(", ")})` : ""}`);
      }
      const countStatus = (status: Protection["status"]) => protections.filter((item) => item.status === status).length;
      traceAnalysis(
        `Protection checklist done in ${Math.round(performance.now() - protectionsStarted)} ms${reused ? " (reused from an earlier attempt, no new tokens)" : ""}:`
          + ` ${countStatus("COVERED")} covered, ${countStatus("PARTIAL")} partial, ${countStatus("MISSING")} missing.`,
      );
      return protections;
    })();
    const [verdicts, protections] = await Promise.all([verdictsPromise, protectionsPromise]);
    const findings = withRelatedFindingIds(
      analyzableClauses
        .map((clause, index) =>
          toFinding(clause, verdicts[index]!.verdict, verdicts[index]!.references, verdicts[index]!.checks))
        .sort(byPriority),
    );
    const incompleteProtections = protections.filter((item) => item.status !== "COVERED");
    const analysisMs = Math.round(performance.now() - analysisStarted);

    stage = "marked PDF generation";
    const analysisId = randomUUID();
    const pdfStarted = performance.now();
    const source = await readFile(path.join(env.uploadDirectory, contract.storageKey));
    const markedPdfStorageKey = await createMarkedPdf(source, analysisId, findings);
    const pdfMs = Math.round(performance.now() - pdfStarted);
    traceAnalysis(`Marked PDF created in ${pdfMs} ms.`);
    const createdAt = new Date().toISOString();
    const pipelineMs = Math.round(performance.now() - started);
    const totalMs = (contract.extractionMs ?? 0) + pipelineMs;
    const summary = {
      critical: findings.filter((finding) => finding.severity === "RED").length,
      warnings: findings.filter((finding) => finding.severity === "ORANGE").length,
      compliant: findings.filter((finding) => finding.severity === "OK").length,
    };
    // findings is already sorted by priority (byPriority above), so the first few non-OK entries
    // are exactly the most important issues to lead with (sections 19-20 of the brief).
    const keyFindingIds = findings
      .filter((finding) => finding.severity !== "OK")
      .slice(0, 5)
      .map((finding) => finding.clauseId);
    const record: AnalysisRecord = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      analysisId,
      contractId,
      status: "COMPLETED",
      summary,
      headline: computeHeadline(summary),
      keyFindingIds,
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

    stage = "saving results";
    try {
      await store.createAnalysis(record);
      await store.updateContract({ ...contract, status: "ANALYZED", updatedAt: createdAt });
    } catch (error) {
      await rm(path.join(env.markedPdfDirectory, markedPdfStorageKey), { force: true });
      if (error instanceof Error && "code" in error && error.code === 11_000) {
        const raced = await store.findAnalysisByInput(contractId, inputHash);
        if (raced?.userId === userId) {
          traceAnalysis(`A parallel request saved this analysis first; reusing ${raced.analysisId}.`);
          return { analysis: raced, created: false };
        }
      }
      throw error;
    }
    const { timingMs } = record;
    traceAnalysis(
      `Done: ${summary.critical} critical, ${summary.warnings} warnings, ${summary.compliant} compliant.`
        + ` Total ${timingMs.total} ms (extraction ${timingMs.extraction}, redaction ${timingMs.redaction},`
        + ` retrieval+analysis ${timingMs.retrievalAndAnalysis}, PDF ${timingMs.pdfGeneration});`
        + ` target ${timingMs.target} ms ${timingMs.targetMet ? "met" : "missed"}. Analysis ${analysisId}.`,
    );
    return { analysis: record, created: true };
  } catch (error) {
    traceAnalysisFailure(stage, error);
    throw error;
  }
}

export function publicAnalysis(record: AnalysisRecord) {
  const { userId: _userId, createdAt, ...result } = record;
  return { ...result, createdAt };
}
