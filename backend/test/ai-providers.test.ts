import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContractClause, LawChunk } from "../src/domain/models.js";
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

test("Anthropic analysis requests constrain verdicts and protection reports to JSON schemas", async (context) => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    {
      title: "כותרת",
      explanation: "הסבר",
      legalAssessment: {
        violatesLaw: false,
        riskWarning: true,
        preferenceConflict: false,
      },
      legalReferenceIds: [lawSection.id],
    },
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
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(responses.shift()) }],
      stop_reason: "end_turn",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await analyzeWithClaude(clause, [lawSection], {
    maxMonthlyRentIls: 7_000,
    repairUrgencyHours: 72,
    leaseLengthMonths: 12,
    maxAnnualRentIncreasePercent: 5,
    petsRequired: false,
    furnishedRequired: false,
    acceptsGuarantorRequirement: true,
  });
  const checklist: ProtectionChecklistItem = {
    protectionId: "PROTECTION-1",
    title: "הגנת בדיקה",
    description: "תיאור",
    suggestedText: "נוסח מוצע",
    covered: /מכוסה/u,
    partial: /חלקי/u,
  };
  await analyzeProtectionsWithClaude([clause], [checklist], [lawSection]);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    const outputConfig = request.output_config as {
      format?: { type?: string; schema?: { type?: string; additionalProperties?: boolean } };
    };
    assert.equal(outputConfig.format?.type, "json_schema");
    assert.equal(outputConfig.format.schema?.type, "object");
    assert.equal(outputConfig.format.schema?.additionalProperties, false);
  }
});
