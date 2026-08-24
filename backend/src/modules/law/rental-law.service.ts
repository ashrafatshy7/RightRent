import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { HttpError } from "../../shared/http/http-error.js";

const ISRAEL_LAW_ID = 2_000_596;
const KNESSET_LAW_URL = `https://main.knesset.gov.il/apps/legislation/main/laws/${ISRAEL_LAW_ID}`;
const KNESSET_ODATA_URL = `https://knesset.gov.il/Odata/ParliamentInfo.svc/KNS_IsraelLaw(${ISRAEL_LAW_ID})?$format=json`;
const WIKISOURCE_PAGE_URL = "https://he.wikisource.org/wiki/חוק_השכירות_והשאילה";
const WIKISOURCE_API_URL = "https://he.wikisource.org/w/api.php";

const NUMBER_CLASS_RE = /^law-number(\d*)$/u;
const CONTENT_CLASS_RE = /^law-content(\d*)$/u;
const SECTION_NUMBER_RE = /^\d+[א-ת]{0,2}$/u;
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

export type RentalLawClause = {
  number: string;
  title: string | null;
  content: string;
  children: RentalLawClause[];
};

type KnessetLaw = {
  IsraelLawID: number;
  Name: string;
  PublicationDate: string;
  LatestPublicationDate: string;
  LawValidityDesc: string;
};

type WikisourceParseResponse = {
  parse?: { title?: string; revid?: number; text?: string };
  error?: unknown;
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

function israelDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
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
  return $(element).parents().toArray().some((parent) => {
    const [kind] = classify($(parent));
    return kind !== null;
  });
}

function appendContent(node: RentalLawClause, text: string) {
  if (!text) return;
  node.content = node.content ? `${node.content} ${text}` : text;
}

function attachNode(stack: Array<[number, RentalLawClause]>, level: number, node: RentalLawClause) {
  while (stack.length && stack.at(-1)![0] >= level) stack.pop();
  const parent = stack.at(-1)?.[1];
  if (!parent) throw new Error("The Wikisource law hierarchy is invalid.");
  parent.children.push(node);
  stack.push([level, node]);
}

function pruneInactive(nodes: RentalLawClause[]): RentalLawClause[] {
  return nodes.flatMap((node) => {
    const children = pruneInactive(node.children);
    const content = normalizeText(node.content);
    const inactive = children.length === 0
      && (INACTIVE_TEXTS.has(content) || content.startsWith("הנוסח שולב "));
    return inactive ? [] : [{ ...node, content, children }];
  });
}

export function parseCurrentRentalLaw(html: string, asOf: string) {
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

  const root: RentalLawClause = { number: "", title: null, content: "", children: [] };
  const stack: Array<[number, RentalLawClause]> = [[0, root]];
  let pendingNode: RentalLawClause | null = null;
  let pendingLevel: number | null = null;
  let currentAppendix: RentalLawClause | null = null;

  for (const element of $container.find("div,h2,h3,h4,p").toArray()) {
    const $element = $(element);
    if (element.type === "tag" && element.name === "h2") {
      const heading = cleanText($, element, true);
      if (heading.startsWith("תוספת ")) {
        const appendix: RentalLawClause = { number: heading, title: null, content: "", children: [] };
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
      const node: RentalLawClause = { number, title: null, content: "", children: [] };
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

async function fetchJson<T>(url: string | URL) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RightRent/0.1 law-reader" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function getCurrentRentalLaw() {
  const asOf = israelDate();
  const wikiUrl = new URL(WIKISOURCE_API_URL);
  wikiUrl.search = new URLSearchParams({
    action: "parse",
    page: "חוק השכירות והשאילה",
    format: "json",
    formatversion: "2",
    prop: "text|revid",
  }).toString();

  try {
    const [law, wiki] = await Promise.all([
      fetchJson<KnessetLaw>(KNESSET_ODATA_URL),
      fetchJson<WikisourceParseResponse>(wikiUrl),
    ]);
    if (law.IsraelLawID !== ISRAEL_LAW_ID || law.LawValidityDesc !== "תקף") {
      throw new HttpError(503, "RENTAL_LAW_NOT_VALID", "The rental law is not currently marked as valid by the Knesset.");
    }
    if (wiki.error || !wiki.parse?.text) throw new Error("Wikisource did not return rendered law text.");

    const sections = parseCurrentRentalLaw(wiki.parse.text, asOf);
    const mainSectionCount = sections.filter((section) => SECTION_NUMBER_RE.test(section.number)).length;
    if (mainSectionCount < 40) throw new Error("The parsed rental law is missing too many main sections.");

    return {
      israelLawId: ISRAEL_LAW_ID,
      name: law.Name,
      status: law.LawValidityDesc,
      asOf,
      publicationDate: law.PublicationDate,
      latestOfficialPublicationDate: law.LatestPublicationDate,
      revisionId: wiki.parse.revid ?? null,
      mainSectionCount,
      appendixCount: sections.filter((section) => section.number.startsWith("תוספת ")).length,
      sources: {
        officialMetadata: KNESSET_LAW_URL,
        consolidatedText: WIKISOURCE_PAGE_URL,
      },
      sections,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "RENTAL_LAW_SOURCE_FAILED", "The current rental law could not be retrieved.", {
      reason: error instanceof Error ? error.message : "Unknown upstream error",
    });
  }
}
