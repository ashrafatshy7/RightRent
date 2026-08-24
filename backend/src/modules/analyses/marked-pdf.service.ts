import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import { env } from "../../config/env.js";
import type { Finding } from "../../domain/models.js";

export async function createMarkedPdf(source: Buffer, analysisId: string, findings: Finding[]) {
  const document = await PDFDocument.load(source, { ignoreEncryption: false });
  const pages = document.getPages();

  for (const finding of findings.filter((item) => item.severity !== "OK")) {
    const color = finding.severity === "RED" ? rgb(0.75, 0, 0) : rgb(0.93, 0.49, 0.19);
    for (const location of finding.locations) {
      const page = pages[location.page - 1];
      if (!page) continue;
      const [rawX, rawY, rawWidth, rawHeight] = location.bbox;
      const x = Math.max(0, Math.min(rawX, page.getWidth()));
      const y = Math.max(0, Math.min(rawY, page.getHeight()));
      const width = Math.max(1, Math.min(rawWidth, page.getWidth() - x));
      const height = Math.max(1, Math.min(rawHeight, page.getHeight() - y));
      page.drawRectangle({
        x,
        y,
        width,
        height,
        color,
        opacity: 0.2,
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
