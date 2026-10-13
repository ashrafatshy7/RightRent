import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import { env } from "../../config/env.js";
import type { ClauseLocation, Finding } from "../../domain/models.js";

type Box = ClauseLocation["bbox"];

// Extra room below the baseline so descenders (ק, ך, ץ, commas) sit inside the mark, as in the
// in-app viewer.
const DESCENDER_RATIO = 0.22;
const PADDING = 2;

function union(left: Box, right: Box): Box {
  const x = Math.min(left[0], right[0]);
  const y = Math.min(left[1], right[1]);
  return [
    x,
    y,
    Math.max(left[0] + left[2], right[0] + right[2]) - x,
    Math.max(left[1] + left[3], right[1] + right[3]) - y,
  ];
}

// A clause is stored as one box per word, which drew as a mosaic of word boxes. The extractor groups
// whole lines into a clause, so the union of a clause's boxes on a page covers that clause alone and
// is drawn as a single mark per clause per page.
function clauseBoxesByPage(locations: ClauseLocation[]) {
  const byPage = new Map<number, Box>();
  for (const { page, bbox } of locations) {
    const [x, y, width, height] = bbox;
    const box: Box = [x, y - height * DESCENDER_RATIO, width, height * (1 + DESCENDER_RATIO)];
    const existing = byPage.get(page);
    byPage.set(page, existing ? union(existing, box) : box);
  }
  return byPage;
}

export async function createMarkedPdf(source: Buffer, analysisId: string, findings: Finding[]) {
  const document = await PDFDocument.load(source, { ignoreEncryption: false });
  const pages = document.getPages();

  for (const finding of findings.filter((item) => item.severity !== "OK")) {
    const color = finding.severity === "RED" ? rgb(0.75, 0, 0) : rgb(0.93, 0.49, 0.19);
    for (const [pageNumber, [rawX, rawY, rawWidth, rawHeight]] of clauseBoxesByPage(finding.locations)) {
      const page = pages[pageNumber - 1];
      if (!page) continue;
      const x = Math.max(0, Math.min(rawX - PADDING, page.getWidth()));
      const y = Math.max(0, Math.min(rawY - PADDING, page.getHeight()));
      const width = Math.max(1, Math.min(rawWidth + PADDING * 2, page.getWidth() - x));
      const height = Math.max(1, Math.min(rawHeight + PADDING * 2, page.getHeight() - y));
      page.drawRectangle({
        x,
        y,
        width,
        height,
        color,
        opacity: 0.12,
        borderColor: color,
        borderOpacity: 0.8,
        borderWidth: 1,
      });
    }
  }

  document.setProducer("RightRent");
  document.setSubject("Automated rental-contract review; not legal advice");
  const storageKey = `${analysisId}.pdf`;
  await mkdir(env.markedPdfDirectory, { recursive: true });
  await writeFile(path.join(env.markedPdfDirectory, storageKey), await document.save(), {
    flag: "wx",
    mode: 0o600,
  });
  return storageKey;
}
