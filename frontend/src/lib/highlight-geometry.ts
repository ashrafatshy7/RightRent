import type { ClauseLocation } from "../types/api";

// [x, y, width, height] in PDF user space: origin at the bottom-left of the page, y at the text
// baseline (or at the bottom of an OCR word box).
export type PdfBox = ClauseLocation["bbox"];
export type ScreenRect = { left: number; top: number; width: number; height: number };

// Extra room below the baseline so descenders (ק, ך, ץ, commas) sit inside the highlight.
const DESCENDER_RATIO = 0.22;

function sameLine([, topY, , topHeight]: PdfBox, [, y, , height]: PdfBox) {
  return Math.abs(topY - y) < Math.min(topHeight, height) * 0.5;
}

function union(left: PdfBox, right: PdfBox): PdfBox {
  const x = Math.min(left[0], right[0]);
  const y = Math.min(left[1], right[1]);
  return [
    x,
    y,
    Math.max(left[0] + left[2], right[0] + right[2]) - x,
    Math.max(left[1] + left[3], right[1] + right[3]) - y,
  ];
}

// A clause is stored as one box per word, which would draw as a mosaic. Every printed line belongs
// to exactly one clause (the extractor groups whole lines), so the boxes of a line can be merged
// into a single marker-pen stroke without ever covering another clause's text.
export function lineBoxesByPage(locations: ClauseLocation[]): Map<number, PdfBox[]> {
  const byPage = new Map<number, PdfBox[]>();
  for (const { page, bbox } of locations) {
    const boxes = byPage.get(page) ?? [];
    const line = boxes.findIndex((existing) => sameLine(existing, bbox));
    if (line >= 0) boxes[line] = union(boxes[line]!, bbox);
    else boxes.push([...bbox]);
    byPage.set(page, boxes);
  }
  return byPage;
}

// Maps a PDF box to CSS pixels on the rendered page with the page viewport's transform matrix
// ([a, b, c, d, e, f], as pdf.js reports it). Both corners are transformed and re-ordered, so
// rotated pages and the flipped y axis need no special cases.
export function toScreenRect(
  [x, y, width, height]: PdfBox,
  transform: readonly number[],
  padding = 2,
): ScreenRect {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = transform;
  const bottom = y - height * DESCENDER_RATIO;
  const corners = [[x, bottom], [x + width, y + height]].map(([px, py]) => [
    a * px! + c * py! + e,
    b * px! + d * py! + f,
  ]);
  const xs = corners.map(([cx]) => cx!);
  const ys = corners.map(([, cy]) => cy!);
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  return {
    left,
    top,
    width: Math.max(...xs) + padding - left,
    height: Math.max(...ys) + padding - top,
  };
}

// Where to scroll to show a clause: its first page, and on that page the highest box (the largest
// y, since PDF y grows upwards).
export function firstLocation(locations: ClauseLocation[]): ClauseLocation | null {
  let first: ClauseLocation | null = null;
  for (const location of locations) {
    if (!first
      || location.page < first.page
      || (location.page === first.page && location.bbox[1] > first.bbox[1])) {
      first = location;
    }
  }
  return first;
}
