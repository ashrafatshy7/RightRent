import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { MonitoredLawSource } from "./law-source.catalog.js";

const WIKISOURCE_API_URL = "https://he.wikisource.org/w/api.php";
const WIKISOURCE_USER_AGENT =
  "RightRent/0.1 (https://github.com/ashrafatshy7/RightRent; law synchronization)";
const WIKISOURCE_MAX_ATTEMPTS = 5;
const WIKISOURCE_RETRY_BASE_MS = 5_000;
const NUMBER_CLASS_RE = /^law-number(\d*)$/u;
const CONTENT_CLASS_RE = /^law-content(\d*)$/u;
const EFFECTIVE_DATE_RE = /החל מיום\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/u;
const MARKER_ONLY_RE = /^\(?החל מיום\s+\d{1,2}\.\d{1,2}\.\d{4}\)?:?$/u;
const INACTIVE_TEXTS = new Set([
  "(בוטל).",
  "(בוטלה).",
  "(בטל).",
  "(בטלה).",
  "בוטל.",
  "בוטלה.",
  "בטל.",
  "בטלה.",
]);
const MAX_EMBEDDING_CHARS = 6_000;

export type ParsedLawClause = {
  number: string;
  title: string | null;
  content: string;
  children: ParsedLawClause[];
};

export type ParsedLawChunk = {
  referenceId: string;
  section: string | null;
  sourceOrdinal: number;
  text: string;
  contentHash: string;
};

type RevisionResponse = {
  query?: {
    pages?: Array<{
      missing?: boolean;
      revisions?: Array<{ revid?: number; timestamp?: string }>;
    }>;
  };
  error?: unknown;
};

type ParseResponse = {
  parse?: { title?: string; revid?: number; text?: string };
  error?: unknown;
};

export type WikisourceLawVersion = {
  title: string;
  sourceUrl: string;
  revisionId: number;
  revisionTimestamp: string;
  sourceAsOf: string;
  chunks: ParsedLawChunk[];
  contentHash: string;
};

function normalizeText(text: string) {
  return text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/־\s+/gu, "־")
    .replace(/\s+([.,;:!?])/gu, "$1")
    .replace(/\s+([\)\]}])/gu, "$1")
    .replace(/([\[({])\s+/gu, "$1")
    .replace(/״\s+/gu, "״")
    .replace(/\s+״/gu, "״");
}

function classes($element: Cheerio<AnyNode>) {
  return ($element.attr("class") ?? "").split(/\s+/u).filter(Boolean);
}

function matchingLevel($element: Cheerio<AnyNode>, pattern: RegExp) {
  for (const className of classes($element)) {
    const match = pattern.exec(className);
    if (match) return Number(match[1] || 1);
  }
  return null;
}

function classify($element: Cheerio<AnyNode>): ["number" | "content" | "desc" | null, number | null] {
  const numberLevel = matchingLevel($element, NUMBER_CLASS_RE);
  if (numberLevel !== null) return ["number", numberLevel];
  const contentLevel = matchingLevel($element, CONTENT_CLASS_RE);
  if (contentLevel !== null) return ["content", contentLevel];
  const classNames = new Set(classes($element));
  if (classNames.has("law-desc") || classNames.has("law-sec-desc")) return ["desc", null];
  return [null, null];
}

function cleanText($: CheerioAPI, element: AnyNode, dropNotes: boolean, extraSelectors: string[] = []) {
  const $clone = $(element).clone();
  const selectors = [".mw-editsection", "sup.reference", ...extraSelectors];
  if (dropNotes) selectors.push(".law-note", ".graytext");
  $clone.find(selectors.join(",")).remove();
  return normalizeText($clone.text());
}

function dateFromNote(text: string) {
  const match = EFFECTIVE_DATE_RE.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function removeDeeperContentSiblings($: CheerioAPI, $owner: Cheerio<AnyNode>, ownerLevel: number) {
  for (const sibling of $owner.nextAll().toArray()) {
    const $sibling = $(sibling);
    const [kind, level] = classify($sibling);
    if ((kind === "number" || kind === "content") && level !== null && level <= ownerLevel) break;
    if (kind === "content" && level !== null && level > ownerLevel) $sibling.remove();
  }
}

function filterByEffectiveDate($: CheerioAPI, asOf: string) {
  for (const note of $("span.law-note").toArray()) {
    const $note = $(note);
    const noteText = normalizeText($note.text());
    const effectiveDate = dateFromNote(noteText);
    if (!effectiveDate) continue;

    const $owner = $note.closest("div").first();
    const [kind, level] = classify($owner);
    const markerOnly = MARKER_ONLY_RE.test(noteText);
    if (effectiveDate > asOf) {
      if (markerOnly && kind === "content" && level !== null) {
        removeDeeperContentSiblings($, $owner, level);
        $owner.remove();
      } else {
        $note.remove();
      }
      continue;
    }

    if (markerOnly) {
      $note.remove();
      continue;
    }
    const activeText = noteText
      .replace(/^\(?החל מיום\s+\d{1,2}\.\d{1,2}\.\d{4}:?\s*/u, "")
      .replace(/\)$/u, "");
    $note.replaceWith(activeText);
  }
}

function hasLawAncestor($: CheerioAPI, element: AnyNode) {
  return $(element).parents().toArray().some((parent) => classify($(parent))[0] !== null);
}

function appendContent(node: ParsedLawClause, text: string) {
  if (text) node.content = node.content ? `${node.content} ${text}` : text;
}

function attachNode(stack: Array<[number, ParsedLawClause]>, level: number, node: ParsedLawClause) {
  while (stack.length && stack.at(-1)![0] >= level) stack.pop();
  const parent = stack.at(-1)?.[1];
  if (!parent) throw new Error("The Wikisource law hierarchy is invalid.");
  parent.children.push(node);
  stack.push([level, node]);
}

function pruneInactive(nodes: ParsedLawClause[]): ParsedLawClause[] {
  return nodes.flatMap((node) => {
    const children = pruneInactive(node.children);
    const content = normalizeText(node.content);
    const inactive = children.length === 0
      && (INACTIVE_TEXTS.has(content) || content.startsWith("הנוסח שולב "));
    return inactive ? [] : [{ ...node, content, children }];
  });
}

export function parseWikisourceLaw(html: string, asOf: string) {
  const $ = cheerio.load(html);
  filterByEffectiveDate($, asOf);
  let $container = $.root() as Cheerio<AnyNode>;
  for (const selector of ["#law-content", "div.law", ".mw-parser-output"]) {
    const $candidate = $(selector).first();
    if ($candidate.length) {
      $container = $candidate as Cheerio<AnyNode>;
      break;
    }
  }

  const root: ParsedLawClause = { number: "", title: null, content: "", children: [] };
  const stack: Array<[number, ParsedLawClause]> = [[0, root]];
  let pendingNode: ParsedLawClause | null = null;
  let pendingLevel: number | null = null;
  let currentAppendix: ParsedLawClause | null = null;

  for (const element of $container.find("div,h2,h3,h4,p").toArray()) {
    const $element = $(element);
    if (element.type === "tag" && element.name === "h2") {
      const heading = cleanText($, element, true);
      if (heading.startsWith("תוספת ")) {
        const appendix: ParsedLawClause = { number: heading, title: null, content: "", children: [] };
        root.children.push(appendix);
        stack.splice(0, stack.length, [0, root], [1, appendix]);
        currentAppendix = appendix;
        pendingNode = null;
        pendingLevel = null;
      } else {
        currentAppendix = null;
      }
      continue;
    }

    if (currentAppendix && element.type === "tag" && element.name === "h3") {
      const heading = cleanText($, element, true);
      if (heading && currentAppendix.title === null) currentAppendix.title = heading;
      continue;
    }
    if (currentAppendix && element.type === "tag" && element.name === "p" && !hasLawAncestor($, element)) {
      const text = cleanText($, element, false);
      if (text && !text.startsWith("[תיקון")) appendContent(currentAppendix, text);
      continue;
    }
    if (element.type !== "tag" || element.name !== "div") continue;

    const [kind, level] = classify($element);
    if (kind === "number" && level !== null) {
      const number = cleanText($, element, true, [".law-desc", ".law-sec-desc"]).replace(/\.$/u, "");
      if (!number) continue;
      const node: ParsedLawClause = { number, title: null, content: "", children: [] };
      attachNode(stack, level, node);
      pendingNode = node;
      pendingLevel = level;
    } else if (kind === "desc" && pendingNode) {
      const title = cleanText($, element, true);
      if (title) pendingNode.title = title;
    } else if (kind === "content" && level !== null) {
      const text = cleanText($, element, false);
      if (pendingNode && pendingLevel === level) {
        appendContent(pendingNode, text);
        pendingNode = null;
        pendingLevel = null;
      } else {
        const current = stack.at(-1)?.[1];
        if (current) appendContent(current, text);
      }
    }
  }
  return pruneInactive(root.children);
}

function renderClause(clause: ParsedLawClause): string {
  return normalizeText([
    clause.number,
    clause.title ?? "",
    clause.content,
    ...clause.children.map(renderClause),
  ].filter(Boolean).join(" "));
}

function splitText(text: string) {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_EMBEDDING_CHARS) {
    const whitespace = remaining.lastIndexOf(" ", MAX_EMBEDDING_CHARS);
    const end = whitespace >= MAX_EMBEDDING_CHARS / 2 ? whitespace : MAX_EMBEDDING_CHARS;
    parts.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function sectionKey(section: string | null, index: number) {
  if (!section) return `ITEM-${index + 1}`;
  return section.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "") || `ITEM-${index + 1}`;
}

export function buildLawChunks(israelLawId: number, clauses: ParsedLawClause[]) {
  const chunks: ParsedLawChunk[] = [];
  for (const [clauseIndex, clause] of clauses.entries()) {
    const textParts = splitText(renderClause(clause));
    for (const [partIndex, text] of textParts.entries()) {
      const baseReference = `IL-${israelLawId}-${sectionKey(clause.number || null, clauseIndex)}`;
      chunks.push({
        referenceId: textParts.length === 1 ? baseReference : `${baseReference}-P${partIndex + 1}`,
        section: clause.number || null,
        sourceOrdinal: chunks.length,
        text,
        contentHash: createHash("sha256").update(text).digest("hex"),
      });
    }
  }
  return chunks;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function fetchJson<T>(url: URL) {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("maxlag", "5");

  for (let attempt = 0; attempt < WIKISOURCE_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(requestUrl, {
      headers: { accept: "application/json", "user-agent": WIKISOURCE_USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const result = await response.json() as T & { error?: { code?: string } };
      if (result.error?.code !== "maxlag") return result;
      if (attempt === WIKISOURCE_MAX_ATTEMPTS - 1) {
        throw new Error(`Wikisource remained unavailable because of replication lag after ${WIKISOURCE_MAX_ATTEMPTS} attempts.`);
      }
    } else {
      const status = response.status;
      const retryAfter = retryAfterMilliseconds(response);
      await response.body?.cancel();
      if (![429, 503].includes(status) || attempt === WIKISOURCE_MAX_ATTEMPTS - 1) {
        throw new Error(`Wikisource returned HTTP ${status} after ${attempt + 1} attempt(s).`);
      }
      const fallback = WIKISOURCE_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 1_000);
      await wait(retryAfter ?? fallback);
      continue;
    }

    const backoff = WIKISOURCE_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 1_000);
    await wait(backoff);
  }

  throw new Error("Wikisource request exhausted its retry limit.");
}

async function fetchRevision(title: string, revisionId?: number) {
  const url = new URL(WIKISOURCE_API_URL);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "ids|timestamp");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  if (revisionId === undefined) {
    url.searchParams.set("titles", title);
    url.searchParams.set("rvlimit", "1");
    url.searchParams.set("redirects", "1");
  } else {
    url.searchParams.set("revids", String(revisionId));
  }
  const response = await fetchJson<RevisionResponse>(url);
  const page = response.query?.pages?.[0];
  const revision = page?.revisions?.[0];
  if (response.error || page?.missing || !revision?.revid || !revision.timestamp) {
    throw new Error(`Wikisource revision was not found for ${title}.`);
  }
  return { revisionId: revision.revid, revisionTimestamp: revision.timestamp };
}

export async function fetchWikisourceLawVersion(
  source: MonitoredLawSource,
  sourceAsOf: string,
  requestedRevisionId?: number,
): Promise<WikisourceLawVersion> {
  const revision = await fetchRevision(source.wikisourceTitle, requestedRevisionId);
  const url = new URL(WIKISOURCE_API_URL);
  url.search = new URLSearchParams({
    action: "parse",
    oldid: String(revision.revisionId),
    prop: "text|revid",
    format: "json",
    formatversion: "2",
  }).toString();
  const response = await fetchJson<ParseResponse>(url);
  if (response.error || response.parse?.revid !== revision.revisionId || !response.parse.text) {
    throw new Error(`Wikisource did not render revision ${revision.revisionId}.`);
  }

  const pageText = normalizeText(cheerio.load(response.parse.text).text());
  if (!pageText.includes(String(source.israelLawId))) {
    throw new Error(`Wikisource page ${source.wikisourceTitle} does not identify law ${source.israelLawId}.`);
  }
  const chunks = buildLawChunks(
    source.israelLawId,
    parseWikisourceLaw(response.parse.text, sourceAsOf),
  ).filter((chunk) => chunk.text.length >= 20);
  if (!chunks.length) throw new Error(`No law sections were extracted from ${source.wikisourceTitle}.`);

  return {
    title: source.wikisourceTitle,
    sourceUrl: `https://he.wikisource.org/wiki/${encodeURIComponent(source.wikisourceTitle.replace(/ /gu, "_"))}`,
    revisionId: revision.revisionId,
    revisionTimestamp: revision.revisionTimestamp,
    sourceAsOf,
    chunks,
    contentHash: createHash("sha256")
      .update(chunks.map((chunk) => chunk.contentHash).join(":"))
      .digest("hex"),
  };
}
