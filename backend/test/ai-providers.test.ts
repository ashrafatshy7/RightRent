import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ContractClause, LawChunk, TenantPreferences } from "../src/domain/models.js";
import type { ProtectionChecklistItem } from "../src/modules/analyses/protection-checklist.service.js";

process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

const { analyzeProtectionsWithClaude, analyzeWithClaude } = await import(
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
  acceptsGuarantorRequirement: true,
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
        protectionId: "PROTECTION-1",
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
  const checklist: ProtectionChecklistItem = {
    protectionId: "PROTECTION-1",
    title: "הגנת בדיקה",
    description: "תיאור",
    suggestedText: "נוסח מוצע",
    covered: /מכוסה/u,
    partial: /חלקי/u,
  };
  await analyzeProtectionsWithClaude([clause], [checklist], [lawSection]);

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
  assert.match(protectionSystem, /Use COVERED only when the contract expressly provides the complete protection/u);
  assert.match(protectionSystem, /do not infer coverage from silence/u);
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
