import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOfficialFingerprint,
  type KnessetLawBinding,
} from "../src/modules/law/knesset-law.service.js";
import { MONITORED_LAW_SOURCES } from "../src/modules/law/law-source.catalog.js";
import {
  buildLawChunks,
  parseWikisourceLaw,
} from "../src/modules/law/wikisource-law.service.js";

const html = `
  <div id="law-content">
    <div class="law-number">19.</div><div class="law-desc">סיום השכירות</div>
    <div class="law-number2">(א)</div><div class="law-content2">נוסח תקף.</div>
    <div class="law-number2">(ב)</div><div class="law-content2"><span class="law-note">(בוטל).</span></div>
    <div class="law-number">25י.</div><div class="law-desc">ערובה <span class="law-note">[תיקון: תשפ״ו]</span></div>
    <div class="law-number2">(א)</div><div class="law-content2">בסעיף זה –</div>
    <div class="law-content2 law-indent">”נותן ערבות אחר“ – <span class="law-note">(החל מיום 30.9.2026):</span> נוסח עתידי;</div>
    <div class="law-content3 law-indent">הגדרה עתידית;</div>
    <div class="law-content2 law-indent">”ערובה“ – הנוסח התקף.</div>
    <div class="law-number2">(ב)</div><div class="law-content2">ערבות בנקאית, <span class="law-note">(החל מיום 30.9.2026: ערבות מנותן ערבות אחר)</span> או מזומן.</div>
    <div class="law-number">33.</div><div class="law-content1"><span class="law-note">הנוסח שולב בחוק אחר.</span></div>
  </div>`;

test("the monitored source allowlist contains all thirteen selected laws", () => {
  assert.equal(MONITORED_LAW_SOURCES.length, 13);
  assert.equal(new Set(MONITORED_LAW_SOURCES.map((source) => source.israelLawId)).size, 13);
  assert.ok(MONITORED_LAW_SOURCES.some((source) => source.israelLawId === 2_000_596));
  assert.ok(MONITORED_LAW_SOURCES.some((source) => source.israelLawId === 2_000_633));
});

test("Wikisource parsing keeps only provisions effective on the requested date", () => {
  const sections = parseWikisourceLaw(html, "2026-08-25");
  assert.deepEqual(sections.map((section) => section.number), ["19", "25י"]);
  const serialized = JSON.stringify(sections);
  assert.equal(serialized.includes("נותן ערבות אחר"), false);
  assert.equal(serialized.includes("הגדרה עתידית"), false);
});

test("a future effective provision produces different embedding input", () => {
  const current = buildLawChunks(2_000_596, parseWikisourceLaw(html, "2026-08-25"));
  const future = buildLawChunks(2_000_596, parseWikisourceLaw(html, "2026-09-30"));
  assert.notEqual(
    current.find((chunk) => chunk.section === "25י")?.contentHash,
    future.find((chunk) => chunk.section === "25י")?.contentHash,
  );
  assert.match(future.find((chunk) => chunk.section === "25י")?.text ?? "", /נותן ערבות אחר/u);
});

test("repeated section numbers receive stable unique manifest identifiers", () => {
  const clause = (number: string, content: string) => ({
    number,
    title: null,
    content,
    children: [],
  });
  const chunks = buildLawChunks(2_000_237, [
    clause("1", "הסעיף הראשון בחוק הראשי."),
    clause("9", "קצר"),
    clause("2", "סעיף שמספרו ייחודי במקור."),
    clause("1", "פרט מספר אחת בתוספת הראשונה."),
    clause("1", "פרט מספר אחת בתוספת השנייה."),
  ]);

  assert.deepEqual(chunks.map((chunk) => chunk.referenceId), [
    "IL-2000237-1-INSTANCE-1",
    "IL-2000237-2",
    "IL-2000237-1-INSTANCE-2",
    "IL-2000237-1-INSTANCE-3",
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.sourceOrdinal), [0, 1, 2, 3]);
  assert.equal(new Set(chunks.map((chunk) => chunk.referenceId)).size, chunks.length);
});

test("a new Knesset binding changes the official fingerprint", () => {
  const law = {
    IsraelLawID: 2_000_596,
    Name: "חוק השכירות והשאילה, התשל\"א-1971",
    PublicationDate: "1971-08-05T00:00:00",
    LatestPublicationDate: "2026-03-31T14:19:00",
    LawValidityDesc: "תקף",
  };
  const bindings: KnessetLawBinding[] = [
    { LawBindingID: 45_966, LawID: 148_733, IsraelLawID: 2_000_596, BindingType: 6_012 },
    { LawBindingID: 67_580, LawID: 1_046_680, IsraelLawID: 2_000_596, BindingType: 6_013 },
  ];
  const changed = [
    ...bindings,
    { LawBindingID: 99_999, LawID: 9_999_999, IsraelLawID: 2_000_596, BindingType: 6_013 },
  ];
  assert.notEqual(createOfficialFingerprint(law, bindings), createOfficialFingerprint(law, changed));
});
