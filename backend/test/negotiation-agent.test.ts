import assert from "node:assert/strict";
import { test } from "node:test";
import type { NegotiationIssue, NegotiationRecord, NegotiationState } from "../src/domain/models.js";
import type { ClaudeContentBlock } from "../src/modules/analyses/ai-providers.js";
import {
  allowedTools,
  executeTool,
  moveTo,
  runAgentTurn,
  TRANSITIONS,
  type AgentDependencies,
  type AgentModel,
} from "../src/modules/negotiations/negotiation-agent.js";
import { contractTermLines, preferenceLines } from "../src/modules/negotiations/negotiation-context.js";
import {
  agentDraftProblems,
  groundedNumbers,
  numbersIn,
  tenantDraftWarnings,
} from "../src/modules/negotiations/negotiation-grounding.js";

const guarantee: NegotiationIssue = {
  issueId: "C002",
  kind: "CLAUSE",
  severity: "RED",
  title: "ערבות בנקאית גבוהה מהמותר",
  summary: "החוזה דורש ערבות של 30,000 ₪.",
  whyItMatters: null,
  contractSection: "7",
  clauseQuote: "The tenant shall provide a bank guarantee of ILS 30000.",
  suggestedText: "השוכר ימסור ערבות בסך 18,000 ₪.",
  facts: ["ערבות: בחוזה 30,000 ₪, המקסימום לפי החוק 18,000 ₪ - חורג מהמותר בחוק."],
  flaggedBecause: ["סותר את החוק"],
  explanation: null,
  recommendedAction: null,
  relevantPreferences: [],
  legalReferences: [{
    lawReferenceId: "law-25i",
    lawName: "חוק השכירות והשאילה",
    section: "25י",
    sourceUrl: "https://example.org/law",
    revisionId: 1,
    excerpt: "הבטוחה לא תעלה על שלושה חודשי שכירות.",
    sourceAsOf: "2026-01-01",
  }],
};

const pets: NegotiationIssue = {
  issueId: "C005",
  kind: "CLAUSE",
  severity: "ORANGE",
  title: "איסור על חיות מחמד",
  summary: "החוזה אוסר להחזיק חיות.",
  whyItMatters: null,
  contractSection: null,
  clauseQuote: null,
  suggestedText: "יותר להחזיק חתול אחד.",
  facts: [],
  flaggedBecause: ["מתנגש עם ההעדפות של השוכר"],
  explanation: null,
  recommendedAction: null,
  relevantPreferences: ["חיית מחמד: חייב שהחוזה יאפשר"],
  legalReferences: [],
};

function record(overrides: Partial<NegotiationRecord> = {}): NegotiationRecord {
  return {
    id: "n1",
    userId: "u1",
    analysisId: "a1",
    agentVersion: 3,
    context: { preferences: [], contractTerms: [], clauses: [] },
    state: "PRIORITIZE",
    addressForm: null,
    issues: [guarantee, pets],
    priorities: [],
    strategies: {},
    draft: null,
    likelyReplies: [],
    messages: [],
    modelMessages: [],
    pendingToolResults: [],
    tenantTurns: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  };
}

const dependencies: AgentDependencies = {
  proposedPriorities: ["C002", "C005"],
  prepareLikelyReplies: async () => [{ issueId: null, landlordReply: "המשכיר מסכים.", suggestedResponse: "תודה." }],
};

const inDraft = () => record({
  state: "DRAFT",
  addressForm: "FEMININE",
  priorities: ["C002", "C005"],
  strategies: {
    C002: { kind: "CITE_LAW", request: "אבקש להעמיד את הערבות על 18,000 ₪.", fallback: null },
    C005: { kind: "PROPOSE_ALTERNATIVE", request: "אבקש לאפשר חתול אחד.", fallback: null },
  },
});

const validDraft = {
  text: "שלום,\nתודה על החוזה. עברתי עליו ואשמח לשתי התאמות:\n1. לפי סעיף 25י לחוק השכירות והשאילה, אבקש להעמיד את הערבות על 18,000 ₪.\n2. אבקש לאפשר להחזיק חתול אחד.\nתודה!",
  requests: [{ issueId: "C002", lawReferenceIds: ["law-25i"] }, { issueId: "C005", lawReferenceIds: [] }],
};

test("T6: the state machine allows only PRIORITIZE -> STRATEGY -> DRAFT -> COUNTER -> DONE (plus DRAFT -> STRATEGY)", () => {
  assert.deepEqual(TRANSITIONS.PRIORITIZE, ["STRATEGY"]);
  assert.deepEqual(TRANSITIONS.COUNTER, ["DONE"]);
  assert.deepEqual(TRANSITIONS.DONE, []);
  const invalid: Array<[NegotiationState, NegotiationState]> = [
    ["PRIORITIZE", "DRAFT"],
    ["PRIORITIZE", "DONE"],
    ["STRATEGY", "COUNTER"],
    ["COUNTER", "DRAFT"],
    ["DONE", "PRIORITIZE"],
  ];
  for (const [from, to] of invalid) {
    assert.throws(() => moveTo(record({ state: from }), to), /INVALID_NEGOTIATION_TRANSITION|Cannot move/u);
  }
  assert.ok(!allowedTools("PRIORITIZE").includes("submit_draft"));
  assert.ok(!allowedTools("DONE").includes("record_strategy"));
});

test("T6: a tool called outside its state is rejected without changing the negotiation", async () => {
  const start = record();
  for (const [name, input] of [
    ["submit_draft", validDraft],
    ["finalize_draft", {}],
    ["complete_negotiation", {}],
    ["record_strategy", { issueId: "C002", kind: "CITE_LAW", request: "x", fallback: null, concessionConfirmed: false, confirmedByTenant: true }],
  ] as const) {
    const outcome = await executeTool(start, name, input, dependencies);
    assert.equal(outcome.isError, true, name);
    assert.equal(outcome.record, start, name);
  }
});

test("priorities require the address form, and strategies move the negotiation to DRAFT", async () => {
  let outcome = await executeTool(record(), "set_priorities", { issueIds: ["C002"] }, dependencies);
  assert.equal(outcome.isError, true);

  outcome = await executeTool(record(), "set_address_form", { form: "FEMININE" }, dependencies);
  outcome = await executeTool(outcome.record, "set_priorities", { issueIds: ["C002", "C005"] }, dependencies);
  assert.equal(outcome.record.state, "STRATEGY");

  outcome = await executeTool(outcome.record, "record_strategy", {
    issueId: "C002", kind: "CITE_LAW", request: "אבקש להעמיד את הערבות על 18,000 ₪.", fallback: null, concessionConfirmed: false, confirmedByTenant: true,
  }, dependencies);
  assert.equal(outcome.record.state, "STRATEGY");
  outcome = await executeTool(outcome.record, "record_strategy", {
    issueId: "C005", kind: "PROPOSE_ALTERNATIVE", request: "אבקש לאפשר חתול אחד.", fallback: null, concessionConfirmed: false, confirmedByTenant: true,
  }, dependencies);
  assert.equal(outcome.record.state, "DRAFT");
});

test("conceding an illegal clause needs the tenant's explicit confirmation", async () => {
  const strategy = record({ state: "STRATEGY", addressForm: "PLURAL", priorities: ["C002"] });
  const concede = { issueId: "C002", kind: "CONCEDE", request: null, fallback: null, confirmedByTenant: true };
  assert.equal((await executeTool(strategy, "record_strategy", { ...concede, concessionConfirmed: false, confirmedByTenant: true }, dependencies)).isError, true);
  assert.equal((await executeTool(strategy, "record_strategy", { ...concede, concessionConfirmed: true }, dependencies)).isError, false);
});

test("CITE_LAW is refused for an issue without legal references", async () => {
  const strategy = record({ state: "STRATEGY", addressForm: "PLURAL", priorities: ["C005"] });
  const outcome = await executeTool(strategy, "record_strategy", {
    issueId: "C005", kind: "CITE_LAW", request: "אבקש לאפשר חתול.", fallback: null, concessionConfirmed: false, confirmedByTenant: true,
  }, dependencies);
  assert.equal(outcome.isError, true);
  assert.match(outcome.result, /no legal reference/u);
});

test("a strategy may use a number only when the analysis or the tenant supplied it", async () => {
  const strategy = record({ state: "STRATEGY", addressForm: "PLURAL", priorities: ["C002"] });
  const ask = { issueId: "C002", kind: "PROPOSE_ALTERNATIVE", fallback: null, concessionConfirmed: false, confirmedByTenant: true };
  const invented = await executeTool(strategy, "record_strategy", { ...ask, request: "אבקש ערבות של 12,500 ₪." }, dependencies);
  assert.equal(invented.isError, true);
  assert.match(invented.result, /12500/u);

  const told = record({
    ...strategy,
    messages: [{ id: "m", role: "TENANT", text: "אני מוכנה לתת עד 12,500 שקל", quickReplies: [], createdAt: "" }],
  });
  const accepted = await executeTool(told, "record_strategy", { ...ask, request: "אבקש ערבות של 12,500 ₪." }, dependencies);
  assert.equal(accepted.isError, false);
});

test("a grounded draft passes every check", () => {
  assert.deepEqual(agentDraftProblems(inDraft(), validDraft), []);
});

test("every law section in the draft must come from a cited reference of a raised issue", () => {
  const foreign = { ...validDraft, text: validDraft.text.replace("סעיף 25י", "סעיף 22") };
  assert.ok(agentDraftProblems(inDraft(), foreign).some((problem) => /section\(s\) 22/u.test(problem)));

  const uncited = { ...validDraft, requests: [{ issueId: "C002", lawReferenceIds: [] }, validDraft.requests[1]!] };
  const problems = agentDraftProblems(inDraft(), uncited);
  assert.ok(problems.some((problem) => /must cite at least one/u.test(problem)));
  assert.ok(problems.some((problem) => /section\(s\) 25י/u.test(problem)));

  const borrowed = { ...validDraft, requests: [validDraft.requests[0]!, { issueId: "C005", lawReferenceIds: ["law-25i"] }] };
  assert.ok(agentDraftProblems(inDraft(), borrowed).some((problem) => /does not belong to issue C005/u.test(problem)));
});

test("the draft may not invent numbers, drop a chosen issue, or keep a redaction placeholder", () => {
  const invented = { ...validDraft, text: validDraft.text.replace("18,000", "15,000") };
  assert.ok(agentDraftProblems(inDraft(), invented).some((problem) => /15000/u.test(problem)));

  const partial = { ...validDraft, requests: [validDraft.requests[0]!] };
  assert.ok(agentDraftProblems(inDraft(), partial).some((problem) => /leaves out issue C005/u.test(problem)));

  const placeholder = { ...validDraft, text: `שלום [LANDLORD_NAME],\n${validDraft.text}` };
  assert.ok(agentDraftProblems(inDraft(), placeholder).some((problem) => /placeholder/u.test(problem)));
});

test("list numbering is not treated as a number claim", () => {
  assert.deepEqual(numbersIn("1. אבקש\n2) עוד בקשה של 18,000 ₪"), [18000]);
});

test("a tenant's own edit is kept but flagged in Hebrew", () => {
  const warnings = tenantDraftWarnings(inDraft(), "שלום, לפי סעיף 40 אבקש ערבות של 9,000 ₪.");
  assert.equal(warnings.length, 2);
  // The bad section is reported once, as a section, not again as an ungrounded number.
  assert.ok(!warnings[1]!.includes("40"));
  assert.ok(warnings.every((warning) => /[֐-׿]/u.test(warning)));
});

function scripted(responses: ClaudeContentBlock[][]): { model: AgentModel; requests: unknown[][] } {
  const requests: unknown[][] = [];
  let index = 0;
  return {
    requests,
    model: async ({ messages }, onText) => {
      requests.push(structuredClone(messages));
      const content = responses[index++] ?? [];
      for (const block of content) if (block.type === "text") onText(block.text);
      return { content, stopReason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn" };
    },
  };
}

test("the agent loop returns tool errors to the model and lets it correct itself", async () => {
  const badDraft = { message: validDraft.text.replace("18,000", "15,000"), requests: validDraft.requests };
  const { model, requests } = scripted([
    [{ type: "tool_use", id: "t1", name: "submit_draft", input: badDraft }],
    [{ type: "tool_use", id: "t2", name: "submit_draft", input: { message: validDraft.text, requests: validDraft.requests } }],
    [{ type: "text", text: "הטיוטה מוכנה." }],
  ]);
  const result = await runAgentTurn(inDraft(), "<TENANT_MESSAGE>\nנו?\n</TENANT_MESSAGE>", model, dependencies, () => {});

  const firstResult = (requests[1]!.at(-1) as { content: Array<{ is_error?: boolean; content: string }> }).content[0]!;
  assert.equal(firstResult.is_error, true);
  assert.match(firstResult.content, /15000/u);
  assert.equal(result.draft?.text, validDraft.text);
  assert.equal(result.messages.at(-1)?.text, "הטיוטה מוכנה.");
});

test("quick replies end the turn and their tool result opens the next turn", async () => {
  const { model, requests } = scripted([
    [{ type: "text", text: "איך לפנות אליך?" }, { type: "tool_use", id: "q1", name: "offer_quick_replies", input: { options: ["בלשון נקבה"] } }],
    [{ type: "text", text: "תודה." }],
  ]);
  const first = await runAgentTurn(record(), "שלום", model, dependencies, () => {});
  assert.equal(requests.length, 1);
  assert.deepEqual(first.messages.at(-1)?.quickReplies, ["בלשון נקבה"]);
  assert.equal(first.pendingToolResults.length, 1);

  await runAgentTurn(first, "בלשון נקבה", model, dependencies, () => {});
  const opening = (requests[1]!.at(-1) as { content: Array<{ type: string; tool_use_id?: string }> }).content;
  assert.equal(opening[0]!.type, "tool_result");
  assert.equal(opening[0]!.tool_use_id, "q1");
  assert.equal(opening.at(-1)!.type, "text");
});

test("a decision is recorded only after the tenant confirmed the summary", async () => {
  const strategy = record({ state: "STRATEGY", addressForm: "PLURAL", priorities: ["C005"] });
  const decision = { issueId: "C005", kind: "PROPOSE_ALTERNATIVE", request: "אבקש לאפשר חתול אחד.", fallback: null, concessionConfirmed: false };
  const early = await executeTool(strategy, "record_strategy", { ...decision, confirmedByTenant: false }, dependencies);
  assert.equal(early.isError, true);
  assert.equal(early.record, strategy);
  assert.equal((await executeTool(strategy, "record_strategy", { ...decision, confirmedByTenant: true }, dependencies)).isError, false);
});

test("the tenant can add a topic of their own, which then needs a decision before drafting", async () => {
  const draft = inDraft();
  const told = record({
    ...draft,
    messages: [{ id: "m", role: "TENANT", text: "אני רוצה גם שהמשכיר יצבע את הדירה לפני הכניסה", quickReplies: [], createdAt: "" }],
  });
  const added = await executeTool(told, "add_tenant_issue", { title: "צביעת הדירה", description: "המשכיר יצבע את הדירה לפני הכניסה." }, dependencies);
  assert.equal(added.isError, false);
  assert.equal(added.record.state, "STRATEGY");
  assert.equal(added.record.priorities.at(-1), "tenant-1");
  assert.equal(added.record.issues.at(-1)?.kind, "TENANT_REQUEST");

  const invented = await executeTool(told, "add_tenant_issue", { title: "צביעה", description: "צביעה תוך 14 ימים." }, dependencies);
  assert.equal(invented.isError, true);
});

test("the draft must carry the tenant's own figures, not the analysis' suggestion", () => {
  const ownAsk = record({
    ...inDraft(),
    strategies: {
      ...inDraft().strategies,
      C005: { kind: "PROPOSE_ALTERNATIVE", request: "אבקש לאפשר עד 2 חתולים.", fallback: null },
    },
    messages: [{ id: "m", role: "TENANT", text: "אני רוצה עד 2 חתולים", quickReplies: [], createdAt: "" }],
  });
  const problems = agentDraftProblems(ownAsk, validDraft);
  assert.ok(problems.some((problem) => /drops the figure\(s\) 2 .*C005/u.test(problem)));
  const faithful = { ...validDraft, text: validDraft.text.replace("להחזיק חתול אחד", "להחזיק עד 2 חתולים") };
  assert.deepEqual(agentDraftProblems(ownAsk, faithful), []);
});

test("the agent reads the tenant's preferences and the contract terms with their meaning", () => {
  const preferences = preferenceLines({
    maxMonthlyRentIls: 3500,
    repairUrgencyHours: 48,
    leaseLengthMonths: 12,
    maxAnnualRentIncreasePercent: 3,
    petsRequired: true,
    furnishedRequired: false,
    acceptedSecurityKinds: ["BANK_GUARANTEE"],
    maxMonthlyTotalCostIls: null,
    acceptsIndexation: false,
    earlyExitRequired: true,
    roommatesRequired: false,
    renewalOptionRequired: false,
    minEntryNoticeHours: 24,
    acceptsBrokerFee: false,
    additionalNotes: "",
  }, "");
  assert.ok(preferences.includes("תקציב מקסימלי לשכר דירה חודשי: 3,500 ₪"));
  assert.ok(preferences.some((line) => line.includes("חיית מחמד: חייב")));

  const terms = contractTermLines({
    monthlyRent: { value: 4200, clauseId: "C003", quote: "4,200", verified: false, origin: "MODEL" },
    leaseTermMonths: { value: 12, clauseId: "C002", quote: "12", verified: true, origin: "RULE" },
    leaseStart: null,
    indexation: null,
    annualIncreasePercent: null,
    option: { months: null, rent: null, increasePercent: null },
    charges: [],
    oneTimeCosts: [],
    securities: [],
    lateVacating: null,
    latePayment: null,
    earlyExit: null,
    unknowns: [],
  }, { leaseTermMonths: 24 });
  assert.ok(terms.some((line) => line.startsWith("שכר דירה חודשי: 4,200 ₪") && line.includes("לא אומת")));
  assert.ok(terms.some((line) => line.startsWith("תקופת השכירות: 24 חודשים") && line.includes("כפי שהשוכר אישר")));

  // Numbers the tenant set or the contract states may appear in the message without being said again.
  const grounded = groundedNumbers({ ...record(), context: { preferences, contractTerms: terms, clauses: [] } });
  assert.ok(grounded.has(3500) && grounded.has(4200));
});
