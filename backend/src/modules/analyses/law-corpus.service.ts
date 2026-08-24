import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LawChunk } from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";

type SeedCorpus = {
  document: { officialSourceUrl: string };
  sections: Array<{
    id: string;
    section: string | null;
    topic: string;
    kind: LawChunk["kind"];
    summaryHe: string;
  }>;
};

let seedPromise: Promise<LawChunk[]> | undefined;

export function loadSeedLawCorpus() {
  seedPromise ??= (async () => {
    const fileUrl = new URL("../../../evaluation/law/fair-rental-law-sections.json", import.meta.url);
    const corpus = JSON.parse(await readFile(fileUrl, "utf8")) as SeedCorpus;
    return corpus.sections.map((section) => ({
      id: section.id,
      section: section.section,
      topic: section.topic,
      kind: section.kind,
      text: section.summaryHe,
      sourceUrl: corpus.document.officialSourceUrl,
      contentHash: createHash("sha256").update(section.summaryHe).digest("hex"),
      updatedAt: new Date().toISOString(),
    }));
  })();
  return seedPromise;
}

export async function activeLawCorpus() {
  const stored = await (await getStore()).getLawChunks();
  return stored.length ? stored : loadSeedLawCorpus();
}
