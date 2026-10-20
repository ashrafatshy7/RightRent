import { randomUUID } from "node:crypto";
import type { AddressForm, NegotiationIssue, NegotiationRecord } from "../../domain/models.js";
import type { ClaudeContentBlock } from "../analyses/ai-providers.js";
import { currentIssueId, type AgentModel } from "./negotiation-agent.js";
import { defaultPriorities, issueById } from "./negotiation-grounding.js";

// A stand-in for Claude when ANALYSIS_PROVIDER is not anthropic (tests and offline development).
// It answers with fixed Hebrew text and calls the same tools Claude would, so every turn still
// goes through the real state machine and the real draft checks.

type Block = ClaudeContentBlock;

const text = (value: string): Block => ({ type: "text", text: value });
const call = (name: string, input: unknown): Block => ({ type: "tool_use", id: `toolu_${randomUUID()}`, name, input });
const quickReplies = (options: string[]) => call("offer_quick_replies", { options });

const CHOICES = { law: "להסתמך על החוק", alternative: "להציע חלופה", concede: "לוותר על הנושא" };

function lastUserContent(messages: unknown[]) {
  const last = messages.at(-1) as { content?: Array<{ type?: string; text?: string }> } | undefined;
  return last?.content ?? [];
}

function tenantText(content: Array<{ type?: string; text?: string }>) {
  const raw = content.find((block) => block.type === "text")?.text ?? "";
  return /<TENANT_MESSAGE>\n([\s\S]*)\n<\/TENANT_MESSAGE>/u.exec(raw)?.[1] ?? raw;
}

function addressFormIn(answer: string): AddressForm | null {
  if (/נקבה/u.test(answer)) return "FEMININE";
  if (/רבים/u.test(answer)) return "PLURAL";
  if (/זכר/u.test(answer)) return "MASCULINE";
  return null;
}

function issueOptions(issue: NegotiationIssue) {
  return [
    ...(issue.legalReferences.length ? [CHOICES.law] : []),
    CHOICES.alternative,
    CHOICES.concede,
  ];
}

function describeIssue(issue: NegotiationIssue) {
  return `הנושא הבא: ${issue.title}.\n${issue.summary}\nאיך תרצו לגשת אליו? אפשר לבחור ${issueOptions(issue).join(" / ")}, או לכתוב במילים שלכם מה אתם רוצים.`;
}

function draftFor(record: NegotiationRecord) {
  const plural = record.addressForm === "PLURAL";
  const raised = record.priorities
    .map((issueId) => issueById(record, issueId))
    .filter((issue): issue is NegotiationIssue => issue !== null && record.strategies[issue.issueId]?.kind !== "CONCEDE");
  const lines = raised.map((issue, index) => `${index + 1}. ${issue.title}: ${record.strategies[issue.issueId]!.request}`);
  return {
    message: [
      "שלום,",
      plural
        ? "תודה ששלחת את חוזה השכירות. עברנו עליו ונשמח לסכם כמה התאמות לפני החתימה:"
        : "תודה ששלחת את חוזה השכירות. עברתי עליו ואשמח לסכם כמה התאמות לפני החתימה:",
      ...lines,
      plural ? "נשמח לדבר ולמצוא יחד פתרון שמתאים לכולנו. תודה!" : "אשמח לדבר ולמצוא יחד פתרון שמתאים לשנינו. תודה!",
    ].join("\n"),
    requests: raised.map((issue) => ({
      issueId: issue.issueId,
      lawReferenceIds: issue.legalReferences.slice(0, 5).map((reference) => reference.lawReferenceId),
    })),
  };
}

// The script understands only its own quick replies. Anything else the tenant writes is taken as
// their ask, word for word, so the draft still says what they said.
function strategyFor(issue: NegotiationIssue, answer: string) {
  const base = { issueId: issue.issueId, fallback: null, concessionConfirmed: false, confirmedByTenant: true };
  const text = answer.trim();
  if (text === CHOICES.concede) return { ...base, kind: "CONCEDE", request: null, concessionConfirmed: true };
  const reference = issue.legalReferences.find((item) => item.section) ?? issue.legalReferences[0];
  if (text === CHOICES.law && reference) {
    return {
      ...base,
      kind: "CITE_LAW",
      request: reference.section
        ? `אבקש לתקן את הנושא כך שיתאים לסעיף ${reference.section} ל${reference.lawName}.`
        : `אבקש לתקן את הנושא כך שיתאים ל${reference.lawName}.`,
    };
  }
  if (text === CHOICES.alternative) {
    return { ...base, kind: "PROPOSE_ALTERNATIVE", request: issue.suggestedText ?? "אבקש שנמצא יחד נוסח מאוזן שמגן על שני הצדדים." };
  }
  return { ...base, kind: /חוק/u.test(text) && reference ? "CITE_LAW" : "PROPOSE_ALTERNATIVE", request: text };
}

// The reply after tools ran: say where the negotiation stands and what comes next.
function followUp(record: NegotiationRecord): Block[] {
  if (record.state === "PRIORITIZE") {
    const titles = defaultPriorities(record.issues).map((issueId, index) => `${index + 1}. ${issueById(record, issueId)!.title}`);
    return [text(`מעולה. זה סדר העדיפויות שאני מציע, מהחמור ביותר:\n${titles.join("\n")}\nלהשאיר את הסדר הזה?`), quickReplies(["הסדר מתאים לי"])];
  }
  if (record.state === "STRATEGY") {
    const issue = issueById(record, currentIssueId(record)!)!;
    return [text(describeIssue(issue)), quickReplies(issueOptions(issue))];
  }
  if (record.state === "DRAFT" && !record.draft) return [call("submit_draft", draftFor(record))];
  if (record.state === "DRAFT") {
    return [text("הטיוטה מוכנה בחלונית ההודעה. אפשר לערוך אותה ישירות או לכתוב לי מה לשנות."), quickReplies(["מאשר/ת את ההודעה"])];
  }
  if (record.state === "COUNTER") {
    return [text("הכנתי תגובות אפשריות לתשובות של המשכיר. כשתסיימו לעבור עליהן, נסגור."), quickReplies(["סיימתי"])];
  }
  return [text("בהצלחה במשא ומתן!")];
}

function answerTenant(record: NegotiationRecord, answer: string): Block[] {
  if (record.state === "PRIORITIZE" && !record.addressForm) {
    const form = addressFormIn(answer);
    return form
      ? [call("set_address_form", { form })]
      : [text("לא הבנתי. איך לפנות אליך?"), quickReplies(["בלשון זכר", "בלשון נקבה", "בלשון רבים"])];
  }
  if (record.state === "PRIORITIZE") return [call("set_priorities", { issueIds: defaultPriorities(record.issues) })];
  if (record.state === "STRATEGY") return [call("record_strategy", strategyFor(issueById(record, currentIssueId(record)!)!, answer))];
  if (record.state === "DRAFT") {
    return /מאשר|אישור/u.test(answer)
      ? [call("finalize_draft", {})]
      : [text("אפשר לערוך את ההודעה ישירות בחלונית, או לכתוב לי מה לשנות."), quickReplies(["מאשר/ת את ההודעה"])];
  }
  if (record.state === "COUNTER") return [call("complete_negotiation", {})];
  return followUp(record);
}

export const scriptedAgentModel: AgentModel = async ({ messages, record }, onText) => {
  const content = lastUserContent(messages);
  const afterTools = content.length > 0 && content.every((block) => block.type === "tool_result");
  const blocks = afterTools ? followUp(record) : answerTenant(record, tenantText(content));
  for (const block of blocks) if (block.type === "text") onText(block.text);
  return { content: blocks, stopReason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn" };
};
