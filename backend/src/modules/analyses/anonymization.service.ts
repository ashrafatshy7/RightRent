import { env } from "../../config/env.js";
import type { ContractClause } from "../../domain/models.js";
import { HttpError } from "../../shared/http/http-error.js";

type RedactionRule = {
  pattern: RegExp;
  replacement: string;
};

const rules: RedactionRule[] = [
  { pattern: /(?:תעודת\s+זהות|ת["״']?ז)\s*[:#-]?\s*\d{9}\b/gu, replacement: "תעודת זהות [ID_NUMBER]" },
  { pattern: /(?:דרכון|מספר\s+דרכון)\s*[:#-]?\s*[A-Z0-9]{6,12}\b/giu, replacement: "דרכון [PASSPORT_NUMBER]" },
  { pattern: /\b(?:\+972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}\b/gu, replacement: "[PHONE_NUMBER]" },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, replacement: "[EMAIL_ADDRESS]" },
  {
    pattern: /(?:ברחוב|רחוב)\s+[\p{Script=Hebrew}\d'"״\- ]+(?:,\s*[\p{Script=Hebrew}\- ]+)?(?=[.,\n]|$)/gu,
    replacement: "בכתובת [ADDRESS]",
  },
  {
    pattern: /(?:המשכיר|המשכירה)\s+([\p{Script=Hebrew}'-]{2,}\s+[\p{Script=Hebrew}'-]{2,})(?=\s*[,،])/gu,
    replacement: "$ROLE_LANDLORD",
  },
  {
    pattern: /(?:השוכר|השוכרת)\s+([\p{Script=Hebrew}'-]{2,}\s+[\p{Script=Hebrew}'-]{2,})(?=\s*[,،])/gu,
    replacement: "$ROLE_TENANT",
  },
  {
    pattern: /משכיר\s+ל([\p{Script=Hebrew}'-]{2,}\s+[\p{Script=Hebrew}'-]{2,})(?=\s*[,،])/gu,
    replacement: "משכיר ל[TENANT_NAME]",
  },
  { pattern: /(?:חשבון\s+בנק|מספר\s+חשבון)\s*[:#-]?\s*\d{4,14}\b/gu, replacement: "חשבון בנק [BANK_ACCOUNT]" },
  { pattern: /\bIL\d{21}\b/giu, replacement: "[IBAN]" },
  { pattern: /\b\d{9}\b/gu, replacement: "[ID_NUMBER]" },
];

const residualDirectIdentifierPatterns = [
  /\b\d{9}\b/u,
  /\b(?:\+972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}\b/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\bIL\d{21}\b/iu,
];

type NerEndpointResponse = {
  model: string;
  items: Array<{ text: string; entityCount: number }>;
};

function applyRegexRules(clauses: ContractClause[]) {
  let entityCount = 0;
  const redacted = clauses.map((clause) => {
    let text = clause.text;
    for (const rule of rules) {
      text = text.replace(rule.pattern, (...args) => {
        entityCount += 1;
        if (rule.replacement === "$ROLE_LANDLORD") {
          return String(args[0]).replace(String(args[1] ?? ""), "[LANDLORD_NAME]");
        }
        if (rule.replacement === "$ROLE_TENANT") {
          return String(args[0]).replace(String(args[1] ?? ""), "[TENANT_NAME]");
        }
        return rule.replacement;
      });
    }
    return { ...clause, text };
  });
  return { clauses: redacted, entityCount };
}

function nerUrl(pathname: string) {
  const base = env.piiNerEndpoint.endsWith("/") ? env.piiNerEndpoint : `${env.piiNerEndpoint}/`;
  return new URL(pathname, base);
}

export async function redactWithDictaBert(
  texts: string[],
  fetcher: typeof fetch = fetch,
): Promise<NerEndpointResponse> {
  const response = await fetcher(nerUrl("redact"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.piiNerToken ? { "x-ner-token": env.piiNerToken } : {}),
    },
    body: JSON.stringify({ texts, minimumConfidence: env.piiNerMinimumConfidence }),
    signal: AbortSignal.timeout(env.piiNerTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(503, "PII_NER_UNAVAILABLE", `The local Hebrew NER service returned HTTP ${response.status}.`);
  }
  const payload = await response.json() as Partial<NerEndpointResponse>;
  if (!payload.model || !Array.isArray(payload.items) || payload.items.length !== texts.length
    || payload.items.some((item) => typeof item?.text !== "string"
      || !Number.isInteger(item.entityCount) || item.entityCount < 0)) {
    throw new HttpError(503, "PII_NER_INVALID_RESPONSE", "The local Hebrew NER service returned an invalid response.");
  }
  return payload as NerEndpointResponse;
}

function assertNoDirectIdentifiers(clauses: ContractClause[]) {
  const remaining = clauses.map((clause) => clause.text).join("\n");
  if (residualDirectIdentifierPatterns.some((pattern) => pattern.test(remaining))) {
    throw new HttpError(
      422,
      "PII_REDACTION_FAILED",
      "A direct identifier remained after local redaction; analysis was stopped before any cloud request.",
    );
  }
}

export async function redactClauses(clauses: ContractClause[]) {
  const regex = applyRegexRules(clauses);
  if (env.piiNerMode === "regex") {
    assertNoDirectIdentifiers(regex.clauses);
    return {
      clauses: regex.clauses,
      redactedEntityCount: regex.entityCount,
      mode: "REGEX_TEST_ONLY" as const,
      model: null,
    };
  }

  const ner = await redactWithDictaBert(regex.clauses.map((clause) => clause.text));
  const redacted = regex.clauses.map((clause, index) => ({ ...clause, text: ner.items[index]!.text }));
  assertNoDirectIdentifiers(redacted);
  return {
    clauses: redacted,
    redactedEntityCount: regex.entityCount
      + ner.items.reduce((total, item) => total + item.entityCount, 0),
    mode: "REGEX_AND_DICTABERT" as const,
    model: ner.model,
  };
}

export async function checkNerReadiness(fetcher: typeof fetch = fetch) {
  if (env.piiNerMode === "regex") return { ready: env.analysisProvider !== "anthropic", model: null };
  try {
    const response = await fetcher(nerUrl("health"), {
      headers: env.piiNerToken ? { "x-ner-token": env.piiNerToken } : {},
      signal: AbortSignal.timeout(Math.min(env.piiNerTimeoutMs, 5_000)),
    });
    if (!response.ok) return { ready: false, model: null };
    const payload = await response.json() as { model?: unknown; ready?: unknown };
    return {
      ready: payload.ready === true && typeof payload.model === "string",
      model: typeof payload.model === "string" ? payload.model : null,
    };
  } catch {
    return { ready: false, model: null };
  }
}
