import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ContractClause, LawChunk, TenantPreferences } from "../src/domain/models.js";
import type { ProtectionAnalysisContext } from "../src/modules/analyses/ai-providers.js";

process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

const { discoverProtectionsWithClaude, verifyProtectionsWithClaude, analyzeWithClaude } = await import(
  "../src/modules/analyses/ai-providers.js"
);

const clause: ContractClause = { id: "C001", text: "סעיף בדיקה", locations: [] };
const lawSection: LawChunk = {
  id: "LAW-1",
  israelLawId: 1,
  lawName: "חוק בדיקה",
  section: "1",
  kind: "statutory_rule",
  text: "טקסט חוק",
  sourceUrl: "https://example.com/law",
  contentHash: "hash",
  revisionId: 1,
  sourceAsOf: "2026-01-01T00:00:00.000Z",
};
const preferences: TenantPreferences = {
  maxMonthlyRentIls: 7_000,
  repairUrgencyHours: 72,
  leaseLengthMonths: 12,
  maxAnnualRentIncreasePercent: 5,
  petsRequired: false,
  furnishedRequired: false,
  acceptedSecurityKinds: ["BANK_GUARANTEE", "CASH_DEPOSIT", "PROMISSORY_NOTE", "GUARANTOR"],
  maxMonthlyTotalCostIls: null,
  acceptsIndexation: true,
  earlyExitRequired: false,
  roommatesRequired: false,
  renewalOptionRequired: false,
  minEntryNoticeHours: null,
  acceptsBrokerFee: true,
  additionalNotes: "",
};
const hebrewVerdict = {
  title: "כותרת",
  clauseQuote: clause.text,
  plainLanguageExplanation: "הסבר בשפה פשוטה",
  whyItMatters: "למה זה חשוב",
  recommendedAction: "פעולה מומלצת",
  explanation: "הסבר",
  topic: "other",
  confidence: "medium",
  legalAssessment: { violatesLaw: false, riskWarning: true, preferenceConflict: false },
  legalReferenceIds: [lawSection.id],
};

// A minimal Messages API event stream: thinking block, ping, one JSON text answer, and usage.
function claudeStream(answer: unknown, stopReason = "end_turn") {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 120 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "ping" },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: JSON.stringify(answer) } },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function mockFetch(context: TestContext, handler: (init?: RequestInit) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => handler(init)) as typeof fetch;
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof Error && "code" in error && error.code === code;
}

test("Anthropic analysis requests stream Sonnet 5 JSON-schema calls without sampling parameters", async (context) => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    hebrewVerdict,
    {
      items: [{
        protectionId: "RR-GAP-SHARED-METER-ALLOCATION",
        title: "אופן חלוקת חשבון משותף",
        basis: "CONTRACT_RISK",
        confidence: "medium",
        applicability: "החוזה כולל תשלום משותף בלי פירוט",
        scenario: "ייתכן ויכוח על חלקו של השוכר בחשבון",
        evidence: [{ clauseId: clause.id, quote: clause.text }],
        preferenceKeys: [],
        status: "MISSING",
        explanation: "ההגנה חסרה",
        relevantClauseIds: [clause.id],
        legalReferenceIds: [lawSection.id],
        suggestedText: "נוסח מוצע",
      }],
    },
  ];
  mockFetch(context, async (init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return claudeStream(responses.shift());
  });

  const verdict = await analyzeWithClaude(clause, [lawSection], preferences);
  await discoverProtectionsWithClaude({ clauses: [clause], preferences, facts: [], relations: [] }, [lawSection]);

  assert.deepEqual(verdict.usage, { inputTokens: 120, outputTokens: 42 });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const outputConfig = request.output_config as {
      effort?: string;
      format?: { type?: string; schema?: { type?: string; additionalProperties?: boolean } };
    };
    assert.equal(request.stream, true);
    assert.equal("temperature" in request, false);
    assert.deepEqual(request.thinking, { type: "adaptive" });
    assert.match(String(outputConfig.effort), /^(low|medium|high)$/u);
    assert.equal(outputConfig.format?.type, "json_schema");
    assert.equal(outputConfig.format.schema?.type, "object");
    assert.equal(outputConfig.format.schema?.additionalProperties, false);
  }

  const verdictSystem = String(requests[0]!.system);
  assert.match(verdictSystem, /clear, fluent Hebrew/u);
  assert.match(verdictSystem, /violatesLaw=true only when the supplied LAW_CONTEXT directly establishes a contradiction/u);
  assert.match(verdictSystem, /Treat missing or ambiguous facts as unknown/u);

  const protectionSystem = String(requests[1]!.system);
  assert.match(protectionSystem, /clear, fluent Hebrew/u);
  assert.match(protectionSystem, /no predefined protection checklist/u);
  assert.match(protectionSystem, /entire subjects absent from the contract/u);
});

test("Anthropic analysis rejects user-facing text that is not in Hebrew", async (context) => {
  mockFetch(context, async () => claudeStream({
    title: "Risk warning",
    explanation: "This clause creates a material contractual risk.",
    legalAssessment: { violatesLaw: false, riskWarning: true, preferenceConflict: false },
    legalReferenceIds: [],
  }));

  await assert.rejects(
    analyzeWithClaude(clause, [lawSection], preferences),
    hasCode("INVALID_ANALYSIS_RESPONSE"),
  );
});

test("a timed-out Claude request is not retried, because the provider may still bill for it", async (context) => {
  let calls = 0;
  mockFetch(context, async () => {
    calls += 1;
    throw new DOMException("The operation timed out.", "TimeoutError");
  });

  await assert.rejects(analyzeWithClaude(clause, [lawSection], preferences), hasCode("AI_PROVIDER_ERROR"));
  assert.equal(calls, 1);
});

test("a rate-limited Claude request is retried before any tokens are generated", async (context) => {
  let calls = 0;
  mockFetch(context, async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "retry-after": "0" } })
      : claudeStream(hebrewVerdict);
  });

  const verdict = await analyzeWithClaude(clause, [lawSection], preferences);
  assert.equal(calls, 2);
  assert.equal(verdict.title, hebrewVerdict.title);
});

test("a Claude answer cut off at the output token limit is reported as truncated", async (context) => {
  mockFetch(context, async () => claudeStream(hebrewVerdict, "max_tokens"));

  await assert.rejects(analyzeWithClaude(clause, [lawSection], preferences), hasCode("AI_RESPONSE_TRUNCATED"));
});

test("related clauses are supplied as untrusted context and only supplied IDs survive in the verdict", async (context) => {
  const requests: Array<Record<string, unknown>> = [];
  const answers: unknown[] = [
    // Cites a supplied clause and an invented one; the issue names only the invented one.
    {
      ...hebrewVerdict,
      contextClauseIds: ["C002", "C999"],
      crossClauseIssue: { kind: "CONFLICT", clauseIds: ["C999"], explanation: "סתירה בין הסעיפים" },
    },
    {
      ...hebrewVerdict,
      contextClauseIds: ["C002"],
      crossClauseIssue: { kind: "OVERRIDE", clauseIds: ["C002", "C999"], explanation: "סעיף אחר גובר על הסעיף הזה" },
    },
  ];
  mockFetch(context, async (init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return claudeStream(answers.shift());
  });
  const related = [{
    clauseId: "C002",
    relation: "DEFINES_VALUE" as const,
    reason: "מגדיר את דמי השכירות החודשיים: 6,000 ש״ח",
    excerpt: "דמי השכירות החודשיים הם 6,000 ש״ח.",
  }];

  const unsupported = await analyzeWithClaude(clause, [lawSection], preferences, [], related);
  assert.deepEqual(unsupported.contextClauseIds, ["C002"]);
  assert.equal(unsupported.crossClauseIssue, undefined);

  const supported = await analyzeWithClaude(clause, [lawSection], preferences, [], related);
  assert.deepEqual(supported.crossClauseIssue, {
    kind: "OVERRIDE",
    clauseIds: ["C002"],
    explanation: "סעיף אחר גובר על הסעיף הזה",
  });

  const content = String((requests[0]!.messages as Array<{ content: string }>)[0]!.content);
  assert.match(content, /RELATED_CONTRACT_CLAUSES=\[\{"id":"C002","relation":"DEFINES_VALUE"/u);
  assert.match(content, /<UNTRUSTED_RELATED_CLAUSE id="C002">דמי השכירות החודשיים הם 6,000 ש״ח\.<\/UNTRUSTED_RELATED_CLAUSE>/u);
  assert.match(String(requests[0]!.system), /Judge only the focal clause/u);
  const schema = (requests[0]!.output_config as { format: { schema: { required: string[] } } }).format.schema;
  assert.ok(schema.required.includes("contextClauseIds"));

  // Without related clauses the request is unchanged from a single-clause analysis.
  answers.push(hebrewVerdict);
  await analyzeWithClaude(clause, [lawSection], preferences);
  assert.doesNotMatch(String((requests[2]!.messages as Array<{ content: string }>)[0]!.content), /RELATED_CONTRACT_CLAUSES/u);
});

const protectionContext: ProtectionAnalysisContext = {
  clauses: [{ id: "C101", text: "חשבון החשמל משותף לשלוש יחידות והשוכר ישלם את חלקו.", locations: [] }],
  preferences: { ...preferences, earlyExitRequired: true, additionalNotes: "נדרשת אפשרות לעבור דירה בגלל העבודה" },
  facts: [],
  relations: [{ clauseId: "C101", relatedClauseId: "C102", relation: "REFERENCES" }],
};
const sharedMeterGap = {
  protectionId: "RR-GAP-SHARED-METER-ALLOCATION",
  title: "בדיקת החלק בחשבון המשותף",
  status: "PARTIAL" as const,
  basis: "CONTRACT_RISK" as const,
  confidence: "medium" as const,
  applicability: "החוזה מחייב תשלום על חשמל משותף בלי להגדיר את החלוקה",
  scenario: "אם צריכת השכנים תגדל, השוכר עלול לשלם יותר בלי יכולת לבדוק את חלקו",
  explanation: "לא מוגדרת דרך לחשב ולבדוק את חלקו של השוכר בחשבון",
  relevantClauseIds: ["C101"],
  evidence: [{ clauseId: "C101", quote: protectionContext.clauses[0]!.text }],
  legalReferenceIds: [],
  preferenceKeys: [],
  suggestedText: "הצדדים יסכימו בכתב על אופן חלוקת החשבון ועל האפשרות לעיין בחשבונות ובקריאות המונה.",
};

test("discovery accepts a novel protection without an eight-item catalog and sends the tenant context", async (context) => {
  let request: Record<string, unknown> = {};
  mockFetch(context, async (init) => {
    request = JSON.parse(String(init?.body));
    return claudeStream({ items: [sharedMeterGap] });
  });
  const report = await discoverProtectionsWithClaude(protectionContext, [lawSection]);
  assert.equal(report.length, 1);
  assert.equal(report[0]!.protectionId, sharedMeterGap.protectionId);
  assert.equal(report[0]!.title, sharedMeterGap.title);
  const content = (request.messages as Array<{ content: string }>)[0]!.content;
  assert.ok(content.includes(JSON.stringify(protectionContext.preferences)));
  assert.ok(content.includes(JSON.stringify(protectionContext.relations)));
  assert.ok(content.includes(protectionContext.clauses[0]!.text));
  assert.doesNotMatch(content, /CHECKLIST=/u);
});

test("verification can resolve a candidate using a different clause and removes its proposed addition", async (context) => {
  const resolving = { id: "C102", text: "חלקו של השוכר ייקבע לפי מונה נפרד וחשבונות החשמל יימסרו לעיונו.", locations: [] };
  let request: Record<string, unknown> = {};
  mockFetch(context, async (init) => {
    request = JSON.parse(String(init?.body));
    return claudeStream({ items: [{ ...sharedMeterGap, status: "COVERED", relevantClauseIds: ["C102"],
      evidence: [{ clauseId: "C102", quote: resolving.text }], explanation: "סעיף אחר קובע מדידה נפרדת וזכות לעיין בחשבונות" }] });
  });
  const report = await verifyProtectionsWithClaude({ ...protectionContext, clauses: [...protectionContext.clauses, resolving] }, [sharedMeterGap], [lawSection]);
  assert.equal(report[0]!.status, "COVERED");
  assert.equal(report[0]!.suggestedText, undefined);
  assert.deepEqual(report[0]!.relevantClauseIds, ["C102"]);
  const content = (request.messages as Array<{ content: string }>)[0]!.content;
  assert.ok(content.includes(resolving.text));
  assert.match(content, /<UNTRUSTED_CANDIDATES>/u);
  assert.match(String(request.system), /Independently challenge every candidate/u);
});

test("an unavailable annex stays UNKNOWN and cannot produce a contract addition", async (context) => {
  const annexContext = { ...protectionContext, clauses: [{ id: "C103", text: "רשימת הציוד ומצבו מפורטים בנספח א.", locations: [] }] };
  mockFetch(context, async () => claudeStream({ items: [{ ...sharedMeterGap,
    protectionId: "RR-GAP-EQUIPMENT-CONDITION", title: "בירור מצב הציוד", status: "UNKNOWN",
    explanation: "נספח הציוד לא צורף ולכן אי אפשר לקבוע אם מצב הציוד מתועד",
    relevantClauseIds: ["C103"], evidence: [{ clauseId: "C103", quote: annexContext.clauses[0]!.text }],
  }] }));
  const report = await discoverProtectionsWithClaude(annexContext, []);
  assert.equal(report[0]!.status, "UNKNOWN");
  assert.equal(report[0]!.suggestedText, undefined);
});

test("discovery can report an entirely absent subject and can return no candidates", async (context) => {
  const answers = [
    { items: [{ ...sharedMeterGap, status: "MISSING", relevantClauseIds: [], evidence: [] }] },
    { items: [] },
  ];
  let calls = 0;
  mockFetch(context, async () => { calls += 1; return claudeStream(answers.shift()); });
  assert.equal((await discoverProtectionsWithClaude(protectionContext, []))[0]!.status, "MISSING");
  assert.deepEqual(await discoverProtectionsWithClaude(protectionContext, []), []);
  assert.deepEqual(await verifyProtectionsWithClaude(protectionContext, [], []), []);
  assert.equal(calls, 2, "there is no paid verification call for an empty candidate set");
});

test("verification supports dismissal of an irrelevant candidate without adding a replacement topic", async (context) => {
  mockFetch(context, async () => claudeStream({ items: [{ ...sharedMeterGap, status: "DISMISSED",
    explanation: "המועמד אינו רלוונטי לעסקה הזו" }] }));
  const report = await verifyProtectionsWithClaude(protectionContext, [sharedMeterGap], []);
  assert.equal(report[0]!.status, "DISMISSED");
  assert.equal(report[0]!.suggestedText, undefined);
});

for (const [name, patch] of [
  ["an invented clause", { relevantClauseIds: ["C999"] }],
  ["a fabricated quote in an existing clause", { evidence: [{ clauseId: "C101", quote: "טקסט שלא מופיע בחוזה" }] }],
  ["an invented law reference", { legalReferenceIds: ["LAW-UNKNOWN"] }],
  ["a legal claim without a supplied legal source", { basis: "LAW" }],
  ["a preference claim without an explicit preference", { basis: "TENANT_PREFERENCE", preferenceKeys: [] }],
  ["a false Required field treated as a tenant demand", { basis: "TENANT_PREFERENCE", preferenceKeys: ["petsRequired"] }],
  ["an invented preference field", { basis: "TENANT_PREFERENCE", preferenceKeys: ["imaginaryPreference"] }],
  ["partial coverage without evidence", { relevantClauseIds: [], evidence: [] }],
  ["an actionable gap without a proposed addition", { suggestedText: undefined }],
] as const) {
  test(`protection validation drops ${name} and keeps the grounded items`, async (context) => {
    const grounded = { ...sharedMeterGap, protectionId: "RR-GAP-GROUNDED-NEIGHBOUR" };
    mockFetch(context, async () => claudeStream({ items: [{ ...sharedMeterGap, ...patch }, grounded] }));
    const report = await discoverProtectionsWithClaude(protectionContext, [lawSection]);
    assert.deepEqual(report.map((item) => item.protectionId), [grounded.protectionId]);
  });
}

test("a supplied tenant requirement can ground a protection and is preserved through verification", async (context) => {
  const preferenceGap = { ...sharedMeterGap, basis: "TENANT_PREFERENCE" as const, preferenceKeys: ["earlyExitRequired"] };
  mockFetch(context, async () => claudeStream({ items: [preferenceGap] }));
  const report = await verifyProtectionsWithClaude(protectionContext, [preferenceGap], []);
  assert.deepEqual(report[0]!.preferenceKeys, ["earlyExitRequired"]);
});

test("discovery rejects duplicate IDs and verification rejects omitted or invented candidates", async (context) => {
  const answers = [
    { items: [sharedMeterGap, sharedMeterGap] },
    { items: [] },
    { items: [{ ...sharedMeterGap, protectionId: "RR-GAP-INVENTED-TOPIC" }] },
  ];
  mockFetch(context, async () => claudeStream(answers.shift()));
  await assert.rejects(discoverProtectionsWithClaude(protectionContext, []), hasCode("INVALID_PROTECTION_RESPONSE"));
  await assert.rejects(verifyProtectionsWithClaude(protectionContext, [sharedMeterGap], []), hasCode("INVALID_PROTECTION_RESPONSE"));
  await assert.rejects(verifyProtectionsWithClaude(protectionContext, [sharedMeterGap], []), hasCode("INVALID_PROTECTION_RESPONSE"));
});
