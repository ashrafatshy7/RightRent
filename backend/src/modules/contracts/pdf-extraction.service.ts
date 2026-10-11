import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { env } from "../../config/env.js";
import type { ClauseLocation, ContractClause } from "../../domain/models.js";
import { HttpError } from "../../shared/http/http-error.js";

export type LocatedLine = {
  text: string;
  locations: ClauseLocation[];
};

type OcrBlock = {
  paragraphs: Array<{
    lines: Array<{
      text: string;
      words: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
    }>;
  }>;
};

const TARGET_CHUNK_WORDS = 250;
const MAX_CHUNK_WORDS = 300;

function wordCount(text: string) {
  return text.split(/\s+/u).filter(Boolean).length;
}

function locationsForLines(lines: LocatedLine[]) {
  return lines.flatMap((line) => line.locations);
}

type ClauseGroup = {
  id: string;
  lines: LocatedLine[];
  sectionLabel?: string;
  heading?: string;
};

function groupLabels(group: ClauseGroup) {
  return {
    ...(group.sectionLabel ? { sectionLabel: group.sectionLabel } : {}),
    ...(group.heading ? { heading: group.heading } : {}),
  };
}

function chunkGroup(group: ClauseGroup): ContractClause[] {
  if (wordCount(group.lines.map((line) => line.text).join(" ")) <= MAX_CHUNK_WORDS) {
    return [{
      id: group.id,
      text: group.lines.map((line) => line.text).join("\n").trim(),
      locations: locationsForLines(group.lines),
      ...groupLabels(group),
    }];
  }

  const splittableLines = group.lines.flatMap<LocatedLine>((line) => {
    const words = line.text.split(/\s+/u).filter(Boolean);
    if (words.length <= MAX_CHUNK_WORDS) return [line];
    const parts: LocatedLine[] = [];
    for (let offset = 0; offset < words.length; offset += TARGET_CHUNK_WORDS) {
      parts.push({ text: words.slice(offset, offset + TARGET_CHUNK_WORDS).join(" "), locations: line.locations });
    }
    return parts;
  });
  const parts: LocatedLine[][] = [];
  let current: LocatedLine[] = [];
  let currentWords = 0;
  for (const line of splittableLines) {
    const lineWords = wordCount(line.text);
    if (current.length && currentWords + lineWords > MAX_CHUNK_WORDS
      && currentWords >= TARGET_CHUNK_WORDS * 0.8) {
      parts.push(current);
      current = [];
      currentWords = 0;
    }
    current.push(line);
    currentWords += lineWords;
  }
  if (current.length) parts.push(current);

  return parts.map((lines, index) => ({
    id: `${group.id}-P${index + 1}`,
    text: lines.map((line) => line.text).join("\n").trim(),
    locations: locationsForLines(lines),
    ...groupLabels(group),
  }));
}

const HEADING_MAX_WORDS = 7;

// The rest of a numbered line counts as a heading ("9. בטוחות") only when it reads like one: short
// and not ending as a sentence. "5. דמי השכירות הם 6,000 ש״ח." is the clause itself, not a title.
function headingText(rest: string) {
  const text = rest.trim();
  if (!text || /[.:;,]$/u.test(text) || wordCount(text) > HEADING_MAX_WORDS) return undefined;
  return text;
}

// A line that opens a numbered section: "סעיף 9 ...", "9. ...", "9) ...", "9.2 ...". The number is at
// most three digits and must be followed by text, so a wrapped line that merely starts with a year or
// an amount ("2028.", "30 ימים מראש") does not start a new clause.
const NUMBERED_HEADING = /^\s*(?:סעיף\s+(\d{1,3}(?:\.\d{1,3})*)[.)\-:\s]+|(\d{1,3}(?:\.\d{1,3})+)[.)\-:]?\s+|(\d{1,3})\s*[.)\-:]\s*)(?=\S)/u;

function numberedHeading(text: string) {
  const match = NUMBERED_HEADING.exec(text);
  const label = match?.[1] ?? match?.[2] ?? match?.[3];
  return match && label ? { label, rest: text.slice(match[0].length) } : null;
}

function clausesFromLines(lines: LocatedLine[]): ContractClause[] {
  if (!lines.length) return [];

  const explicitMarker = /^\s*\[(C\d{3})\]\s*$/;
  const groups: ClauseGroup[] = [];
  let current: ClauseGroup | undefined;

  for (const line of lines) {
    const marker = explicitMarker.exec(line.text);
    const heading = numberedHeading(line.text);
    if (marker?.[1]) {
      current = { id: marker[1], lines: [] };
      groups.push(current);
      continue;
    }
    if (heading && current?.lines.length) {
      current = { id: `C${String(groups.length + 1).padStart(3, "0")}`, lines: [] };
      groups.push(current);
    }
    if (!current) {
      current = { id: `C${String(groups.length + 1).padStart(3, "0")}`, lines: [] };
      groups.push(current);
    }
    if (heading && !current.lines.length) {
      current.sectionLabel = heading.label;
      const title = headingText(heading.rest);
      if (title) current.heading = title;
    }
    current.lines.push(line);
  }

  return groups
    .filter((group) => group.lines.some((line) => line.text.trim()))
    .flatMap(chunkGroup);
}

// Two consecutive items are one word when the horizontal distance between their boxes is below
// this fraction of the font size (a word space is roughly a quarter of it), and start a new line
// when their baselines are more than half the font size apart.
const SAME_WORD_GAP_EM = 0.15;
const NEW_LINE_BASELINE_EM = 0.5;
const NEIGHBOUR_MAX_GAP_EM = 4;

function unionBox(
  [leftX, leftY, leftWidth, leftHeight]: ClauseLocation["bbox"],
  [rightX, rightY, rightWidth, rightHeight]: ClauseLocation["bbox"],
): ClauseLocation["bbox"] {
  const x = Math.min(leftX, rightX);
  const y = Math.min(leftY, rightY);
  return [
    x,
    y,
    Math.max(leftX + leftWidth, rightX + rightWidth) - x,
    Math.max(leftY + leftHeight, rightY + rightHeight) - y,
  ];
}

export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
};

type PlacedItem = { str: string; left: number; right: number; y: number; size: number };

const HEBREW_LETTER = /[\u05D0-\u05EA]/u;

function placed(item: PdfTextItem): PlacedItem {
  const left = item.transform[4] ?? 0;
  return {
    str: item.str,
    left,
    right: left + Math.max(item.width, 1),
    y: item.transform[5] ?? 0,
    size: Math.max(Math.abs(item.transform[3] ?? 0), item.height, 1),
  };
}

function gapBetween(left: PlacedItem, right: PlacedItem) {
  return Math.max(right.left - left.right, left.left - right.right);
}

function sameWord(left: PlacedItem, right: PlacedItem) {
  return gapBetween(left, right) < SAME_WORD_GAP_EM * Math.max(left.size, right.size);
}

function boxOf(items: PlacedItem[]): ClauseLocation["bbox"] {
  return items
    .map((item): ClauseLocation["bbox"] => [item.left, item.y, item.right - item.left, item.size])
    .reduce(unionBox);
}

// Lines in content order (as the producer wrote them): a new line starts at an explicit end-of-line
// marker or when the baseline moves by more than half the font size.
function contentLines(items: PdfTextItem[]): PlacedItem[][] {
  const lines: PlacedItem[][] = [];
  let current: PlacedItem[] = [];
  for (const item of items) {
    if (item.str.trim()) {
      const next = placed(item);
      const last = current[current.length - 1];
      if (last && Math.abs(next.y - last.y) > NEW_LINE_BASELINE_EM * Math.max(next.size, last.size)) {
        lines.push(current);
        current = [];
      }
      current.push(next);
    }
    if (item.hasEOL && current.length) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

// The producer's order, joining items that touch into one word.
function contentOrderWords(line: PlacedItem[]) {
  const words: PlacedItem[][] = [];
  for (const item of line) {
    const word = words[words.length - 1];
    if (word && sameWord(word[word.length - 1]!, item)) word.push(item);
    else words.push([item]);
  }
  return words.map((word) => ({ text: word.map((item) => item.str).join(""), box: boxOf(word) }));
}

// For a producer that writes visual order, a line with Hebrew is rebuilt from where its items sit:
// items that touch form a word, a word with Hebrew reads right to left and a number or Latin word left
// to right, and the words of the line then read right to left.
function rightToLeftWords(line: PlacedItem[]) {
  const visual = [...line].sort((left, right) => left.left - right.left);
  const words: PlacedItem[][] = [];
  for (const item of visual) {
    const word = words[words.length - 1];
    if (word && sameWord(word[word.length - 1]!, item)) word.push(item);
    else words.push([item]);
  }
  return words
    .map((word) => {
      const hebrew = word.some((item) => HEBREW_LETTER.test(item.str));
      const ordered = hebrew ? [...word].reverse() : word;
      let text = ordered.map((item) => item.str).join("");
      // In a right-to-left line, punctuation after a number is drawn to its left, so a number run
      // arrives as ".2028" or ",7"; it belongs after the number.
      if (!hebrew) text = text.replace(/^([.,:;!?]+)(.+)$/u, "$2$1");
      return { text, box: boxOf(word), right: Math.max(...word.map((item) => item.right)) };
    })
    .sort((left, right) => right.right - left.right);
}

// Whether two consecutive items belong to the same word is decided from geometry, not from item
// boundaries: some PDF producers place every Hebrew glyph as its own text item, and joining items
// with a space then turned "חוזה" into "ח ו ז ה", which silently defeated every text rule downstream
// (deterministic legal checks, the protection checklist, quote matching).
//
// Producers also disagree on the order they write a Hebrew line in. Most write logical order (the
// first word read comes first), but some - Chrome's "print to PDF" among them - write visual order,
// left to right, so "1. מטרת השכירות" arrives as ". מטרת השכירות" followed by "1", and every clause
// number lands at the end of its line. Which one a page uses shows in how consecutive Hebrew items
// advance: leftwards in logical order, rightwards in visual order. The page is read accordingly;
// geometry alone cannot tell a right-to-left paragraph from a left-to-right one (a centered
// "עמוד 1" footer), so logical-order pages keep the producer's order.
function writesVisualOrder(lines: PlacedItem[][]) {
  let visual = 0;
  let logical = 0;
  for (const line of lines) {
    const hebrew = line.filter((item) => HEBREW_LETTER.test(item.str));
    for (let index = 1; index < hebrew.length; index += 1) {
      const previous = hebrew[index - 1]!;
      const next = hebrew[index]!;
      // Only neighbours within a few words of each other vote; table cells far apart on one baseline
      // say nothing about the order of running text.
      if (gapBetween(previous, next) > NEIGHBOUR_MAX_GAP_EM * Math.max(previous.size, next.size)) continue;
      if (next.left >= previous.right - 1) visual += 1;
      else if (next.right <= previous.left + 1) logical += 1;
    }
  }
  return visual >= 2 && visual > logical;
}

export function pageLines(items: PdfTextItem[], page: number): LocatedLine[] {
  const lines = contentLines(items);
  const visual = writesVisualOrder(lines);
  return lines.flatMap((line) => {
    // A line with no Hebrew on a visual-order page is usually the end of a Hebrew sentence that
    // wrapped (".2028"); it is read the same way unless it is a run of several Latin words.
    const rightToLeft = visual && (line.some((item) => HEBREW_LETTER.test(item.str)) || contentOrderWords(line).length === 1);
    const words = rightToLeft ? rightToLeftWords(line) : contentOrderWords(line);
    const text = words.map((word) => word.text).join(" ").replace(/\s+/gu, " ").trim();
    return text ? [{ text, locations: words.map((word) => ({ page, bbox: word.box })) }] : [];
  });
}

export function locatedLinesFromOcrBlocks(
  blocks: OcrBlock[],
  page: number,
  renderScale: number,
  renderedHeight: number,
) {
  return blocks.flatMap((block) => block.paragraphs.flatMap((paragraph) =>
    paragraph.lines.flatMap<LocatedLine>((line) => {
      const words = line.words.filter((word) => word.text.trim());
      if (!words.length) return [];
      return [{
        text: words.map((word) => word.text).join(" ").trim() || line.text.trim(),
        locations: words.map((word) => ({
          page,
          bbox: [
            word.bbox.x0 / renderScale,
            (renderedHeight - word.bbox.y1) / renderScale,
            Math.max(1, (word.bbox.x1 - word.bbox.x0) / renderScale),
            Math.max(1, (word.bbox.y1 - word.bbox.y0) / renderScale),
          ],
        })),
      }];
    })));
}

async function runOcrPages(
  document: Awaited<ReturnType<typeof getDocument>["promise"]>,
  pageNumbers: number[],
) {
  const worker = await createWorker(env.ocrLanguage);
  const lines: LocatedLine[] = [];
  const renderScale = 2;
  try {
    for (const pageNumber of pageNumbers) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const result = await worker.recognize(
        canvas.toBuffer("image/png"),
        {},
        { text: true, blocks: true },
      );
      const blocks = result.data.blocks as OcrBlock[] | null;
      if (!blocks?.length && result.data.text.trim()) {
        throw new HttpError(
          422,
          "OCR_COORDINATES_NOT_FOUND",
          `OCR found text on page ${pageNumber} but did not return word coordinates.`,
        );
      }
      lines.push(...locatedLinesFromOcrBlocks(blocks ?? [], pageNumber, renderScale, viewport.height));
    }
  } finally {
    await worker.terminate();
  }
  return lines;
}

export async function extractPdf(buffer: Buffer) {
  const started = performance.now();
  let document: Awaited<ReturnType<typeof getDocument>["promise"]>;
  try {
    document = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  } catch {
    throw new HttpError(422, "INVALID_PDF", "The uploaded file is not a readable PDF document.");
  }

  if (document.numPages < 1 || document.numPages > 100) {
    throw new HttpError(422, "UNSUPPORTED_PAGE_COUNT", "A contract must contain between 1 and 100 pages.");
  }

  const linesByPage = new Map<number, LocatedLine[]>();
  const scannedPages: number[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = pageLines(content.items.filter((item) => "str" in item) as PdfTextItem[], pageNumber);
    if (lines.map((line) => line.text).join(" ").trim().length < 30) scannedPages.push(pageNumber);
    else linesByPage.set(pageNumber, lines);
  }

  const ocrLines = scannedPages.length ? await runOcrPages(document, scannedPages) : [];
  for (const pageNumber of scannedPages) {
    linesByPage.set(pageNumber, ocrLines.filter((line) => line.locations[0]?.page === pageNumber));
  }
  const extractedLines = [...linesByPage.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, lines]) => lines);
  const clauses = clausesFromLines(extractedLines);
  if (!clauses.length) {
    throw new HttpError(422, "CONTRACT_TEXT_NOT_FOUND", "No readable contract text was found in the PDF.");
  }

  return {
    clauses,
    isScanned: scannedPages.length > 0,
    scannedPages,
    pageCount: document.numPages,
    extractionMs: Math.round(performance.now() - started),
  };
}

export function extractClausesFromPlainText(text: string): ContractClause[] {
  return clausesFromLines(
    text.split(/\r?\n/).filter((line) => line.trim()).map((line) => ({
      text: line,
      locations: [{ page: 1, bbox: [0, 0, 500, 12] }],
    })),
  );
}
