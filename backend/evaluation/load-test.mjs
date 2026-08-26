import { readFile } from "node:fs/promises";
import path from "node:path";

if (process.env.RIGHTRENT_LOAD_CONFIRM_DISPOSABLE !== "true") {
  throw new Error("Set RIGHTRENT_LOAD_CONFIRM_DISPOSABLE=true only for a disposable staging database.");
}
const baseUrl = process.env.RIGHTRENT_BASE_URL;
const pdfPath = process.env.RIGHTRENT_LOAD_PDF;
if (!baseUrl || !pdfPath) throw new Error("RIGHTRENT_BASE_URL and RIGHTRENT_LOAD_PDF are required.");
const pdf = await readFile(path.resolve(pdfPath));
const runId = Date.now();

async function checked(response, operation) {
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function scenario(index) {
  const email = `load-${runId}-${index}@rightrent.test`;
  const password = `RightRent-load-${runId}-${index}`;
  const registration = await checked(await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }), "register");
  const headers = { authorization: `Bearer ${registration.token}` };
  const form = new FormData();
  form.append("contract", new Blob([pdf], { type: "application/pdf" }), `load-${index}.pdf`);
  const upload = await checked(await fetch(`${baseUrl}/api/contracts/upload`, {
    method: "POST",
    headers,
    body: form,
  }), "upload");
  const started = performance.now();
  const analysis = await checked(await fetch(`${baseUrl}/api/contracts/${upload.contract.id}/analyze`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ confirmPreferences: true }),
  }), "analyze");
  const durationMs = Math.round(performance.now() - started);
  await checked(await fetch(`${baseUrl}/api/history/${analysis.analysis.analysisId}`, {
    method: "DELETE",
    headers,
  }), "cleanup");
  return { index, durationMs, backendTotalMs: analysis.analysis.timingMs.total };
}

const results = await Promise.all(Array.from({ length: 10 }, (_, index) => scenario(index + 1)));
const failures = results.filter((result) => result.durationMs > 90_000 || result.backendTotalMs > 90_000);
console.log(JSON.stringify({ users: results.length, results, passed: failures.length === 0 }, null, 2));
if (failures.length) process.exitCode = 1;
