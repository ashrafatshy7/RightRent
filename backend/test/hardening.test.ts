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
  pageLines,
  type PdfTextItem,
} from "../src/modules/contracts/pdf-extraction.service.js";

// Lays a right-to-left run out the way a per-glyph PDF does: one text item per character, advancing
// leftwards, with a word space of `spaceWidth` points wherever the source text has a space.
function perGlyphItems(text: string, rightEdge: number, y: number, glyphWidth = 6, spaceWidth = 3) {
  const items: PdfTextItem[] = [];
  let right = rightEdge;
  for (const character of text) {
    if (character === " ") {
      right -= spaceWidth;
      continue;
    }
    right -= glyphWidth;
    items.push({ str: character, transform: [11, 0, 0, 11, right, y], width: glyphWidth, height: 11, hasEOL: false });
  }
  items[items.length - 1]!.hasEOL = true;
  return items;
}

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

test("per-glyph PDF items are joined into words by geometry, not by item boundaries", () => {
  const lines = pageLines([
    ...perGlyphItems("ערבות בנקאית בסך", 500, 700),
    // A number laid out left to right, a word space to the left of the Hebrew run above.
    { str: "30,000", transform: [11, 0, 0, 11, 370, 650], width: 33, height: 11, hasEOL: false },
    ...perGlyphItems("ש״ח", 368, 650),
  ], 3);
  assert.deepEqual(lines.map((line) => line.text), ["ערבות בנקאית בסך", "30,000 ש״ח"]);
  // One box per word, each the union of its glyphs, instead of one box per glyph.
  assert.equal(lines[0]!.locations.length, 3);
  assert.deepEqual(lines[0]!.locations[0], { page: 3, bbox: [470, 700, 30, 11] });
});

test("word-level PDF items keep their spacing and attach adjacent punctuation", () => {
  const lines = pageLines([
    { str: "ברחוב דיזנגוף", transform: [11, 0, 0, 11, 124, 582], width: 400, height: 11, hasEOL: false },
    { str: "118", transform: [11, 0, 0, 11, 102.3, 582], width: 18.3, height: 11, hasEOL: false },
    { str: ", דירה", transform: [11, 0, 0, 11, 74.6, 582], width: 27.9, height: 11, hasEOL: true },
  ], 1);
  assert.equal(lines[0]!.text, "ברחוב דיזנגוף 118, דירה");
});

test("numbered clauses keep the contract's own section number and short heading", () => {
  const clauses = extractClausesFromPlainText([
    "חוזה שכירות למגורים",
    "4. תקופת השכירות",
    "תקופת השכירות היא שנים עשר חודשים.",
    "5. דמי השכירות החודשיים הם 6,000 ש״ח.",
    "9.2 בטוחות נוספות",
    "השוכר ימציא ערב.",
  ].join("\n"));
  assert.deepEqual(
    clauses.map(({ id, sectionLabel, heading }) => ({ id, sectionLabel, heading })),
    [
      { id: "C001", sectionLabel: undefined, heading: undefined },
      { id: "C002", sectionLabel: "4", heading: "תקופת השכירות" },
      // A full sentence after the number is the clause itself, not a heading.
      { id: "C003", sectionLabel: "5", heading: undefined },
      { id: "C004", sectionLabel: "9.2", heading: "בטוחות נוספות" },
    ],
  );
  assert.ok(!("heading" in clauses[2]!), "absent labels are omitted, not set to undefined");
});

function placedItem(str: string, x: number, width: number, y = 600, hasEOL = false): PdfTextItem {
  return { str, transform: [11, 0, 0, 11, x, y], width, height: 11, hasEOL };
}

test("visual-order Hebrew pages (Chrome's print to PDF) are read right to left", () => {
  // As Chrome writes it: items left to right, so the clause number arrives last on its line, and a
  // wrapped sentence end arrives as ".2028".
  const lines = pageLines([
    placedItem("בדצמבר", 100.6, 36.6),
    placedItem("31", 140.4, 12.8),
    placedItem("ועד יום", 156.4, 30.5),
    placedItem("2027", 190.1, 25.6),
    placedItem("בינואר", 218.9, 28.3),
    placedItem("1", 250.3, 6.4),
    placedItem("חודשים, מיום", 259.9, 59.1),
    placedItem("24", 322.2, 12.8),
    placedItem(". תקופת השכירות: תקופת השכירות היא", 338.2, 177.3),
    placedItem("2", 515.5, 6.4, 600, true),
    placedItem(".2028", 493.1, 28.8, 582, true),
  ], 1);
  assert.deepEqual(lines.map((line) => line.text), [
    "2. תקופת השכירות: תקופת השכירות היא 24 חודשים, מיום 1 בינואר 2027 ועד יום 31 בדצמבר",
    "2028.",
  ]);
});

test("logical-order pages keep the producer's order, including left-to-right lines", () => {
  const lines = pageLines([
    // Logical order: each Hebrew run is to the left of the one before it.
    placedItem("המשכיר משכיר לשוכרת דירה ברחוב דיזנגוף", 123.8, 401.5),
    placedItem("118", 102.3, 18.3),
    placedItem(", דירה", 74.6, 27.9),
    placedItem("7", 65.3, 6.1),
    placedItem(",", 62.4, 3.0, 600, true),
    placedItem("ועד יום", 300, 30, 580),
    placedItem("31", 280, 12, 580),
    placedItem("בדצמבר", 230, 36, 580, true),
    // A centered left-to-right footer.
    placedItem("עמוד", 280, 25, 40),
    placedItem("1", 309, 6, 40, true),
  ], 1);
  assert.deepEqual(lines.map((line) => line.text), [
    "המשכיר משכיר לשוכרת דירה ברחוב דיזנגוף 118, דירה 7,",
    "ועד יום 31 בדצמבר",
    "עמוד 1",
  ]);
});

test("a wrapped line that starts with a year or an amount does not open a new clause", () => {
  const clauses = extractClausesFromPlainText([
    "2. תקופת השכירות היא מיום 1 בינואר 2027 ועד יום 31 בדצמבר",
    "2028. דמי השכירות ישולמו מראש.",
    "30 ימים לפני תום התקופה תימסר הודעה.",
    "3) בטוחות",
    "השוכר ימסור ערבות.",
  ].join("\n"));
  assert.deepEqual(clauses.map(({ id, sectionLabel }) => [id, sectionLabel]), [["C001", "2"], ["C002", "3"]]);
});
