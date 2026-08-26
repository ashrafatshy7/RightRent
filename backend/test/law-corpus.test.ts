import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LawEmbeddingRecord } from "../src/domain/models.js";
import { hydrateLawEmbeddings } from "../src/modules/analyses/law-corpus.service.js";

const firstSectionText = "3 שכירות זהו טקסט משפטי ארוך דיו לצורך יצירת מקטע בדיקה.";
const html = `
  <div>2000416</div>
  <div id="law-content">
    <div class="law-number">3.</div><div class="law-content">שכירות זהו טקסט משפטי ארוך דיו לצורך יצירת מקטע בדיקה.</div>
    <div class="law-number">3.</div><div class="law-content">סעיף נוסף בעל אותו מספר לצורך בדיקת מזהים כפולים.</div>
  </div>`;

function embeddingRecord(contentHash: string): LawEmbeddingRecord {
  return {
    id: `record:${contentHash}`,
    referenceId: "IL-2000416-3",
    israelLawId: 2_000_416,
    lawName: "חוק המקרקעין",
    section: "3",
    sourceOrdinal: 0,
    sourceUrl: "https://he.wikisource.org/wiki/example",
    wikisourceTitle: "חוק המקרקעין",
    revisionId: 123,
    revisionTimestamp: "2026-01-01T00:00:00.000Z",
    sourceAsOf: "2026-08-26",
    officialFingerprint: "fingerprint",
    latestOfficialPublicationDate: "2026-01-01T00:00:00.000Z",
    contentHash,
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    embedding: [1],
  };
}

test("law hydration tolerates reference-ID and ordinal migrations but still verifies exact text", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.searchParams.get("action") === "query"
      ? { query: { pages: [{ revisions: [{ revid: 123, timestamp: "2026-01-01T00:00:00.000Z" }] }] } }
      : { parse: { revid: 123, text: html } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const verifiedHash = createHash("sha256").update(firstSectionText).digest("hex");
  const [chunk] = await hydrateLawEmbeddings([embeddingRecord(verifiedHash)]);
  assert.equal(chunk?.id, "IL-2000416-3");
  assert.equal(chunk?.text, firstSectionText);

  const movedRecord = embeddingRecord(verifiedHash);
  movedRecord.sourceOrdinal = 99;
  const [movedChunk] = await hydrateLawEmbeddings([movedRecord]);
  assert.equal(movedChunk?.text, firstSectionText);

  await assert.rejects(
    hydrateLawEmbeddings([embeddingRecord("0".repeat(64))]),
    /Wikisource no longer reproduces the verified text/u,
  );
});
