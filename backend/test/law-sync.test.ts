import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

process.env.OPENAI_API_KEY = "test-openai-key";

const { AUTO_APPROVER, approveLawVersion, checkMonitoredLaw } = await import("../src/modules/law/law-sync.service.js");
const { getStore } = await import("../src/shared/data/store.js");

type Source = { israelLawId: number; wikisourceTitle: string };

function lawPage(israelLawId: number, paragraphs: string) {
  return `
    <p>IsraelLaw ${israelLawId}</p>
    <div id="law-content">
      <div class="law-number">25י.</div><div class="law-desc">ערובה</div>
      <div class="law-main"><div></div>${paragraphs}</div>
    </div>`;
}

function sectionsPage(israelLawId: number, count: number, wording: string) {
  const sections = Array.from({ length: count }, (_, index) =>
    `<div class="law-number">${index + 1}.</div><div class="law-content1">סעיף ${index + 1} ${wording} לעניין חוק זה.</div>`);
  return `<p>IsraelLaw ${israelLawId}</p><div id="law-content">${sections.join("")}</div>`;
}

// Serves one monitored law: Knesset metadata that changes only when the test records an
// amendment, and whichever Wikisource revisions the test has published, each stamped with the
// (mocked) time it was published, with the latest one as the page's current revision.
function mockSources(t: TestContext, source: Source) {
  const revisions = new Map<number, { html: string; timestamp: string }>();
  let current = 0;
  let latestPublicationDate = "2026-03-31T14:19:00";
  const bindings = [{ LawBindingID: 1, LawID: 10, IsraelLawID: source.israelLawId, BindingType: 6_013 }];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "knesset.gov.il") {
      if (url.pathname.endsWith("KNS_LawBinding")) return Response.json({ value: bindings });
      return Response.json({
        IsraelLawID: source.israelLawId,
        Name: source.wikisourceTitle,
        PublicationDate: "1971-08-05T00:00:00",
        LatestPublicationDate: latestPublicationDate,
        LawValidityDesc: "תקף",
      });
    }
    if (url.hostname === "he.wikisource.org" && url.searchParams.get("action") === "query") {
      const revid = Number(url.searchParams.get("revids") ?? current);
      return Response.json({ query: { pages: [{ revisions: [{ revid, timestamp: revisions.get(revid)?.timestamp }] }] } });
    }
    if (url.hostname === "he.wikisource.org" && url.searchParams.get("action") === "parse") {
      const revid = Number(url.searchParams.get("oldid"));
      return Response.json({ parse: { title: source.wikisourceTitle, revid, text: revisions.get(revid)?.html } });
    }
    if (url.hostname === "api.openai.com") {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: texts.map((_, index) => ({ index, embedding: [1, index] })) });
    }
    throw new Error(`Unexpected request to ${url}`);
  });
  return {
    publish(revisionId: number, html: string) {
      revisions.set(revisionId, { html, timestamp: new Date().toISOString() });
      current = revisionId;
    },
    amend(publicationDate: string) {
      latestPublicationDate = publicationDate;
      bindings.push({
        LawBindingID: bindings.length + 1,
        LawID: 10 + bindings.length,
        IsraelLawID: source.israelLawId,
        BindingType: 6_013,
      });
    },
  };
}

async function approveCandidate(israelLawId: number) {
  const state = (await (await getStore()).getLawSourceState(israelLawId))!;
  return approveLawVersion(
    israelLawId,
    state.candidateRevisionId!,
    state.candidateContentHash!,
    state.candidateSectionCount!,
    state.candidateSectionsHash!,
    "Reviewer",
    "Checked against Reshumot",
  );
}

test("a deferred amendment entering into force is approved automatically once Wikisource settles", async (t) => {
  const source = { israelLawId: 2_000_596, wikisourceTitle: "חוק השכירות והשאילה" };
  const { publish } = mockSources(t, source);
  const store = await getStore();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T09:00:00Z") });

  publish(100, lawPage(source.israelLawId, `
    <div class="law-content1">המשכיר רשאי לדרוש ערבות בנקאית או מזומן להבטחת חיובי השוכר.</div>
    <div class="law-content1"><span class="law-note">(החל מיום 30.9.2026):</span> המשכיר רשאי לדרוש ערבות בנקאית, ערבות מנותן ערבות אחר או מזומן להבטחת חיובי השוכר.</div>`));
  assert.equal((await checkMonitoredLaw(source)).status, "CANDIDATE_STAGED");
  await approveCandidate(source.israelLawId);
  const servingLaws = (await store.healthCheck()).activeLawCount;

  // On the effective date Wikisource merges the amendment; the Knesset has nothing new to publish.
  t.mock.timers.setTime(Date.parse("2026-10-11T09:00:00Z"));
  publish(200, lawPage(source.israelLawId, `
    <div class="law-content1">המשכיר רשאי לדרוש ערבות בנקאית, ערבות מנותן ערבות אחר או מזומן להבטחת חיובי השוכר.</div>`));
  assert.equal((await checkMonitoredLaw(source)).status, "CANDIDATE_STAGED");

  let state = await store.getLawSourceState(source.israelLawId);
  assert.equal(state?.status, "AWAITING_VERIFICATION");
  assert.equal(state?.candidateRevisionId, 200);
  assert.equal(state?.candidateUnmatched, false);
  // The approved version keeps serving analysis while the new revision settles.
  assert.equal(state?.activeRevisionId, 100);
  assert.equal((await store.healthCheck()).activeLawCount, servingLaws);

  t.mock.timers.setTime(Date.parse("2026-10-12T10:00:00Z"));
  assert.equal((await checkMonitoredLaw(source)).status, "AUTO_APPROVED");
  state = await store.getLawSourceState(source.israelLawId);
  assert.equal(state?.status, "ACTIVE");
  assert.equal(state?.activeRevisionId, 200);
  assert.equal(state?.verifiedBy, AUTO_APPROVER);
  assert.match(state?.verificationReference ?? "", /deferred amendment/u);
});

test("a Wikisource edit without an official counterpart is flagged and never approved automatically", async (t) => {
  const source = { israelLawId: 2_000_292, wikisourceTitle: "חוק החוזים (חלק כללי)" };
  const { publish } = mockSources(t, source);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T09:00:00Z") });

  publish(300, lawPage(source.israelLawId, `
    <div class="law-content1">חוזה יפורש לפי אומד דעתם של הצדדים כפי שהוא משתמע מתוך החוזה.</div>`));
  await checkMonitoredLaw(source);
  await approveCandidate(source.israelLawId);

  publish(400, lawPage(source.israelLawId, `
    <div class="law-content1">חוזה יפורש לפי אומד דעתם של הצדדים כפי שהוא משתמע מן החוזה ומנסיבות העניין.</div>`));
  assert.equal((await checkMonitoredLaw(source)).status, "WIKISOURCE_CHANGED");
  // The flag survives later checks that find the same candidate already staged, however long
  // the edit stands.
  t.mock.timers.setTime(Date.parse("2026-09-03T09:00:00Z"));
  assert.equal((await checkMonitoredLaw(source)).status, "UNCHANGED");

  const state = await (await getStore()).getLawSourceState(source.israelLawId);
  assert.equal(state?.status, "WIKISOURCE_CHANGED");
  assert.equal(state?.candidateRevisionId, 400);
  assert.equal(state?.candidateUnmatched, true);
  assert.equal(state?.activeRevisionId, 300);

  const active = await approveCandidate(source.israelLawId);
  assert.equal(active.status, "ACTIVE");
  assert.equal(active.candidateUnmatched, false);
});

test("an official amendment consolidated in Wikisource is approved automatically once it settles", async (t) => {
  const source = { israelLawId: 2_000_237, wikisourceTitle: "חוק הגנת הצרכן" };
  const { publish, amend } = mockSources(t, source);
  const store = await getStore();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T09:00:00Z") });

  // The first version of a law always waits for an administrator, however long it has stood.
  publish(500, sectionsPage(source.israelLawId, 10, "בנוסחו המקורי"));
  t.mock.timers.setTime(Date.parse("2026-09-05T09:00:00Z"));
  assert.equal((await checkMonitoredLaw(source)).status, "CANDIDATE_STAGED");
  assert.equal((await store.getLawSourceState(source.israelLawId))?.status, "AWAITING_VERIFICATION");
  await approveCandidate(source.israelLawId);

  // The Knesset publishes an amendment before Wikisource consolidates it.
  t.mock.timers.setTime(Date.parse("2026-09-10T09:00:00Z"));
  amend("2026-09-10T00:00:00");
  assert.equal((await checkMonitoredLaw(source)).status, "OFFICIAL_UPDATE_PENDING");
  assert.equal((await store.getLawSourceState(source.israelLawId))?.activeRevisionId, 500);

  t.mock.timers.setTime(Date.parse("2026-09-12T09:00:00Z"));
  publish(600, sectionsPage(source.israelLawId, 11, "בנוסחו המתוקן"));
  assert.equal((await checkMonitoredLaw(source)).status, "CANDIDATE_STAGED");

  t.mock.timers.setTime(Date.parse("2026-09-13T10:00:00Z"));
  assert.equal((await checkMonitoredLaw(source)).status, "AUTO_APPROVED");
  const state = await store.getLawSourceState(source.israelLawId);
  assert.equal(state?.status, "ACTIVE");
  assert.equal(state?.activeRevisionId, 600);
  assert.equal(state?.activeSectionCount, 11);
  assert.equal(state?.verifiedBy, AUTO_APPROVER);
  assert.match(state?.verificationReference ?? "", /Knesset publication of 2026-09-10/u);
});

test("a collapsed section manifest waits for review even with an official amendment", async (t) => {
  const source = { israelLawId: 2_000_230, wikisourceTitle: "חוק הגנת הדייר" };
  const { publish, amend } = mockSources(t, source);
  const store = await getStore();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T09:00:00Z") });

  publish(700, sectionsPage(source.israelLawId, 10, "בנוסחו המקורי"));
  await checkMonitoredLaw(source);
  await approveCandidate(source.israelLawId);

  amend("2026-09-01T00:00:00");
  publish(800, sectionsPage(source.israelLawId, 4, "בנוסחו המתוקן"));
  assert.equal((await checkMonitoredLaw(source)).status, "CANDIDATE_STAGED");

  t.mock.timers.setTime(Date.parse("2026-09-03T09:00:00Z"));
  assert.equal((await checkMonitoredLaw(source)).status, "UNCHANGED");
  const state = await store.getLawSourceState(source.israelLawId);
  assert.equal(state?.status, "AWAITING_VERIFICATION");
  assert.equal(state?.candidateRevisionId, 800);
  assert.equal(state?.activeRevisionId, 700);
});
