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

export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
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

function clausesFromLines(lines: LocatedLine[]): ContractClause[] {
  if (!lines.length) return [];

  const explicitMarker = /^\s*\[(C\d{3})\]\s*$/;
  const numberedHeading = /^\s*(?:סעיף\s+)?(\d+(?:\.\d+)*)[.)\-:\s]+/;
  const groups: ClauseGroup[] = [];
  let current: ClauseGroup | undefined;

  for (const line of lines) {
    const marker = explicitMarker.exec(line.text);
    const heading = numberedHeading.exec(line.text);
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
    if (heading?.[1] && !current.lines.length) {
      current.sectionLabel = heading[1];
      const title = headingText(line.text.slice(heading[0].length));
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

// Some PDF producers place every Hebrew glyph as its own text item. Joining items with a space then
// turns "חוזה" into "ח ו ז ה", and every text rule downstream (deterministic legal checks, the
// protection checklist, quote matching) silently stops matching. Whether an item continues the
// previous word is therefore decided from geometry, not from item boundaries. The distance is taken
// in whichever direction the boxes are apart, since Hebrew advances right to left and numbers left
// to right, often on the same line.
export function pageLines(items: PdfTextItem[], page: number): LocatedLine[] {
  const lines: LocatedLine[] = [];
  let words: string[] = [];
  let locations: ClauseLocation[] = [];
  let previous: { left: number; right: number; y: number; size: number } | null = null;

  function flush() {
    const text = words.join(" ").replace(/\s+/gu, " ").trim();
    if (text) lines.push({ text, locations });
    words = [];
    locations = [];
    previous = null;
  }

  for (const item of items) {
    if (!item.str.trim()) {
      if (item.hasEOL) flush();
      continue;
    }
    const size = Math.max(Math.abs(item.transform[3] ?? 0), item.height, 1);
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const width = Math.max(item.width, 1);
    const box: ClauseLocation["bbox"] = [x, y, width, size];

    if (previous && Math.abs(y - previous.y) > NEW_LINE_BASELINE_EM * Math.max(size, previous.size)) flush();
    const gap = previous
      ? Math.max(x - previous.right, previous.left - (x + width))
      : Number.POSITIVE_INFINITY;
    if (previous && gap < SAME_WORD_GAP_EM * Math.max(size, previous.size)) {
      words[words.length - 1] += item.str;
      const last = locations[locations.length - 1]!;
      last.bbox = unionBox(last.bbox, box);
    } else {
      words.push(item.str);
      locations.push({ page, bbox: box });
    }
    previous = { left: x, right: x + width, y, size };
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
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
