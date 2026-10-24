import { randomUUID } from "node:crypto";
import type {
  AnalysisRecord,
  NegotiationChatMessage,
  NegotiationIssue,
  NegotiationRecord,
} from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { redactClauses } from "../analyses/anonymization.service.js";
import { prepareLikelyReplies } from "./likely-replies.js";
import {
  claudeAgentModel,
  currentIssueId,
  finalizeDraft,
  moveTo,
  runAgentTurn,
  tenantTurnContent,
  usesClaude,
  type AgentDependencies,
} from "./negotiation-agent.js";
import { buildNegotiationContext, preferencesForTopic } from "./negotiation-context.js";
import { defaultPriorities, negotiationIssues, tenantDraftWarnings } from "./negotiation-grounding.js";
import { scriptedAgentModel } from "./scripted-agent-model.js";

// The service never contacts a landlord and never sends a message: it prepares text the tenant
// reviews, edits, and sends themselves.

const MAX_TENANT_TURNS = 60;

// One turn at a time per negotiation, so two tabs cannot interleave tool calls.
const busy = new Set<string>();

async function exclusively<T>(analysisId: string, work: () => Promise<T>) {
  if (busy.has(analysisId)) {
    throw new HttpError(409, "NEGOTIATION_BUSY", "The negotiation is still answering the previous message.");
  }
  busy.add(analysisId);
  try {
    return await work();
  } finally {
    busy.delete(analysisId);
  }
}

async function ownedAnalysis(analysisId: string, userId: string) {
  const analysis = await (await getStore()).getAnalysis(analysisId);
  if (!analysis || analysis.userId !== userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  return analysis;
}

// Records from an earlier agent cannot be continued; they count as not started.
function isCurrent(record: NegotiationRecord | null): record is NegotiationRecord {
  return record?.agentVersion === 3;
}

async function currentNegotiation(analysisId: string, userId: string) {
  await ownedAnalysis(analysisId, userId);
  const record = await (await getStore()).getNegotiation(analysisId);
  if (!isCurrent(record) || record.userId !== userId) {
    throw new HttpError(404, "NEGOTIATION_NOT_FOUND", "The negotiation was not started.");
  }
  return record;
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

async function redactTexts(texts: string[]) {
  if (!texts.length) return [];
  const clauses = texts.map((text, index) => ({ id: `NEGOTIATION_TEXT_${index}`, text, locations: [] }));
  return (await redactClauses(clauses)).clauses.map((clause) => clause.text);
}

async function redactText(text: string) {
  return (await redactTexts([text]))[0]!;
}

function agentMessage(text: string, quickReplies: string[] = []): NegotiationChatMessage {
  return { id: randomUUID(), role: "AGENT", text, quickReplies, createdAt: new Date().toISOString() };
}

function countPhrase(count: number, one: string, many: (count: number) => string) {
  return count === 1 ? one : many(count);
}

// The opening is fixed text: it is instant, costs nothing, and its numbers come straight from the
// analysis. The model receives it with the tenant's first answer.
function openingMessage(issues: NegotiationIssue[]) {
  const red = issues.filter((issue) => issue.severity === "RED").length;
  const orange = issues.filter((issue) => issue.severity === "ORANGE").length;
  const missing = issues.filter((issue) => issue.severity === "SUGGESTION").length;
  const found = [
    red ? countPhrase(red, "סעיף אחד שעלול לסתור את החוק", (count) => `${count} סעיפים שעלולים לסתור את החוק`) : null,
    orange ? countPhrase(orange, "סעיף אחד שכדאי לשפר", (count) => `${count} סעיפים שכדאי לשפר`) : null,
    missing ? countPhrase(missing, "הגנה אחת שחסרה בחוזה", (count) => `${count} הגנות שחסרות בחוזה`) : null,
  ].filter((part): part is string => Boolean(part));
  // Hebrew writes "and" as a prefix, with a maqaf before a digit ("ו־6").
  const and = (part: string) => (/^\d/u.test(part) ? `ו־${part}` : `ו${part}`);
  const listed = found.length > 1 ? `${found.slice(0, -1).join(", ")} ${and(found.at(-1)!)}` : found[0];
  return agentMessage([
    "שלום! אני הסוכן של RightRent, ואעזור לכם להכין את השיחה עם המשכיר.",
    `בניתוח החוזה מצאתי ${listed}.`,
    "נעבור על זה יחד: נקבע מה הכי חשוב לכם, נבחר איך לגשת לכל נושא, ובסוף אנסח הודעת WhatsApp אחת למשכיר. את ההודעה אתם בודקים, עורכים ושולחים בעצמכם - אני לא פונה למשכיר.",
    "לפני שנתחיל: איך לפנות אליך?",
  ].join("\n"), ["בלשון זכר", "בלשון נקבה", "בלשון רבים"]);
}

function dependencies(record: NegotiationRecord): AgentDependencies {
  return {
    proposedPriorities: defaultPriorities(record.issues),
    prepareLikelyReplies: async (current) => {
      const draft = current.draft!;
      // An agent draft is built only from redacted material; a tenant's own edit is not.
      const safeDraft = draft.editedByTenant ? await redactText(draft.text) : draft.text;
      return prepareLikelyReplies(current, safeDraft, usesClaude());
    },
  };
}

export function publicNegotiation(record: NegotiationRecord) {
  const issue = (issueId: string) => record.issues.find((item) => item.issueId === issueId);
  return {
    id: record.id,
    analysisId: record.analysisId,
    state: record.state,
    addressForm: record.addressForm,
    issues: record.issues.map(({ issueId, kind, severity, title, summary, legalReferences }) => ({
      issueId,
      kind,
      severity,
      title,
      summary,
      legalReferences: legalReferences.map(({ lawReferenceId, lawName, section, sourceUrl }) => ({
        lawReferenceId,
        lawName,
        section,
        sourceUrl,
      })),
    })),
    priorities: record.priorities,
    strategies: record.strategies,
    currentIssueId: currentIssueId(record),
    draft: record.draft
      ? {
          text: record.draft.text,
          editedByTenant: record.draft.editedByTenant,
          warnings: record.draft.warnings,
          // The legal sources behind the message, for the tenant to check before sending.
          sources: record.draft.requests.flatMap(({ issueId, lawReferenceIds }) => {
            const raised = issue(issueId);
            const references = (raised?.legalReferences ?? [])
              .filter((reference) => lawReferenceIds.includes(reference.lawReferenceId))
              .map(({ lawReferenceId, lawName, section, sourceUrl, excerpt }) => ({
                lawReferenceId,
                lawName,
                section,
                sourceUrl,
                excerpt,
              }));
            return raised && references.length ? [{ issueId, title: raised.title, references }] : [];
          }),
        }
      : null,
    likelyReplies: record.likelyReplies,
    messages: record.messages,
    turnsLeft: Math.max(0, MAX_TENANT_TURNS - record.tenantTurns),
    // SCRIPTED is the offline stand-in (no Claude); the page says so instead of passing it off as the agent.
    agentMode: usesClaude() ? "CLAUDE" as const : "SCRIPTED" as const,
    updatedAt: record.updatedAt,
  };
}

export type PublicNegotiation = ReturnType<typeof publicNegotiation>;

// null when the tenant has not started one for this analysis.
export async function getNegotiation(analysisId: string, userId: string) {
  await ownedAnalysis(analysisId, userId);
  const record = await (await getStore()).getNegotiation(analysisId);
  return isCurrent(record) && record.userId === userId ? publicNegotiation(record) : null;
}

async function newNegotiation(analysis: AnalysisRecord, userId: string): Promise<NegotiationRecord> {
  if (!negotiationIssues(analysis).length) {
    throw new HttpError(409, "NO_NEGOTIABLE_FINDINGS", "This analysis contains no issues to negotiate.");
  }
  const contract = await (await getStore()).getContract(analysis.contractId);
  const { context, redactedNotes } = await buildNegotiationContext(analysis, contract, redactTexts);
  const issues = negotiationIssues(analysis, (finding) =>
    preferencesForTopic(analysis.preferencesSnapshot, redactedNotes, finding.topic));
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    userId,
    analysisId: analysis.analysisId,
    agentVersion: 3,
    context,
    state: "PRIORITIZE",
    addressForm: null,
    issues,
    priorities: [],
    strategies: {},
    draft: null,
    likelyReplies: [],
    messages: [openingMessage(issues)],
    modelMessages: [],
    pendingToolResults: [],
    tenantTurns: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// Returns the existing conversation, or starts one. `restart` throws the old one away.
export async function startNegotiation(analysisId: string, userId: string, restart: boolean) {
  return exclusively(analysisId, async () => {
    const analysis = await ownedAnalysis(analysisId, userId);
    const store = await getStore();
    const existing = await store.getNegotiation(analysisId);
    if (!restart && isCurrent(existing) && existing.userId === userId) return publicNegotiation(existing);
    const record = await newNegotiation(analysis, userId);
    await store.upsertNegotiation(record);
    return publicNegotiation(record);
  });
}

export type NegotiationStreamEvent =
  | { type: "text"; delta: string }
  | { type: "negotiation"; negotiation: PublicNegotiation };

export async function sendTenantMessage(
  analysisId: string,
  userId: string,
  text: string,
  emit: (event: NegotiationStreamEvent) => void,
) {
  return exclusively(analysisId, async () => {
    const record = await currentNegotiation(analysisId, userId);
    if (record.state === "DONE") {
      throw new HttpError(409, "NEGOTIATION_DONE", "The negotiation is complete. Start over to prepare a new message.");
    }
    if (record.tenantTurns >= MAX_TENANT_TURNS) {
      throw new HttpError(429, "NEGOTIATION_TURN_LIMIT", "This negotiation reached its message limit. Start over to continue.");
    }

    // Personal details are removed locally before anything reaches the model; the tenant still
    // sees what they wrote.
    const redactedText = await redactText(text);
    const redactedDraftEdit = record.draft?.editedByTenant ? await redactText(record.draft.text) : null;
    const withTenantMessage: NegotiationRecord = {
      ...record,
      messages: [...record.messages, {
        id: randomUUID(),
        role: "TENANT",
        text,
        quickReplies: [],
        createdAt: new Date().toISOString(),
      }],
      tenantTurns: record.tenantTurns + 1,
    };
    const agentDependencies = dependencies(record);
    const content = tenantTurnContent(
      withTenantMessage,
      redactedText,
      redactedDraftEdit,
      agentDependencies.proposedPriorities,
      record.modelMessages.length ? null : record.messages[0]?.text ?? null,
    );
    const answered = await runAgentTurn(
      withTenantMessage,
      content,
      usesClaude() ? claudeAgentModel : scriptedAgentModel,
      agentDependencies,
      (event) => emit(event.type === "text" ? event : { type: "negotiation", negotiation: publicNegotiation(event.record) }),
    );
    const saved = { ...answered, updatedAt: new Date().toISOString() };
    await (await getStore()).upsertNegotiation(saved);
    return publicNegotiation(saved);
  });
}

// The tenant's own edit of the draft. It is kept as written; the same checks the agent's drafts
// must pass are shown as warnings, since the tenant decides what to send.
export async function saveDraftEdit(analysisId: string, userId: string, text: string) {
  return exclusively(analysisId, async () => {
    const record = await currentNegotiation(analysisId, userId);
    requireState(record, "DRAFT");
    if (!record.draft) throw new HttpError(409, "NEGOTIATION_NO_DRAFT", "The agent has not prepared a draft yet.");
    const saved: NegotiationRecord = {
      ...record,
      draft: { ...record.draft, text, editedByTenant: true, warnings: tenantDraftWarnings(record, text) },
      updatedAt: new Date().toISOString(),
    };
    await (await getStore()).upsertNegotiation(saved);
    return publicNegotiation(saved);
  });
}

export async function finalizeNegotiationDraft(analysisId: string, userId: string) {
  return exclusively(analysisId, async () => {
    const record = await currentNegotiation(analysisId, userId);
    requireState(record, "DRAFT");
    if (!record.draft) throw new HttpError(409, "NEGOTIATION_NO_DRAFT", "The agent has not prepared a draft yet.");
    const finalized = await finalizeDraft(record, dependencies(record));
    const saved: NegotiationRecord = {
      ...finalized,
      messages: [...finalized.messages, agentMessage(
        "ההודעה נעולה ומוכנה לשליחה. הכנתי גם תגובות אפשריות לתשובות של המשכיר - אפשר לשאול אותי עליהן.",
        ["סיימתי"],
      )],
      updatedAt: new Date().toISOString(),
    };
    await (await getStore()).upsertNegotiation(saved);
    return publicNegotiation(saved);
  });
}

export async function completeNegotiation(analysisId: string, userId: string) {
  return exclusively(analysisId, async () => {
    const record = await currentNegotiation(analysisId, userId);
    requireState(record, "COUNTER");
    const saved: NegotiationRecord = {
      ...moveTo(record, "DONE"),
      messages: [...record.messages, agentMessage("בהצלחה במשא ומתן! ההודעה נשארת כאן אם תצטרכו אותה שוב.")],
      updatedAt: new Date().toISOString(),
    };
    await (await getStore()).upsertNegotiation(saved);
    return publicNegotiation(saved);
  });
}
