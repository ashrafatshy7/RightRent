import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

process.env.OPENAI_API_KEY = "test-openai-key";

const { approveLawVersion, checkMonitoredLaw } = await import("../src/modules/law/law-sync.service.js");
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

// Serves one monitored law: Knesset metadata that never changes, and whichever Wikisource
// revisions the test has published, with the latest one as the page's current revision.
function mockSources(t: TestContext, source: Source) {
  const revisions = new Map<number, string>();
  let current = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "knesset.gov.il") {
      if (url.pathname.endsWith("KNS_LawBinding")) {
        return Response.json({
          value: [{ LawBindingID: 1, LawID: 10, IsraelLawID: source.israelLawId, BindingType: 6_013 }],
        });
      }
      return Response.json({
        IsraelLawID: source.israelLawId,
        Name: source.wikisourceTitle,
        PublicationDate: "1971-08-05T00:00:00",
        LatestPublicationDate: "2026-03-31T14:19:00",
        LawValidityDesc: "תקף",
      });
    }
    if (url.hostname === "he.wikisource.org" && url.searchParams.get("action") === "query") {
      const revid = Number(url.searchParams.get("revids") ?? current);
      return Response.json({ query: { pages: [{ revisions: [{ revid, timestamp: "2026-09-30T07:00:00Z" }] }] } });
    }
    if (url.hostname === "he.wikisource.org" && url.searchParams.get("action") === "parse") {
      const revid = Number(url.searchParams.get("oldid"));
      return Response.json({ parse: { title: source.wikisourceTitle, revid, text: revisions.get(revid) } });
    }
    if (url.hostname === "api.openai.com") {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: texts.map((_, index) => ({ index, embedding: [1, index] })) });
    }
    throw new Error(`Unexpected request to ${url}`);
  });
  return (revisionId: number, html: string) => {
    revisions.set(revisionId, html);
    current = revisionId;
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

test("a deferred amendment entering into force stages an ordinary candidate", async (t) => {
  const source = { israelLawId: 2_000_596, wikisourceTitle: "חוק השכירות והשאילה" };
  const publish = mockSources(t, source);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T09:00:00Z") });

  publish(100, lawPage(source.israelLawId, `
    <div class="law-content1">המשכיר רשאי לדרוש ערבות בנקאית או מזומן להבטחת חיובי השוכר.</div>
    <div class="law-content1"><span class="law-note">(החל מיום 30.9.2026):</span> המשכיר רשאי לדרוש ערבות בנקאית, ערבות מנותן ערבות אחר או מזומן להבטחת חיובי השוכר.</div>`));
  assert.equal((await checkMonitoredLaw(source)).status, "CANDIDATE_STAGED");
  await approveCandidate(source.israelLawId);

  // On the effective date Wikisource merges the amendment; the Knesset has nothing new to publish.
  t.mock.timers.setTime(Date.parse("2026-10-11T09:00:00Z"));
  publish(200, lawPage(source.israelLawId, `
    <div class="law-content1">המשכיר רשאי לדרוש ערבות בנקאית, ערבות מנותן ערבות אחר או מזומן להבטחת חיובי השוכר.</div>`));
  assert.equal((await checkMonitoredLaw(source)).status, "CANDIDATE_STAGED");

  const state = await (await getStore()).getLawSourceState(source.israelLawId);
  assert.equal(state?.status, "AWAITING_VERIFICATION");
  assert.equal(state?.candidateRevisionId, 200);
  assert.equal(state?.candidateUnmatched, false);
  assert.equal((await approveCandidate(source.israelLawId)).activeRevisionId, 200);
});

test("a Wikisource edit without an official counterpart is staged but flagged", async (t) => {
  const source = { israelLawId: 2_000_292, wikisourceTitle: "חוק החוזים (חלק כללי)" };
  const publish = mockSources(t, source);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T09:00:00Z") });

  publish(300, lawPage(source.israelLawId, `
    <div class="law-content1">חוזה יפורש לפי אומד דעתם של הצדדים כפי שהוא משתמע מתוך החוזה.</div>`));
  await checkMonitoredLaw(source);
  await approveCandidate(source.israelLawId);

  publish(400, lawPage(source.israelLawId, `
    <div class="law-content1">חוזה יפורש לפי אומד דעתם של הצדדים כפי שהוא משתמע מן החוזה ומנסיבות העניין.</div>`));
  assert.equal((await checkMonitoredLaw(source)).status, "WIKISOURCE_CHANGED");
  // The flag survives later checks that find the same candidate already staged.
  assert.equal((await checkMonitoredLaw(source)).status, "UNCHANGED");

  const state = await (await getStore()).getLawSourceState(source.israelLawId);
  assert.equal(state?.status, "WIKISOURCE_CHANGED");
  assert.equal(state?.candidateRevisionId, 400);
  assert.equal(state?.candidateUnmatched, true);

  const active = await approveCandidate(source.israelLawId);
  assert.equal(active.status, "ACTIVE");
  assert.equal(active.candidateUnmatched, false);
});
