import assert from "node:assert/strict";
import { test } from "node:test";
import {
  redactClauses,
  redactWithDictaBert,
} from "../src/modules/analyses/anonymization.service.js";
import {
  evaluateProtectionChecklistDeterministically,
} from "../src/modules/analyses/protection-checklist.service.js";
import {
  extractClausesFromPlainText,
  locatedLinesFromOcrBlocks,
} from "../src/modules/contracts/pdf-extraction.service.js";

test("role-aware regex redaction removes direct identifiers before any provider call", async () => {
  const clauses = extractClausesFromPlainText([
    "[C001]",
    "המשכיר דניאל כהן, משכיר למאיה לוי, תעודת זהות 123456782, טלפון 050-1234567.",
  ].join("\n"));
  const result = await redactClauses(clauses);
  const text = result.clauses[0]!.text;
  assert.match(text, /\[LANDLORD_NAME\]/u);
  assert.match(text, /\[TENANT_NAME\]/u);
  assert.match(text, /\[ID_NUMBER\]/u);
  assert.match(text, /\[PHONE_NUMBER\]/u);
  assert.doesNotMatch(text, /דניאל כהן|מאיה לוי|123456782|050-1234567/u);
});

test("the DictaBERT client validates and preserves the local redaction response", async () => {
  const fetcher = async () => new Response(JSON.stringify({
    model: "dicta-il/dictabert-ner",
    items: [{ text: "המשכיר [PERSON_NAME]", entityCount: 1 }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await redactWithDictaBert(["המשכיר ישראל ישראלי"], fetcher as typeof fetch);
  assert.equal(result.model, "dicta-il/dictabert-ner");
  assert.deepEqual(result.items, [{ text: "המשכיר [PERSON_NAME]", entityCount: 1 }]);
});

test("every long logical clause is split into chunks no longer than 300 words", () => {
  const lines = Array.from({ length: 70 }, () => "אחת שתיים שלוש ארבע חמש");
  const clauses = extractClausesFromPlainText(["[C001]", ...lines].join("\n"));
  assert.ok(clauses.length > 1);
  assert.ok(clauses.every((clause) => clause.id.startsWith("C001-P")));
  assert.ok(clauses.every((clause) => clause.text.split(/\s+/u).length <= 300));
  assert.equal(clauses.flatMap((clause) => clause.locations).length, lines.length);
});

test("OCR word boxes are mapped from rendered top-left coordinates to PDF bottom-left coordinates", () => {
  const lines = locatedLinesFromOcrBlocks([{
    paragraphs: [{
      lines: [{
        text: "שלום עולם",
        words: [
          { text: "שלום", bbox: { x0: 100, y0: 200, x1: 180, y1: 240 } },
          { text: "עולם", bbox: { x0: 190, y0: 200, x1: 280, y1: 240 } },
        ],
      }],
    }],
  }], 2, 2, 1_684);
  assert.equal(lines[0]!.text, "שלום עולם");
  assert.deepEqual(lines[0]!.locations[0], { page: 2, bbox: [50, 722, 40, 20] });
  assert.deepEqual(lines[0]!.locations[1], { page: 2, bbox: [95, 722, 45, 20] });
});

test("the contract-level checklist reports covered, partial, and missing protections", () => {
  const clauses = extractClausesFromPlainText([
    "[C001]",
    "השוכר רשאי להציע שוכר חלופי והמשכיר לא יסרב מטעמים בלתי סבירים.",
    "[C002]",
    "החוזה מזכיר כניסת המשכיר לדירה אך אינו קובע הודעה מראש.",
  ].join("\n"));
  const report = evaluateProtectionChecklistDeterministically(clauses);
  assert.equal(report.find((item) => item.protectionId === "RR-REC-EARLY-TERMINATION")?.status, "COVERED");
  assert.equal(report.find((item) => item.protectionId === "RR-REC-ENTRY-NOTICE")?.status, "PARTIAL");
  assert.equal(report.find((item) => item.protectionId === "RR-REC-WEAR-AND-TEAR")?.status, "MISSING");
});
