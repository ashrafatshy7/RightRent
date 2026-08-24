import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type {
  AnalysisRecord,
  Finding,
  NegotiationRecord,
  NegotiationStrategy,
} from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { generateLikelyLandlordReplies, generateNegotiationDraft } from "../analyses/ai-providers.js";
import { redactClauses } from "../analyses/anonymization.service.js";

type NegotiationAction =
  | { action: "START" }
  | { action: "SET_PRIORITIES"; clauseIds: string[] }
  | { action: "CHOOSE_STRATEGY"; clauseId: string; strategy: NegotiationStrategy }
  | { action: "SAVE_DRAFT"; draft: string }
  | { action: "COMPLETE" };

function negotiableFindings(analysis: AnalysisRecord) {
  return analysis.findings.filter((finding) => finding.severity !== "OK");
}

function findingById(analysis: AnalysisRecord, clauseId: string) {
  const finding = negotiableFindings(analysis).find((item) => item.clauseId === clauseId);
  if (!finding) throw new HttpError(400, "UNKNOWN_NEGOTIATION_ISSUE", `No negotiable finding matches ${clauseId}.`);
  return finding;
}

function issueSentence(finding: Finding, strategy: NegotiationStrategy) {
  if (strategy === "CONCEDE") return null;
  const reference = finding.legalReferences[0];
  if (strategy === "CITE_LAW" && reference) {
    return `בנוגע ל${finding.title}, אבקש לתקן את הסעיף בהתאם לסעיף ${reference.section ?? reference.lawReferenceId} לחוק.`;
  }
  return `בנוגע ל${finding.title}, אבקש שנמצא נוסח חלופי מאוזן שמגן על שני הצדדים.`;
}

function draftMessage(analysis: AnalysisRecord, negotiation: NegotiationRecord) {
  const requests = negotiation.priorities
    .map((clauseId) => issueSentence(findingById(analysis, clauseId), negotiation.strategies[clauseId]!))
    .filter((sentence): sentence is string => Boolean(sentence));
  return [
    "שלום, תודה על שליחת חוזה השכירות.",
    "עברתי עליו ואשמח להסכים על כמה התאמות לפני החתימה:",
    ...requests.map((request, index) => `${index + 1}. ${request}`),
    "אשמח לדבר ולמצוא פתרון הוגן ונוח לשנינו. תודה!",
  ].join("\n");
}

function publicNegotiation(record: NegotiationRecord, analysis: AnalysisRecord) {
  const currentClauseId = record.state === "STRATEGY"
    ? record.priorities.find((id) => !record.strategies[id]) ?? null
    : null;
  return {
    id: record.id,
    analysisId: record.analysisId,
    state: record.state,
    priorities: record.priorities,
    strategies: record.strategies,
    draft: record.draft,
    likelyReplies: record.likelyReplies,
    currentIssue: currentClauseId ? findingById(analysis, currentClauseId) : null,
    strategyOptions: currentClauseId ? ["CITE_LAW", "PROPOSE_ALTERNATIVE", "CONCEDE"] : [],
    updatedAt: record.updatedAt,
  };
}

function requireState(record: NegotiationRecord, expected: NegotiationRecord["state"]) {
  if (record.state !== expected) {
    throw new HttpError(
      409,
      "INVALID_NEGOTIATION_TRANSITION",
      `Action is valid only in ${expected}; current state is ${record.state}.`,
    );
  }
}

export async function getNegotiation(analysisId: string, userId: string) {
  const store = await getStore();
  const analysis = await store.getAnalysis(analysisId);
  if (!analysis || analysis.userId !== userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  const negotiation = await store.getNegotiation(analysisId);
  if (!negotiation) throw new HttpError(404, "NEGOTIATION_NOT_FOUND", "The negotiation was not started.");
  return publicNegotiation(negotiation, analysis);
}

export async function advanceNegotiation(analysisId: string, userId: string, action: NegotiationAction) {
  const store = await getStore();
  const analysis = await store.getAnalysis(analysisId);
  if (!analysis || analysis.userId !== userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  const findings = negotiableFindings(analysis);
  if (!findings.length) {
    throw new HttpError(409, "NO_NEGOTIABLE_FINDINGS", "This analysis contains no critical issues or warnings.");
  }

  let negotiation = await store.getNegotiation(analysisId);
  const now = new Date().toISOString();
  if (action.action === "START") {
    negotiation ??= {
      id: randomUUID(),
      userId,
      analysisId,
      state: "PRIORITIZE",
      priorities: [...findings]
        .sort((left, right) => ({ RED: 0, ORANGE: 1, OK: 2 })[left.severity] - ({ RED: 0, ORANGE: 1, OK: 2 })[right.severity])
        .map((finding) => finding.clauseId),
      strategies: {},
      draft: null,
      likelyReplies: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.upsertNegotiation(negotiation);
    return publicNegotiation(negotiation, analysis);
  }

  if (!negotiation) {
    throw new HttpError(409, "NEGOTIATION_NOT_STARTED", "Start the negotiation before advancing it.");
  }

  if (action.action === "SET_PRIORITIES") {
    requireState(negotiation, "PRIORITIZE");
    if (new Set(action.clauseIds).size !== action.clauseIds.length) {
      throw new HttpError(400, "DUPLICATE_NEGOTIATION_ISSUE", "Each priority may appear only once.");
    }
    action.clauseIds.forEach((id) => findingById(analysis, id));
    negotiation = { ...negotiation, priorities: action.clauseIds, state: "STRATEGY", updatedAt: now };
  } else if (action.action === "CHOOSE_STRATEGY") {
    requireState(negotiation, "STRATEGY");
    if (!negotiation.priorities.includes(action.clauseId)) {
      throw new HttpError(400, "UNKNOWN_NEGOTIATION_ISSUE", "The issue is not in the selected priorities.");
    }
    const strategies = { ...negotiation.strategies, [action.clauseId]: action.strategy };
    const complete = negotiation.priorities.every((id) => strategies[id]);
    negotiation = { ...negotiation, strategies, state: complete ? "DRAFT" : "STRATEGY", updatedAt: now };
    if (complete) {
      const draft = env.analysisProvider === "anthropic"
        ? await generateNegotiationDraft(analysis.findings, negotiation.priorities, negotiation.strategies)
        : draftMessage(analysis, negotiation);
      negotiation = { ...negotiation, draft };
    }
  } else if (action.action === "SAVE_DRAFT") {
    requireState(negotiation, "DRAFT");
    const safeDraft = redactClauses([{
      id: "DRAFT",
      text: action.draft,
      locations: [],
    }]).clauses[0]!.text;
    const likelyReplies = env.analysisProvider === "anthropic"
      ? await generateLikelyLandlordReplies(safeDraft)
      : [
          "המשכיר מסכים לכל הבקשות — אשרו שהנוסח המתוקן מופיע בחוזה לפני חתימה.",
          "המשכיר מסכים חלקית — חזרו על הבקשה החשובה ביותר והציעו חלופה ממוקדת.",
          "המשכיר מסרב — שקלו אם הסיכון מקובל עליכם או פנו לייעוץ משפטי מוסמך.",
        ];
    negotiation = {
      ...negotiation,
      draft: action.draft,
      state: "COUNTER",
      likelyReplies,
      updatedAt: now,
    };
  } else {
    requireState(negotiation, "COUNTER");
    negotiation = { ...negotiation, state: "DONE", updatedAt: now };
  }

  await store.upsertNegotiation(negotiation);
  return publicNegotiation(negotiation, analysis);
}
