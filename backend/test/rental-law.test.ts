import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCurrentRentalLaw } from "../src/modules/law/rental-law.service.js";

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

test("rental law parser returns only provisions effective on the requested date", () => {
  const sections = parseCurrentRentalLaw(html, "2026-08-24");
  assert.deepEqual(sections.map((section) => section.number), ["19", "25י"]);
  assert.deepEqual(sections[0]?.children.map((child) => child.number), ["(א)"]);
  const serialized = JSON.stringify(sections);
  assert.equal(serialized.includes("נותן ערבות אחר"), false);
  assert.equal(serialized.includes("הגדרה עתידית"), false);
  assert.match(sections[1]?.children[0]?.content ?? "", /”ערובה“ – הנוסח התקף/u);
  assert.match(sections[1]?.children[1]?.content ?? "", /ערבות בנקאית, או מזומן/u);
});

test("rental law parser activates dated text after its effective date", () => {
  const sections = parseCurrentRentalLaw(html, "2026-09-30");
  const serialized = JSON.stringify(sections);
  assert.equal(serialized.includes("נוסח עתידי"), true);
  assert.equal(serialized.includes("הגדרה עתידית"), true);
  assert.match(serialized, /ערבות מנותן ערבות אחר/u);
});
