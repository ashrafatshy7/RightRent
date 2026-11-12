import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { defaultPreferences, type ContractRecord, type LawEmbeddingRecord, type LawSourceState } from "../src/domain/models.js";

// Exercise the real Anthropic pipeline against mocked HTTP services and a private memory store.
// No live model, database, or law service is contacted.
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "rightrent-contextual-"));
process.env.ANALYSIS_PROVIDER = "anthropic";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.PII_NER_MODE = "dictabert";
process.env.PII_NER_ENDPOINT = "http://ner.test";
process.env.UPLOAD_DIR = path.join(temporaryRoot, "uploads");
process.env.MARKED_PDF_DIR = path.join(temporaryRoot, "marked");

const { analyzeContract } = await import("../src/modules/analyses/analysis.service.js");
const { getStore } = await import("../src/shared/data/store.js");
const { MONITORED_LAW_SOURCES } = await import("../src/modules/law/law-source.catalog.js");
const { negotiationIssues } = await import("../src/modules/negotiations/negotiation-grounding.js");

function stream(answer: unknown) {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 100 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(answer) } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const clauses = [
  { id: "C101", text: "חשבון החשמל משותף לכמה יחידות והשוכר ישלם את חלקו.", locations: [] },
  { id: "C102", text: "הציוד ומצבו מפורטים בנספח א להסכם.", locations: [] },
  { id: "C103", text: "חלקו של השוכר בחשמל ייקבע לפי מונה נפרד והוא רשאי לעיין בחשבונות.", locations: [] },
];
const candidate = {
  protectionId: "RR-GAP-SHARED-METER-ALLOCATION", title: "בירור חלוקת חשבון החשמל",
  status: "PARTIAL", basis: "CONTRACT_RISK", confidence: "medium",
  applicability: "החוזה קובע תשלום על חשמל משותף לכמה יחידות",
  scenario: "עלולה להתעורר מחלוקת על הצריכה המיוחסת לשוכר",
  explanation: "צריך לוודא שקיימת אפשרות לבדוק את אופן החיוב",
  relevantClauseIds: ["C101"], evidence: [{ clauseId: "C101", quote: clauses[0]!.text }],
  legalReferenceIds: [], preferenceKeys: [], suggestedText: "ייקבע אופן חישוב שקוף ותינתן אפשרות לעיין בחשבונות.",
};
const exitCandidate = { ...candidate, protectionId: "RR-GAP-TENANT-EXIT-RELEASE", title: "אפשרות לסיום מוקדם",
  status: "MISSING", basis: "TENANT_PREFERENCE", preferenceKeys: ["earlyExitRequired"],
  applicability: "השוכר ביקש במפורש אפשרות לסיים את השכירות מוקדם",
  scenario: "אם יידרש מעבר דירה, לא מוגדר מנגנון מוסכם ליציאה",
  explanation: "לא נקבע מנגנון לסיום מוקדם", relevantClauseIds: [], evidence: [],
  suggestedText: "הצדדים יסכימו בכתב על מנגנון לסיום מוקדם של השכירות.",
};
const annexCandidate = { ...candidate, protectionId: "RR-GAP-EQUIPMENT-CONDITION", title: "בירור מצב הציוד",
  status: "UNKNOWN", explanation: "נדרש לקבל את נספח א לפני שאפשר לקבוע אם מצב הציוד מתועד",
  relevantClauseIds: ["C102"], evidence: [{ clauseId: "C102", quote: clauses[1]!.text }],
};
const irrelevantCandidate = { ...candidate, protectionId: "RR-GAP-IRRELEVANT-CANDIDATE", title: "מועמד לבדיקה חוזרת" };

test("contextual analysis retrieves law for discovered gaps, verifies them, and caches completed paid stages", async (context) => {
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const store = await getStore();
  const lawText = "3 שכירות זהו טקסט משפטי ארוך דיו לצורך יצירת מקטע בדיקה.";
  const html = '<div>2000416</div><div id="law-content"><div class="law-number">3.</div><div class="law-content">שכירות זהו טקסט משפטי ארוך דיו לצורך יצירת מקטע בדיקה.</div></div>';
  const lawRecord: LawEmbeddingRecord = {
    id: "law-record", referenceId: "IL-2000416-3", israelLawId: 2_000_416,
    lawName: "חוק המקרקעין", section: "3", sourceOrdinal: 0,
    sourceUrl: "https://he.wikisource.org/wiki/example", wikisourceTitle: "חוק המקרקעין",
    revisionId: 9123, revisionTimestamp: "2026-01-01T00:00:00.000Z", sourceAsOf: "2026-10-25",
    officialFingerprint: "test-approved-law", latestOfficialPublicationDate: "2026-01-01T00:00:00.000Z",
    contentHash: createHash("sha256").update(lawText).digest("hex"), status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z", embedding: [1],
  };
  context.mock.method(store, "listLawSourceStates", async () => MONITORED_LAW_SOURCES.map((source) => ({
    israelLawId: source.israelLawId, activeRevisionId: 9123, activeOfficialFingerprint: "test-approved-law",
    activeContentHash: lawRecord.contentHash,
  })) as LawSourceState[]);
  context.mock.method(store, "searchLawEmbeddings", async () => [lawRecord]);
  let discoveries = 0;
  let verifications = 0;
  let failVerification = true;
  const cloudPayloads: string[] = [];
  const embeddingQueries: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.hostname === "ner.test") {
      return Response.json({ model: "test-local-ner", items: (payload.texts as string[]).map((text) => ({ text, entityCount: 0 })) });
    }
    if (url.hostname === "he.wikisource.org") {
      return Response.json(url.searchParams.get("action") === "query"
        ? { query: { pages: [{ revisions: [{ revid: 9123, timestamp: lawRecord.revisionTimestamp }] }] } }
        : { parse: { revid: 9123, text: html } });
    }
    cloudPayloads.push(String(init?.body));
    if (url.hostname === "api.openai.com") {
      const texts = payload.input as string[];
      embeddingQueries.push(...texts);
      return Response.json({ data: texts.map((_, index) => ({ index, embedding: [1] })) });
    }
    assert.equal(url.hostname, "api.anthropic.com", "unexpected network request");
    const system = String(payload.system);
    if (system.includes("DISCOVERY:")) {
      discoveries += 1;
      return stream({ items: [candidate, exitCandidate, annexCandidate, irrelevantCandidate] });
    }
    if (system.includes("VERIFICATION:")) {
      verifications += 1;
      const covered = { ...candidate, status: "COVERED", relevantClauseIds: ["C103"],
        evidence: [{ clauseId: "C103", quote: clauses[2]!.text }],
        explanation: "סעיף אחר מאפשר לבדוק את החשבון וקובע מדידה נפרדת" };
      const dismissed = { ...irrelevantCandidate, status: "DISMISSED" };
      // The first answer leaves a candidate out, which fails the whole verification.
      const items = failVerification ? [covered, exitCandidate, annexCandidate] : [covered, exitCandidate, annexCandidate, dismissed];
      failVerification = false;
      return stream({ items });
    }
    if (system.includes("money terms")) return stream({ charges: [], oneTimeCosts: [], securities: [] });
    const content = (payload.messages as Array<{ content: string }>)[0]!.content;
    const quote = content.match(/<UNTRUSTED_CONTRACT_CLAUSE id="[^"]+">([\s\S]*?)<\/UNTRUSTED_CONTRACT_CLAUSE>/u)![1]!;
    return stream({ title: "סעיף בחוזה", clauseQuote: quote, plainLanguageExplanation: "הסבר על הסעיף",
      whyItMatters: "כדאי להכיר את התנאי", explanation: "לא נמצאה בעיה בסעיף זה", topic: "other", confidence: "medium",
      legalAssessment: { violatesLaw: false, riskWarning: false, preferenceConflict: false }, legalReferenceIds: [], contextClauseIds: [] });
  });
  const document = await PDFDocument.create();
  document.addPage();
  await mkdir(process.env.UPLOAD_DIR!, { recursive: true });
  await writeFile(path.join(process.env.UPLOAD_DIR!, "synthetic.pdf"), await document.save());
  const contract: ContractRecord = {
    id: "contextual-contract", userId: "contextual-tenant", originalFileName: "synthetic.pdf", mimeType: "application/pdf",
    sizeBytes: 1, storageKey: "synthetic.pdf", status: "EXTRACTED", isScanned: false, extractionMs: 0, clauses,
    uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await store.createContract(contract);
  const preferences = { ...defaultPreferences, earlyExitRequired: true, additionalNotes: "נדרשת יציאה מוקדמת. טלפון 050-1234567." };

  await assert.rejects(analyzeContract(contract.id, contract.userId, preferences), { code: "INVALID_PROTECTION_RESPONSE" });
  assert.equal(discoveries, 1);
  assert.equal(verifications, 1);
  const { analysis } = await analyzeContract(contract.id, contract.userId, preferences);
  assert.equal(discoveries, 1, "a completed paid discovery survives a later verification failure");
  assert.equal(verifications, 2);
  assert.equal(analysis.protectionAnalysisMode, "CONTEXTUAL");
  assert.deepEqual(analysis.protectionReport.map((item) => item.status), ["COVERED", "MISSING", "UNKNOWN"]);
  assert.deepEqual(analysis.missingProtections.map((item) => item.protectionId), [exitCandidate.protectionId]);
  assert.deepEqual(analysis.suggestedAdditions.map((item) => item.protectionId), [exitCandidate.protectionId]);
  assert.equal(analysis.protectionReport.find((item) => item.status === "UNKNOWN")!.suggestedText, undefined);
  assert.equal(negotiationIssues(analysis).filter((item) => item.kind === "MISSING_PROTECTION").length, 1);
  assert.ok(embeddingQueries.some((query) => query.includes(candidate.title)), "discovered topics drive additional law retrieval");
  assert.ok(cloudPayloads.every((payload) => !payload.includes("050-1234567")), "free-text preference PII never reaches cloud calls");
  assert.ok(cloudPayloads.some((payload) => payload.includes("[PHONE_NUMBER]")));

  const countBeforeReuse = cloudPayloads.length;
  const repeated = await analyzeContract(contract.id, contract.userId, preferences);
  assert.equal(repeated.created, false);
  assert.equal(cloudPayloads.length, countBeforeReuse);
  await analyzeContract(contract.id, contract.userId, { ...preferences, maxMonthlyRentIls: preferences.maxMonthlyRentIls + 1 });
  assert.equal(discoveries, 2, "changed preferences invalidate discovery");
  assert.equal(verifications, 3, "changed preferences invalidate verification");
});
