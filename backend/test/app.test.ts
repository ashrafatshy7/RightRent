import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { app } from "../src/app.js";
import { getStore } from "../src/shared/data/store.js";

let server: Server;
let baseUrl: string;
let token: string;
let adminToken: string;
let contractId: string | undefined;
let analysisId: string | undefined;
let secondAnalysisId: string | undefined;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const analysisSchema = JSON.parse(
  await readFile(path.resolve("evaluation/schemas/analysis-result.schema.json"), "utf8"),
);
const validateAnalysis = ajv.compile(analysisSchema);

async function createContractPdf(lines = [
  "[C001]",
  "Lease term is 12 months. Monthly rent is ILS 6000.",
  "[C002]",
  "The tenant shall provide a bank guarantee of ILS 30000.",
]) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  lines.forEach((line, index) => page.drawText(line, { x: 50, y: 780 - index * 28, size: 12, font }));
  const bytes = await document.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function authenticated(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` },
  };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "tenant@example.com", password: "correct-horse-battery-staple" }),
  });
  assert.equal(response.status, 201);
  const registration = await response.json();
  token = registration.token;
  assert.equal(registration.user.role, "TENANT");

  const adminResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "admin-correct-horse-battery-staple" }),
  });
  assert.equal(adminResponse.status, 201);
  const adminRegistration = await adminResponse.json();
  adminToken = adminRegistration.token;
  assert.equal(adminRegistration.user.role, "ADMIN");
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (contractId) await rm(path.resolve("storage/uploads", `${contractId}.pdf`), { force: true });
  if (analysisId) await rm(path.resolve("storage/marked-pdfs", `${analysisId}.pdf`), { force: true });
  if (secondAnalysisId) await rm(path.resolve("storage/marked-pdfs", `${secondAnalysisId}.pdf`), { force: true });
});

test("GET /api/health reports a healthy backend with security headers", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "rightrent-backend");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const readiness = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).status, "ready");
});

test("authentication validates credentials and rejects duplicate accounts", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "TENANT@example.com", password: "correct-horse-battery-staple" }),
  });
  assert.equal(login.status, 200);
  assert.ok((await login.json()).token);

  const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "tenant@example.com", password: "another-secure-password" }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "EMAIL_ALREADY_REGISTERED");
});

test("protected routes require a valid Bearer token", async () => {
  const response = await fetch(`${baseUrl}/api/users/preferences`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "AUTHENTICATION_REQUIRED");
});

test("current-user and law administration enforce the server-side admin allowlist", async () => {
  const me = await fetch(`${baseUrl}/api/auth/me`, authenticated());
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.role, "TENANT");

  const tenantAttempt = await fetch(`${baseUrl}/api/admin/laws/status`, authenticated());
  assert.equal(tenantAttempt.status, 403);
  assert.equal((await tenantAttempt.json()).error.code, "ADMINISTRATOR_REQUIRED");

  const adminStatus = await fetch(`${baseUrl}/api/admin/laws/status`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(adminStatus.status, 200);
  assert.deepEqual((await adminStatus.json()).laws, []);
});

test("cross-site state changes and XSS-shaped JSON are rejected", async () => {
  const localFrontend = await fetch(`${baseUrl}/api/auth/me`, authenticated({
    headers: { origin: "http://127.0.0.1:5173" },
  }));
  assert.equal(localFrontend.status, 200);
  assert.equal(localFrontend.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

  const crossSite = await fetch(`${baseUrl}/api/users/preferences`, authenticated({
    method: "PUT",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({}),
  }));
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, "ORIGIN_NOT_ALLOWED");

  const cookieOnly = await fetch(`${baseUrl}/api/users/preferences`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: "access_token=attacker-controlled",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({}),
  });
  assert.equal(cookieOnly.status, 401);

  const xss = await fetch(`${baseUrl}/api/users/preferences`, authenticated({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxMonthlyRentIls: "<script>alert(1)</script>" }),
  }));
  assert.equal(xss.status, 400);
  assert.equal(xss.headers.get("content-type")?.startsWith("application/json"), true);
  assert.equal((await xss.text()).includes("<script>"), false);
});

test("tenant preferences can be updated and retrieved", async () => {
  const preferences = {
    maxMonthlyRentIls: 7_000,
    repairUrgencyHours: 48,
    leaseLengthMonths: 12,
    maxAnnualRentIncreasePercent: 4,
    petsRequired: true,
    furnishedRequired: false,
    acceptedSecurityKinds: ["BANK_GUARANTEE", "CASH_DEPOSIT", "PROMISSORY_NOTE", "GUARANTOR"],
    maxMonthlyTotalCostIls: null,
    acceptsIndexation: true,
    earlyExitRequired: false,
    roommatesRequired: false,
    renewalOptionRequired: false,
    minEntryNoticeHours: null,
    acceptsBrokerFee: true,
    additionalNotes: "",
  };
  const update = await fetch(`${baseUrl}/api/users/preferences`, authenticated({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preferences),
  }));
  assert.equal(update.status, 200);
  assert.deepEqual((await update.json()).preferences, preferences);

  const get = await fetch(`${baseUrl}/api/users/preferences`, authenticated());
  assert.deepEqual((await get.json()).preferences, preferences);
});

test("POST /api/contracts/upload validates and extracts a PDF", async () => {
  const form = new FormData();
  form.append("contract", new Blob([await createContractPdf()], { type: "application/pdf" }), "lease.pdf");
  const response = await fetch(`${baseUrl}/api/contracts/upload`, authenticated({ method: "POST", body: form }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.contract.status, "EXTRACTED");
  assert.equal(body.contract.originalFileName, "lease.pdf");
  assert.equal(body.contract.clauseCount, 2);
  assert.equal(body.contract.pageCount, 1);
  contractId = body.contract.id;
});

test("the original contract PDF is served only to its owner", async () => {
  assert.ok(contractId);
  const owned = await fetch(`${baseUrl}/api/contracts/${contractId}/file`, authenticated());
  assert.equal(owned.status, 200);
  assert.equal(owned.headers.get("content-type"), "application/pdf");
  assert.equal(owned.headers.get("cache-control"), "private, no-store");
  const bytes = new Uint8Array(await owned.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");

  const foreign = await fetch(`${baseUrl}/api/contracts/${contractId}/file`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).error.code, "CONTRACT_NOT_FOUND");
});

test("contract upload rejects missing, mislabeled, and malformed files", async () => {
  const missing = await fetch(`${baseUrl}/api/contracts/upload`, authenticated({ method: "POST", body: new FormData() }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "CONTRACT_FILE_REQUIRED");

  const wrongType = new FormData();
  wrongType.append("contract", new Blob(["text"], { type: "text/plain" }), "lease.txt");
  const wrongTypeResponse = await fetch(`${baseUrl}/api/contracts/upload`, authenticated({ method: "POST", body: wrongType }));
  assert.equal(wrongTypeResponse.status, 415);

  const malformed = new FormData();
  malformed.append("contract", new Blob(["%PDF-not-valid"], { type: "application/pdf" }), "bad.pdf");
  const malformedResponse = await fetch(`${baseUrl}/api/contracts/upload`, authenticated({ method: "POST", body: malformed }));
  assert.equal(malformedResponse.status, 422);
  assert.equal((await malformedResponse.json()).error.code, "INVALID_PDF");
});

test("analysis returns deterministic legal findings and a marked PDF", async () => {
  assert.ok(contractId);
  const response = await fetch(`${baseUrl}/api/contracts/${contractId}/analyze`, authenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmPreferences: true }),
  }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.analysis.status, "COMPLETED");
  assert.equal(body.analysis.summary.critical, 1);
  assert.equal(validateAnalysis(body.analysis), true, JSON.stringify(validateAnalysis.errors));
  assert.equal(body.analysis.findings.find((item: { clauseId: string }) => item.clauseId === "C002").severity, "RED");
  assert.equal(body.analysis.findings.find((item: { clauseId: string }) => item.clauseId === "C002").legalReferences[0].lawReferenceId, "IL-RLL-25Y-SECURITY-CAP");
  // The guarantee was judged together with the clause that defines the rent and term it is capped by.
  const guarantee = body.analysis.findings.find((item: { clauseId: string }) => item.clauseId === "C002");
  assert.equal(body.analysis.clauseLinking, true);
  assert.deepEqual(guarantee.deterministicChecks[0].sourceClauseIds, ["C001"]);
  const rentLink = guarantee.contextClauses.find((link: { clauseId: string }) => link.clauseId === "C001");
  assert.equal(rentLink.relation, "DEFINES_VALUE");
  assert.equal(rentLink.usedInAnalysis, true);
  analysisId = body.analysis.analysisId;

  const marked = await fetch(`${baseUrl}/api/analyses/${analysisId}/marked-pdf`, authenticated());
  assert.equal(marked.status, 200);
  assert.equal(marked.headers.get("content-type"), "application/pdf");
  assert.ok((await marked.arrayBuffer()).byteLength > 100);
});

test("the cost simulator runs on the analysis's terms and the tenant's saved corrections", async () => {
  assert.ok(analysisId);
  const json = { "content-type": "application/json" };
  const simulate = (scenario: object) => fetch(`${baseUrl}/api/analyses/${analysisId}/cost-simulation`, authenticated({
    method: "POST",
    headers: json,
    body: JSON.stringify({ scenario }),
  }));

  let response = await simulate({ annualInflationPercent: 0 });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.simulation.ready, true);
  assert.equal(body.simulation.totals.total, 72_000);
  assert.equal(body.cpi.source, "ASSUMPTION");

  response = await fetch(`${baseUrl}/api/analyses/${analysisId}/financial-overrides`, authenticated({
    method: "PUT",
    headers: json,
    body: JSON.stringify({ monthlyRent: 5_000 }),
  }));
  assert.equal(response.status, 200);
  // The contract says nothing about leaving early, so leaving after six months is priced at the
  // worst case: rent until the end of the term.
  body = await (await simulate({ annualInflationPercent: 0, exitAfterMonth: 6 })).json();
  assert.equal(body.simulation.totals.total, 60_000);
  assert.equal(body.simulation.lines.find((line: { id: string }) => line.id === "early-exit").amount, 30_000);
  const saved = await (await fetch(`${baseUrl}/api/analyses/${analysisId}`, authenticated())).json();
  assert.deepEqual(saved.analysis.financialOverrides, { monthlyRent: 5_000 });

  const invalid = await fetch(`${baseUrl}/api/analyses/${analysisId}/financial-overrides`, authenticated({
    method: "PUT",
    headers: json,
    body: JSON.stringify({ monthlyRent: -1 }),
  }));
  assert.equal(invalid.status, 400);
  const foreign = await fetch(`${baseUrl}/api/analyses/${analysisId}/cost-simulation`, {
    method: "POST",
    headers: { ...json, authorization: `Bearer ${adminToken}` },
    body: "{}",
  });
  assert.equal(foreign.status, 404);
});

test("a revised contract is uploaded as a new version and compared with the previous one", async () => {
  assert.ok(contractId && analysisId);
  const upload = async (lines: string[], previous?: string, as = token) => {
    const form = new FormData();
    if (previous) form.append("previousContractId", previous);
    form.append("contract", new Blob([await createContractPdf(lines)], { type: "application/pdf" }), "revised.pdf");
    return fetch(`${baseUrl}/api/contracts/upload`, { method: "POST", headers: { authorization: `Bearer ${as}` }, body: form });
  };
  const analyze = async (id: string) => (await (await fetch(`${baseUrl}/api/contracts/${id}/analyze`, authenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmPreferences: true }),
  }))).json()).analysis.analysisId as string;

  // The landlord lowered the guarantee to the legal cap and added a clause.
  const revised = await upload([
    "[C001]",
    "Lease term is 12 months. Monthly rent is ILS 6000.",
    "[C002]",
    "The tenant shall provide a bank guarantee of ILS 18000.",
    "[C003]",
    "The tenant shall pay the building committee fees.",
  ], contractId);
  assert.equal(revised.status, 201);
  const revisedContract = (await revised.json()).contract;
  assert.equal(revisedContract.version, 2);
  assert.equal(revisedContract.previousContractId, contractId);
  const revisedAnalysisId = await analyze(revisedContract.id);

  const response = await fetch(`${baseUrl}/api/comparisons/${analysisId}/${revisedAnalysisId}`, authenticated());
  assert.equal(response.status, 200);
  const { comparison } = await response.json();
  assert.equal(comparison.target.version, 2);
  const fixed = comparison.items.find((item: { status: string }) => item.status === "FIXED");
  assert.deepEqual(fixed.numberChanges, [{ before: "30000", after: "18000" }]);
  assert.ok(comparison.items.some((item: { change: string; after: { clauseIds: string[] } }) => item.change === "ADDED" && item.after.clauseIds[0] === "C003"));

  const history = await (await fetch(`${baseUrl}/api/history`, authenticated())).json();
  const listed = history.analyses.find((item: { analysisId: string }) => item.analysisId === revisedAnalysisId);
  assert.deepEqual(
    [listed.contract.version, listed.contract.rootContractId, listed.contract.previousContractId],
    [2, contractId, contractId],
  );

  // A contract that is not a version of this one cannot be compared with it.
  const unrelated = await upload(["[C001]", "Monthly rent is ILS 5000."]);
  const unrelatedAnalysisId = await analyze((await unrelated.json()).contract.id);
  const mismatch = await fetch(`${baseUrl}/api/comparisons/${analysisId}/${unrelatedAnalysisId}`, authenticated());
  assert.equal(mismatch.status, 409);
  // Another tenant can neither compare these analyses nor attach a version to this contract.
  const foreign = await fetch(`${baseUrl}/api/comparisons/${analysisId}/${revisedAnalysisId}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(foreign.status, 404);
  const foreignVersion = await upload(["[C001]", "Monthly rent is ILS 5000."], contractId, adminToken);
  assert.equal(foreignVersion.status, 404);
  assert.equal((await foreignVersion.json()).error.code, "PREVIOUS_CONTRACT_NOT_FOUND");

  for (const id of [revisedAnalysisId, unrelatedAnalysisId]) {
    assert.equal((await fetch(`${baseUrl}/api/history/${id}`, authenticated({ method: "DELETE" }))).status, 204);
  }
});

test("analysis cache includes the confirmed preference snapshot", async () => {
  assert.ok(contractId);
  assert.ok(analysisId);
  const unchanged = await fetch(`${baseUrl}/api/contracts/${contractId}/analyze`, authenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmPreferences: true }),
  }));
  assert.equal(unchanged.status, 200);
  assert.equal((await unchanged.json()).analysis.analysisId, analysisId);

  const changedPreferences = {
    maxMonthlyRentIls: 5_500,
    repairUrgencyHours: 48,
    leaseLengthMonths: 12,
    maxAnnualRentIncreasePercent: 4,
    petsRequired: true,
    furnishedRequired: false,
    acceptedSecurityKinds: ["BANK_GUARANTEE", "CASH_DEPOSIT", "PROMISSORY_NOTE", "GUARANTOR"],
    maxMonthlyTotalCostIls: null,
    acceptsIndexation: true,
    earlyExitRequired: false,
    roommatesRequired: false,
    renewalOptionRequired: false,
    minEntryNoticeHours: null,
    acceptsBrokerFee: true,
    additionalNotes: "",
  };
  const changed = await fetch(`${baseUrl}/api/contracts/${contractId}/analyze`, authenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmPreferences: true, preferences: changedPreferences }),
  }));
  const body = await changed.json();
  assert.equal(changed.status, 201);
  assert.notEqual(body.analysis.analysisId, analysisId);
  assert.deepEqual(body.analysis.preferencesSnapshot, changedPreferences);
  secondAnalysisId = body.analysis.analysisId;
});

async function negotiationTurn(text: string) {
  const response = await fetch(`${baseUrl}/api/negotiation/${analysisId}/messages`, authenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/u);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  return { events, last: events.at(-1) };
}

test("the negotiation agent talks the tenant from PRIORITIZE to DONE and never sends a message", async () => {
  assert.ok(analysisId);
  const post = (body: object) => fetch(`${baseUrl}/api/negotiation/${analysisId}`, authenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  // Not started yet is a state, not an error.
  let response = await fetch(`${baseUrl}/api/negotiation/${analysisId}`, authenticated());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).negotiation, null);

  response = await post({ action: "START" });
  assert.equal(response.status, 200);
  let negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.state, "PRIORITIZE");
  assert.equal(negotiation.messages.length, 1);
  assert.deepEqual(negotiation.messages[0].quickReplies, ["בלשון זכר", "בלשון נקבה", "בלשון רבים"]);
  assert.equal("modelMessages" in negotiation, false);
  // The agent starts out knowing the tenant's preferences and the whole (redacted) contract.
  const started = await (await getStore()).getNegotiation(analysisId);
  assert.ok(started?.context.preferences.some((line) => line.startsWith("תקציב מקסימלי לשכר דירה חודשי")));
  assert.ok(started?.context.clauses.some((clause) => clause.clauseId === "C002" && /30000/u.test(clause.text)));
  // Each flagged issue says why it was flagged, what the law says, and which preferences it touches.
  const guarantee = started?.issues.find((issue) => issue.issueId === "C002");
  assert.ok(guarantee?.flaggedBecause.includes("סותר את החוק"));
  assert.ok(guarantee?.legalReferences.some((reference) => reference.section === "25י"));
  assert.ok(guarantee?.relevantPreferences.some((line) => line.startsWith("סוגי הבטוחה שהוא מוכן לתת")));

  // A state-skipping action is refused.
  response = await post({ action: "FINALIZE_DRAFT" });
  assert.equal(response.status, 409);

  // Personal details the tenant types never reach the model, but stay visible to the tenant.
  let turn = await negotiationTurn("בלשון נקבה. הטלפון שלי 050-1234567");
  assert.equal(turn.last.type, "result");
  assert.ok(turn.events.some((event) => event.type === "text"));
  negotiation = turn.last.negotiation;
  assert.equal(negotiation.addressForm, "FEMININE");
  const stored = await (await getStore()).getNegotiation(analysisId);
  assert.ok(!JSON.stringify(stored?.modelMessages).includes("050-1234567"));
  assert.ok(JSON.stringify(stored?.modelMessages).includes("[PHONE_NUMBER]"));
  assert.ok(negotiation.messages.some((message: { text: string }) => message.text.includes("050-1234567")));

  turn = await negotiationTurn("הסדר מתאים לי");
  negotiation = turn.last.negotiation;
  assert.equal(negotiation.state, "STRATEGY");
  assert.ok(negotiation.priorities.includes("C002"));

  for (let guard = 0; negotiation.state === "STRATEGY" && guard < 20; guard += 1) {
    const current = negotiation.issues.find((issue: { issueId: string }) => issue.issueId === negotiation.currentIssueId);
    turn = await negotiationTurn(current.legalReferences.length ? "להסתמך על החוק" : "להציע חלופה");
    assert.equal(turn.last.type, "result", JSON.stringify(turn.last));
    negotiation = turn.last.negotiation;
  }
  assert.equal(negotiation.state, "DRAFT");
  assert.match(negotiation.draft.text, /25י/u);
  assert.equal(negotiation.draft.editedByTenant, false);
  assert.ok(negotiation.draft.sources.some((source: { issueId: string }) => source.issueId === "C002"));

  response = await post({ action: "SAVE_DRAFT", draft: `${negotiation.draft.text}\nאשמח לתשובתך.` });
  negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.draft.editedByTenant, true);
  assert.deepEqual(negotiation.draft.warnings, []);

  response = await post({ action: "SAVE_DRAFT", draft: `${negotiation.draft.text}\nלפי סעיף 99 מגיע לי הנחה.` });
  negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.draft.warnings.length, 1);

  response = await post({ action: "FINALIZE_DRAFT" });
  negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.state, "COUNTER");
  assert.ok(negotiation.likelyReplies.length > 0);

  turn = await negotiationTurn("סיימתי");
  assert.equal(turn.last.negotiation.state, "DONE");

  turn = await negotiationTurn("עוד משהו");
  assert.equal(turn.last.type, "error");
  assert.equal(turn.last.error.code, "NEGOTIATION_DONE");

  response = await post({ action: "START", restart: true });
  negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.state, "PRIORITIZE");
  assert.equal(negotiation.messages.length, 1);
});

test("history can be listed and permanently deleted by its owner", async () => {
  assert.ok(analysisId);
  const list = await fetch(`${baseUrl}/api/history`, authenticated());
  assert.equal(list.status, 200);
  assert.equal((await list.json()).analyses.length, 2);

  const deletion = await fetch(`${baseUrl}/api/history/${analysisId}`, authenticated({ method: "DELETE" }));
  assert.equal(deletion.status, 204);
  const missing = await fetch(`${baseUrl}/api/analyses/${analysisId}`, authenticated());
  assert.equal(missing.status, 404);
  const remaining = await fetch(`${baseUrl}/api/history`, authenticated());
  assert.equal((await remaining.json()).analyses.length, 1);
  assert.ok(secondAnalysisId);
  const finalDeletion = await fetch(`${baseUrl}/api/history/${secondAnalysisId}`, authenticated({ method: "DELETE" }));
  assert.equal(finalDeletion.status, 204);
});

test("internal law sync is unavailable until its secret is configured", async () => {
  const response = await fetch(`${baseUrl}/internal/law/sync`, { method: "POST" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "INTERNAL_API_NOT_CONFIGURED");
});

test("unknown routes return the common 404 response", async () => {
  const response = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "ROUTE_NOT_FOUND");
});
