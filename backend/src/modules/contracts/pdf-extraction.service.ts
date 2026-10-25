
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
      words: Array<{
        text: string;
        bbox: {
          x0: number;
          y0: number;
          x1: number;
          y1: number;
        };
      }>;
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
  if (
    wordCount(
      group.lines.map((line) => line.text).join(" ")
    ) <= MAX_CHUNK_WORDS
  ) {
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
    for (
      let offset = 0;
      offset < words.length;
      offset += TARGET_CHUNK_WORDS
    ) {
      parts.push({
        text: words
          .slice(offset, offset + TARGET_CHUNK_WORDS)
          .join(" "),
        locations: line.locations,
      });
    }
    return parts;
  });

  const parts: LocatedLine[][] = [];
  let current: LocatedLine[] = [];
  let currentWords = 0;

  for (const line of splittableLines) {
    const lineWords = wordCount(line.text);

    if (
      current.length &&
      currentWords + lineWords > MAX_CHUNK_WORDS &&
      currentWords >= TARGET_CHUNK_WORDS * 0.8
    ) {
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

function headingText(rest: string) {
  const text = rest.trim();

  if (
    !text ||
    /[.:;,]$/u.test(text) ||
    wordCount(text) > HEADING_MAX_WORDS
  ) {
    return undefined;
  }

  return text;
}

const NUMBERED_HEADING =
  /^\s*(?:סעיף\s+(\d{1,3}(?:\.\d{1,3})*)[.)\-:\s]+|(\d{1,3}(?:\.\d{1,3})+)[.)\-:]?\s+|(\d{1,3})\s*[.)\-:]\s*)(?=\S)/u;

function numberedHeading(text: string) {
  const match = NUMBERED_HEADING.exec(text);
  const label = match?.[1] ?? match?.[2] ?? match?.[3];

  return match && label
    ? { label, rest: text.slice(match[0].length) }
    : null;
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
      current = {
        id: `C${String(groups.length + 1).padStart(3, "0")}`,
        lines: [],
      };
      groups.push(current);
    }

    if (!current) {
      current = {
        id: `C${String(groups.length + 1).padStart(3, "0")}`,
        lines: [],
      };
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
    .filter((group) =>
      group.lines.some((line) => line.text.trim())
    )
    .flatMap(chunkGroup);
}

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
    Math.max(
      leftX + leftWidth,
      rightX + rightWidth
    ) - x,
    Math.max(
      leftY + leftHeight,
      rightY + rightHeight
    ) - y,
  ];
}

export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
};

type PlacedItem = {
  str: string;
  left: number;
  right: number;
  y: number;
  size: number;
};

const HEBREW_LETTER = /[\u05D0-\u05EA]/u;

function placed(item: PdfTextItem): PlacedItem {
  const left = item.transform[4] ?? 0;

  return {
    str: item.str,
    left,
    right: left + Math.max(item.width, 1),
    y: item.transform[5] ?? 0,
    size: Math.max(
      Math.abs(item.transform[3] ?? 0),
      item.height,
      1
    ),
  };
}

function gapBetween(left: PlacedItem, right: PlacedItem) {
  return Math.max(
    right.left - left.right,
    left.left - right.right
  );
}

function sameWord(left: PlacedItem, right: PlacedItem) {
  return gapBetween(left, right) <
    SAME_WORD_GAP_EM * Math.max(left.size, right.size);
}

function boxOf(items: PlacedItem[]): ClauseLocation["bbox"] {
  return items
    .map(
      (item): ClauseLocation["bbox"] => [
        item.left,
        item.y,
        item.right - item.left,
        item.size,
      ]
    )
    .reduce(unionBox);
}

function contentLines(items: PdfTextItem[]): PlacedItem[][] {
  const lines: PlacedItem[][] = [];
  let current: PlacedItem[] = [];

  for (const item of items) {
    if (item.str.trim()) {
      const next = placed(item);
      const last = current[current.length - 1];

      if (
        last &&
        Math.abs(next.y - last.y) >
          NEW_LINE_BASELINE_EM *
            Math.max(next.size, last.size)
      ) {
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

function contentOrderWords(line: PlacedItem[]) {
  const words: PlacedItem[][] = [];

  for (const item of line) {
    const word = words[words.length - 1];

    if (word && sameWord(word[word.length - 1]!, item)) {
      word.push(item);
    } else {
      words.push([item]);
    }
  }

  return words.map((word) => ({
    text: word.map((item) => item.str).join(""),
    box: boxOf(word),
  }));
}

function rightToLeftWords(line: PlacedItem[]) {
  const visual = [...line].sort(
    (left, right) => left.left - right.left
  );

  const words: PlacedItem[][] = [];

  for (const item of visual) {
    const word = words[words.length - 1];

    if (word && sameWord(word[word.length - 1]!, item)) {
      word.push(item);
    } else {
      words.push([item]);
    }
  }

  return words
    .map((word) => {
      const hebrew = word.some((item) =>
        HEBREW_LETTER.test(item.str)
      );

      const ordered = hebrew ? [...word].reverse() : word;
      let text = ordered.map((item) => item.str).join("");

      if (!hebrew) {
        text = text.replace(/^([.,:;!?]+)(.+)$/u, "$2$1");
      }

      return {
        text,
        box: boxOf(word),
        right: Math.max(...word.map((item) => item.right)),
      };
    })
    .sort((left, right) => right.right - left.right);
}

function writesVisualOrder(lines: PlacedItem[][]) {
  let visual = 0;
  let logical = 0;

  for (const line of lines) {
    const hebrew = line.filter((item) =>
      HEBREW_LETTER.test(item.str)
    );

    for (let index = 1; index < hebrew.length; index += 1) {
      const previous = hebrew[index - 1]!;
      const next = hebrew[index]!;

      if (
        gapBetween(previous, next) >
        NEIGHBOUR_MAX_GAP_EM *
          Math.max(previous.size, next.size)
      ) {
        continue;
      }

      if (next.left >= previous.right - 1) {
        visual += 1;
      } else if (next.right <= previous.left + 1) {
        logical += 1;
      }
    }
  }

  return visual >= 2 && visual > logical;
}

type LineWord = {
  text: string;
  box: ClauseLocation["bbox"];
};

type WordedLine = {
  y: number;
  size: number;
  hebrew: boolean;
  words: LineWord[];
  // Boxes of filled-in values written into a blank of one of the words.
  valueBoxes: ClauseLocation["bbox"][];
};

const BLANK = /_{3,}/gu;
const COVERED_WORD_SHARE = 0.8;

function hasBlank(text: string) {
  return /_{3,}/u.test(text);
}

function baselineTolerance(left: WordedLine, right: WordedLine) {
  return NEW_LINE_BASELINE_EM * Math.max(left.size, right.size);
}

// Splits a page into runs of lines going down the page. A new run starts wherever the content
// stream jumps back up.
function downwardRuns(lines: WordedLine[]) {
  const runs: WordedLine[][] = [];

  for (const line of lines) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];

    if (run && previous && line.y <= previous.y + baselineTolerance(previous, line)) {
      run.push(line);
    } else {
      runs.push([line]);
    }
  }

  return runs;
}

function templateLineFor(line: WordedLine, template: WordedLine[]) {
  let closest: WordedLine | undefined;

  for (const candidate of template) {
    const distance = Math.abs(candidate.y - line.y);

    if (
      distance <= baselineTolerance(candidate, line) &&
      (!closest || distance < Math.abs(closest.y - line.y))
    ) {
      closest = candidate;
    }
  }

  return closest;
}

function horizontalOverlap(
  [leftX, , leftWidth]: ClauseLocation["bbox"],
  [rightX, , rightWidth]: ClauseLocation["bbox"],
) {
  return Math.max(
    0,
    Math.min(leftX + leftWidth, rightX + rightWidth) - Math.max(leftX, rightX)
  );
}

// Where a blank sits on the page, estimated from its place in the word's text. Hebrew runs, and
// neutral runs on a Hebrew line, read from the right edge of the word's box.
function blankCenter(word: LineWord, start: number, end: number, rightToLeftLine: boolean) {
  const [x, , width] = word.box;
  const share = (start + end) / 2 / Math.max(word.text.length, 1);
  const rightToLeft =
    HEBREW_LETTER.test(word.text) ||
    (rightToLeftLine && !/[A-Za-z0-9]/u.test(word.text));

  return rightToLeft ? x + width - share * width : x + share * width;
}

function boxCenter([x, , width]: ClauseLocation["bbox"]) {
  return x + width / 2;
}

function fillTemplateLine(line: WordedLine, values: LineWord[]) {
  // A signature line is only underscores, so the names typed on it decide its direction.
  const rightToLeft =
    line.hebrew ||
    values.some((value) => HEBREW_LETTER.test(value.text));
  const remaining: LineWord[] = [];

  // A value typed over printed words (a white-out over a printed year, say) replaces them.
  for (const value of values) {
    const covered = line.words.filter((word) =>
      word.text &&
      !hasBlank(word.text) &&
      horizontalOverlap(word.box, value.box) >= COVERED_WORD_SHARE * word.box[2]
    );

    if (!covered.length) {
      remaining.push(value);
      continue;
    }

    covered.forEach((word, index) => {
      word.text = index === 0 ? value.text : "";
      if (index === 0) word.box = value.box;
    });
  }

  const ordered = remaining.sort((left, right) =>
    rightToLeft
      ? right.box[0] + right.box[2] - (left.box[0] + left.box[2])
      : left.box[0] - right.box[0]
  );

  const blanks = line.words.flatMap((word) =>
    [...word.text.matchAll(BLANK)].map((match) => ({
      word,
      start: match.index,
      end: match.index + match[0].length,
      center: blankCenter(word, match.index, match.index + match[0].length, rightToLeft),
      values: [] as string[],
    }))
  );

  if (!blanks.length) {
    line.words.push(...ordered);
    return;
  }

  // As many values as blanks: they fill the blanks in reading order. Otherwise each value goes to
  // the blank nearest to it, which lets two names share one signature line.
  ordered.forEach((value, index) => {
    const blank = ordered.length === blanks.length
      ? blanks[index]!
      : blanks.reduce((nearest, candidate) =>
          Math.abs(candidate.center - boxCenter(value.box)) <
            Math.abs(nearest.center - boxCenter(value.box))
            ? candidate
            : nearest
        );

    blank.values.push(value.text);
    line.valueBoxes.push(value.box);
  });

  // From the last blank back, so the offsets of earlier blanks in the same word stay valid.
  for (const blank of [...blanks].reverse()) {
    if (!blank.values.length) continue;

    blank.word.text =
      `${blank.word.text.slice(0, blank.start)} ${blank.values.join(" ")} ${blank.word.text.slice(blank.end)}`;
  }
}

// Filled-in PDF forms often draw the typed values after the whole template, so in content order
// they end up as stray lines at the bottom of the page, cut off from the clause they complete. A
// later run of lines whose values land on a template line with a blank is put back in place: each
// value into the template line it sits on, and a line with no template line under it (a filled
// text box) between the template lines above and below it.
function placeFilledValues(lines: WordedLine[]): WordedLine[] {
  const runs = downwardRuns(lines);
  if (runs.length < 2) return lines;

  const template = runs.reduce((longest, run) =>
    run.length > longest.length ? run : longest
  );

  const filledRuns = new Set(
    runs.filter((run) =>
      run !== template &&
      run.some((line) => {
        const target = templateLineFor(line, template);
        return target?.words.some((word) => hasBlank(word.text));
      })
    )
  );

  if (!filledRuns.size) return lines;

  const values = new Map<WordedLine, LineWord[]>();
  const placed = [...template];

  for (const run of filledRuns) {
    for (const line of run) {
      const target = templateLineFor(line, template);

      if (target) {
        values.set(target, [...(values.get(target) ?? []), ...line.words]);
        continue;
      }

      const below = placed.findIndex((candidate) => candidate.y < line.y);
      placed.splice(below === -1 ? placed.length : below, 0, line);
    }
  }

  values.forEach((words, target) => fillTemplateLine(target, words));

  return runs.flatMap((run) =>
    run === template ? placed : filledRuns.has(run) ? [] : run
  );
}

export function pageLines(
  items: PdfTextItem[],
  page: number
): LocatedLine[] {
  const lines = contentLines(items);
  const visual = writesVisualOrder(lines);

  const wordedLines = lines.map((line): WordedLine => {
    const hebrew = line.some((item) =>
      HEBREW_LETTER.test(item.str)
    );

    const rightToLeft =
      visual &&
      (hebrew || contentOrderWords(line).length === 1);

    const words = rightToLeft
      ? rightToLeftWords(line)
      : contentOrderWords(line);

    return {
      y: line[0]!.y,
      size: Math.max(...line.map((item) => item.size)),
      hebrew,
      words: words.map(({ text, box }) => ({ text, box })),
      valueBoxes: [],
    };
  });

  return placeFilledValues(wordedLines).flatMap((line) => {
    const words = line.words.filter((word) => word.text);

    const text = words
      .map((word) => word.text)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();

    return text
      ? [{
          text,
          locations: [
            ...words.map((word) => word.box),
            ...line.valueBoxes,
          ].map((bbox) => ({ page, bbox })),
        }]
      : [];
  });
}

// Remove repeated headers and page numbers from analysis input.
// The original PDF file remains unchanged.
export function removePageFurniture(
  linesByPage: Map<number, LocatedLine[]>,
  pageHeights: Map<number, number>,
): Map<number, LocatedLine[]> {
  const occurrences = new Map<string, Set<number>>();

  const normalize = (value: string) =>
    value.replace(/\s+/gu, " ").trim();

  const isNearTop = (
    line: LocatedLine,
    pageNumber: number
  ) => {
    const pageHeight = pageHeights.get(pageNumber);

    if (!pageHeight || line.locations.length === 0) {
      return false;
    }

    const topEdge = Math.max(
      ...line.locations.map(
        ({ bbox }) => bbox[1] + bbox[3]
      )
    );

    return (
      pageHeight - topEdge >= -2 &&
      pageHeight - topEdge < 55
    );
  };

  const isNearBottom = (line: LocatedLine) =>
    line.locations.length > 0 &&
    Math.min(
      ...line.locations.map(({ bbox }) => bbox[1])
    ) < 50;

  const isPageCounter = (value: string) =>
    /^(?:(?:עמוד|page)\s*:?\s*\d{1,3}(?:\s*(?:\/|מתוך|of)\s*\d{1,3})?|\d{1,3}\s*\/\s*\d{1,3})$/iu.test(value);

  // Identify the same header on two or more pages.
  for (const [page, lines] of linesByPage) {
    for (const line of lines) {
      if (!isNearTop(line, page)) continue;

      const key = normalize(line.text);
      if (!key) continue;

      const pages =
        occurrences.get(key) ?? new Set<number>();

      pages.add(page);
      occurrences.set(key, pages);
    }
  }

  const repeatedHeaders = new Set(
    [...occurrences.entries()]
      .filter(([, pages]) => pages.size >= 2)
      .map(([text]) => text)
  );

  // Keep the contract clauses but exclude headers and footers.
  return new Map(
    [...linesByPage.entries()].map(([page, lines]) => [
      page,
      lines.filter((line) => {
        const text = normalize(line.text);

        if (
          isNearTop(line, page) &&
          repeatedHeaders.has(text)
        ) {
          return false;
        }

        if (
          isNearBottom(line) &&
          isPageCounter(text)
        ) {
          return false;
        }

        return true;
      }),
    ])
  );
}

export function locatedLinesFromOcrBlocks(
  blocks: OcrBlock[],
  page: number,
  renderScale: number,
  renderedHeight: number,
) {
  return blocks.flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.flatMap<LocatedLine>((line) => {
        const words = line.words.filter(
          (word) => word.text.trim()
        );

        if (!words.length) return [];

        return [{
          text:
            words.map((word) => word.text).join(" ").trim() ||
            line.text.trim(),
          locations: words.map((word) => ({
            page,
            bbox: [
              word.bbox.x0 / renderScale,
              (renderedHeight - word.bbox.y1) / renderScale,
              Math.max(
                1,
                (word.bbox.x1 - word.bbox.x0) / renderScale
              ),
              Math.max(
                1,
                (word.bbox.y1 - word.bbox.y0) / renderScale
              ),
            ],
          })),
        }];
      })
    )
  );
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
      const viewport = page.getViewport({
        scale: renderScale,
      });

      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );

      const context = canvas.getContext("2d");

      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext:
          context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      const result = await worker.recognize(
        canvas.toBuffer("image/png"),
        {},
        { text: true, blocks: true }
      );

      const blocks = result.data.blocks as OcrBlock[] | null;

      if (!blocks?.length && result.data.text.trim()) {
        throw new HttpError(
          422,
          "OCR_COORDINATES_NOT_FOUND",
          `OCR found text on page ${pageNumber} but did not return word coordinates.`
        );
      }

      lines.push(
        ...locatedLinesFromOcrBlocks(
          blocks ?? [],
          pageNumber,
          renderScale,
          viewport.height
        )
      );
    }
  } finally {
    await worker.terminate();
  }

  return lines;
}

export async function extractPdf(buffer: Buffer) {
  const started = performance.now();

  let document: Awaited<
    ReturnType<typeof getDocument>["promise"]
  >;

  try {
    document = await getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
    }).promise;
  } catch {
    throw new HttpError(
      422,
      "INVALID_PDF",
      "The uploaded file is not a readable PDF document."
    );
  }

  if (
    document.numPages < 1 ||
    document.numPages > 100
  ) {
    throw new HttpError(
      422,
      "UNSUPPORTED_PAGE_COUNT",
      "A contract must contain between 1 and 100 pages."
    );
  }

  const linesByPage = new Map<number, LocatedLine[]>();
  const pageHeights = new Map<number, number>();
  const scannedPages: number[] = [];

  for (
    let pageNumber = 1;
    pageNumber <= document.numPages;
    pageNumber += 1
  ) {
    const page = await document.getPage(pageNumber);

    pageHeights.set(
      pageNumber,
      page.getViewport({ scale: 1 }).height
    );

    const content = await page.getTextContent();

    const lines = pageLines(
      content.items.filter(
        (item) => "str" in item
      ) as PdfTextItem[],
      pageNumber
    );

    if (
      lines
        .map((line) => line.text)
        .join(" ")
        .trim().length < 30
    ) {
      scannedPages.push(pageNumber);
    } else {
      linesByPage.set(pageNumber, lines);
    }
  }

  const ocrLines = scannedPages.length
    ? await runOcrPages(document, scannedPages)
    : [];

  for (const pageNumber of scannedPages) {
    linesByPage.set(
      pageNumber,
      ocrLines.filter(
        (line) =>
          line.locations[0]?.page === pageNumber
      )
    );
  }

  // Exclude repeated headers and page numbers.
  const cleanedLinesByPage = removePageFurniture(
    linesByPage,
    pageHeights
  );

  const extractedLines = [
    ...cleanedLinesByPage.entries()
  ]
    .sort(([left], [right]) => left - right)
    .flatMap(([, lines]) => lines);

  const clauses = clausesFromLines(extractedLines);

  if (!clauses.length) {
    throw new HttpError(
      422,
      "CONTRACT_TEXT_NOT_FOUND",
      "No readable contract text was found in the PDF."
    );
  }

  return {
    clauses,
    isScanned: scannedPages.length > 0,
    scannedPages,
    pageCount: document.numPages,
    extractionMs:
      Math.round(performance.now() - started),
  };
}

export function extractClausesFromPlainText(
  text: string
): ContractClause[] {
  return clausesFromLines(
    text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => ({
        text: line,
        locations: [{
          page: 1,
          bbox: [0, 0, 500, 12],
        }],
      }))
  );
}
