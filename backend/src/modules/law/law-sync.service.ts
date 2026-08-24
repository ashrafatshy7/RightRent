import { createHash, randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { LawChunk, LawSyncRecord } from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { embedText } from "../analyses/ai-providers.js";

type SourceSection = { id?: string; section?: string | null; topic?: string; title?: string; text: string };

type SourceClause = {
  number?: string;
  title?: string | null;
  content?: string;
  children?: SourceClause[];
};

function renderClause(clause: SourceClause): string {
  return [
    clause.number,
    clause.title ?? undefined,
    clause.content,
    ...(clause.children ?? []).map(renderClause),
  ].filter((value): value is string => Boolean(value?.trim())).join(" ");
}

function decodeHtml(text: string) {
  const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return entities[entity.toLowerCase()] ?? match;
  });
}

function parseSource(body: string, contentType: string): SourceSection[] {
  if (contentType.includes("json")) {
    const parsed = JSON.parse(body) as unknown;
    const sections = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "sections" in parsed
        ? (parsed as { sections: unknown }).sections
        : null;
    if (!Array.isArray(sections)) throw new Error("JSON source must contain a sections array.");
    return sections.flatMap<SourceSection>((value) => {
      if (typeof value !== "object" || value === null) return [];
      if ("text" in value && typeof value.text === "string") return [value as SourceSection];
      const clause = value as SourceClause;
      const text = renderClause(clause);
      if (!text) return [];
      const section: SourceSection = { section: clause.number ?? null, text };
      if (clause.title) section.title = clause.title;
      return [section];
    });
  }

  const plain = decodeHtml(
    body
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");

  const parts = plain.split(/(?=\n\s*(?:סעיף\s+)?25[א-ת]?\b)/u).map((part) => part.trim()).filter(Boolean);
  return parts.map((text) => ({
    section: /^(?:סעיף\s+)?(25[א-ת]?)/u.exec(text)?.[1] ?? null,
    text,
  }));
}

function stableId(section: SourceSection, index: number) {
  if (section.id) return section.id;
  if (section.section === "25י") return "IL-RLL-25Y-SECURITY-CAP";
  if (section.section === "25ח") return "IL-RLL-25H-REPAIRS";
  if (section.section === "25ו") return "IL-RLL-25F-HABITABILITY";
  return `IL-RLL-${section.section ?? String(index + 1).padStart(3, "0")}`;
}

export async function syncLawKnowledgeBase() {
  if (!env.lawSourceUrl) {
    throw new HttpError(503, "LAW_SOURCE_NOT_CONFIGURED", "LAW_SOURCE_URL is not configured.");
  }
  if (env.nodeEnv === "production" && !env.lawSourceUrl.startsWith("https://")) {
    throw new HttpError(500, "INSECURE_LAW_SOURCE", "LAW_SOURCE_URL must use HTTPS in production.");
  }

  const store = await getStore();
  const syncId = randomUUID();
  const syncedAt = new Date().toISOString();
  try {
    const response = await fetch(env.lawSourceUrl, {
      headers: { accept: "application/json, text/html;q=0.9, text/plain;q=0.8" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Law source returned HTTP ${response.status}.`);
    const body = await response.text();
    if (Buffer.byteLength(body) > 5 * 1024 * 1024) throw new Error("Law source response exceeds 5 MB.");
    const contentHash = createHash("sha256").update(body).digest("hex");
    const sourceSections = parseSource(body, response.headers.get("content-type") ?? "text/plain")
      .filter((section) => section.text.trim().length >= 20);
    if (sourceSections.length < 3) throw new Error("Fewer than three valid law sections were extracted.");

    const chunks: LawChunk[] = [];
    for (const [index, section] of sourceSections.entries()) {
      const text = section.text.trim();
      chunks.push({
        id: stableId(section, index),
        section: section.section ?? null,
        topic: section.topic ?? section.title ?? "fair_rental_law",
        kind: "statutory_rule",
        text,
        sourceUrl: env.lawSourceUrl,
        contentHash: createHash("sha256").update(text).digest("hex"),
        updatedAt: syncedAt,
        embedding: await embedText(text),
      });
    }

    const sync: LawSyncRecord = {
      id: syncId,
      sourceUrl: env.lawSourceUrl,
      status: "COMPLETED",
      sectionCount: chunks.length,
      contentHash,
      syncedAt,
    };
    await store.replaceLawChunks(chunks, sync);
    return sync;
  } catch (error) {
    const failed: LawSyncRecord = {
      id: syncId,
      sourceUrl: env.lawSourceUrl,
      status: "FAILED",
      sectionCount: 0,
      contentHash: "",
      syncedAt,
      error: error instanceof Error ? error.message : "Unknown synchronization error",
    };
    await store.saveLawSync(failed);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "LAW_SYNC_FAILED", "The law knowledge base could not be synchronized.", { reason: failed.error });
  }
}
