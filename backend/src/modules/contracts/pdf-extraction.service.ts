import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { env } from "../../config/env.js";
import type { ClauseLocation, ContractClause } from "../../domain/models.js";
import { HttpError } from "../../shared/http/http-error.js";

type LocatedLine = {
  text: string;
  location: ClauseLocation;
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
};

function unionLocations(locations: ClauseLocation[]): ClauseLocation[] {
  const byPage = new Map<number, [number, number, number, number]>();
  for (const location of locations) {
    const [x, y, width, height] = location.bbox;
    const existing = byPage.get(location.page);
    if (!existing) {
      byPage.set(location.page, [x, y, width, height]);
      continue;
    }
    const left = Math.min(existing[0], x);
    const bottom = Math.min(existing[1], y);
    const right = Math.max(existing[0] + existing[2], x + width);
    const top = Math.max(existing[1] + existing[3], y + height);
    byPage.set(location.page, [left, bottom, right - left, top - bottom]);
  }
  return [...byPage].map(([page, bbox]) => ({ page, bbox }));
}

function clausesFromLines(lines: LocatedLine[]): ContractClause[] {
  if (!lines.length) return [];

  const explicitMarker = /^\s*\[(C\d{3})\]\s*$/;
  const numberedHeading = /^\s*(?:סעיף\s+)?(\d+(?:\.\d+)*)[.)\-:\s]+/;
  const groups: Array<{ id: string; lines: LocatedLine[] }> = [];
  let current: { id: string; lines: LocatedLine[] } | undefined;

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
    current.lines.push(line);
  }

  const nonEmpty = groups.filter((group) => group.lines.some((line) => line.text.trim()));
  if (nonEmpty.length === 1) {
    const words = nonEmpty[0]!.lines.flatMap((line) => line.text.split(/\s+/).filter(Boolean));
    if (words.length > 350) {
      const chunks: ContractClause[] = [];
      let offset = 0;
      for (let index = 0; offset < nonEmpty[0]!.lines.length; index += 1) {
        const selected: LocatedLine[] = [];
        let count = 0;
        while (offset < nonEmpty[0]!.lines.length && count < 250) {
          const line = nonEmpty[0]!.lines[offset++]!;
          selected.push(line);
          count += line.text.split(/\s+/).filter(Boolean).length;
        }
        chunks.push({
          id: `C${String(index + 1).padStart(3, "0")}`,
          text: selected.map((line) => line.text).join("\n").trim(),
          locations: unionLocations(selected.map((line) => line.location)),
        });
      }
      return chunks;
    }
  }

  return nonEmpty.map((group) => ({
    id: group.id,
    text: group.lines.map((line) => line.text).join("\n").trim(),
    locations: unionLocations(group.lines.map((line) => line.location)),
  }));
}

function pageLines(items: PdfTextItem[], page: number): LocatedLine[] {
  const lines: LocatedLine[] = [];
  let current: { texts: string[]; locations: ClauseLocation[] } = { texts: [], locations: [] };

  function flush() {
    const text = current.texts.join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, location: unionLocations(current.locations)[0]! });
    current = { texts: [], locations: [] };
  }

  for (const item of items) {
    const scaleY = item.transform[3] ?? item.height;
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    current.texts.push(item.str);
    current.locations.push({
      page,
      bbox: [x, y, Math.max(item.width, 1), Math.max(Math.abs(scaleY), item.height, 1)],
    });
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

async function runOcr(document: Awaited<ReturnType<typeof getDocument>["promise"]>) {
  const worker = await createWorker(env.ocrLanguage);
  const lines: LocatedLine[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const result = await worker.recognize(canvas.toBuffer("image/png"));
      const text = result.data.text.replace(/\r/g, "").trim();
      if (text) {
        lines.push({
          text,
          location: {
            page: pageNumber,
            bbox: [0, 0, viewport.width / 2, viewport.height / 2],
          },
        });
      }
    }
  } finally {
    await worker.terminate();
  }
  return lines;
}

export async function extractPdf(buffer: Buffer) {
  let document: Awaited<ReturnType<typeof getDocument>["promise"]>;
  try {
    document = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  } catch {
    throw new HttpError(422, "INVALID_PDF", "The uploaded file is not a readable PDF document.");
  }

  if (document.numPages < 1 || document.numPages > 100) {
    throw new HttpError(422, "UNSUPPORTED_PAGE_COUNT", "A contract must contain between 1 and 100 pages.");
  }

  const lines: LocatedLine[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    lines.push(...pageLines(content.items.filter((item) => "str" in item) as PdfTextItem[], pageNumber));
  }

  const isScanned = lines.map((line) => line.text).join(" ").trim().length < 30;
  const extractedLines = isScanned ? await runOcr(document) : lines;
  const clauses = clausesFromLines(extractedLines);
  if (!clauses.length) {
    throw new HttpError(422, "CONTRACT_TEXT_NOT_FOUND", "No readable contract text was found in the PDF.");
  }

  return { clauses, isScanned, pageCount: document.numPages };
}

export function extractClausesFromPlainText(text: string): ContractClause[] {
  return clausesFromLines(
    text.split(/\r?\n/).filter((line) => line.trim()).map((line) => ({
      text: line,
      location: { page: 1, bbox: [0, 0, 500, 12] },
    })),
  );
}
