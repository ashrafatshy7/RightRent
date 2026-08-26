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

let server: Server;
let baseUrl: string;
let token: string;
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

async function createContractPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  const lines = [
    "[C001]",
    "Lease term is 12 months. Monthly rent is ILS 6000.",
    "[C002]",
    "The tenant shall provide a bank guarantee of ILS 30000.",
  ];
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
  token = (await response.json()).token;
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

test("cross-site state changes and XSS-shaped JSON are rejected", async () => {
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
    acceptsGuarantorRequirement: true,
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
  analysisId = body.analysis.analysisId;

  const marked = await fetch(`${baseUrl}/api/analyses/${analysisId}/marked-pdf`, authenticated());
  assert.equal(marked.status, 200);
  assert.equal(marked.headers.get("content-type"), "application/pdf");
  assert.ok((await marked.arrayBuffer()).byteLength > 100);
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
    acceptsGuarantorRequirement: true,
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

test("negotiation follows PRIORITIZE through DONE and never sends a message", async () => {
  assert.ok(analysisId);
  const post = (body: object) => fetch(`${baseUrl}/api/negotiation/${analysisId}`, authenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  let response = await post({ action: "START" });
  let negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.state, "PRIORITIZE");

  response = await post({ action: "SET_PRIORITIES", clauseIds: ["C002"] });
  negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.state, "STRATEGY");

  response = await post({ action: "CHOOSE_STRATEGY", clauseId: "C002", strategy: "CITE_LAW" });
  negotiation = (await response.json()).negotiation;
  assert.equal(negotiation.state, "DRAFT");
  assert.match(negotiation.draft, /25י/u);

  response = await post({ action: "SAVE_DRAFT", draft: `${negotiation.draft}\nאשמח לתשובתך.` });
  assert.equal((await response.json()).negotiation.state, "COUNTER");
  response = await post({ action: "COMPLETE" });
  assert.equal((await response.json()).negotiation.state, "DONE");
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
