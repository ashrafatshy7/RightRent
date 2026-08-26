import type { LawChunk, LawEmbeddingRecord } from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { MONITORED_LAW_SOURCES } from "../law/law-source.catalog.js";
import { fetchWikisourceLawVersion } from "../law/wikisource-law.service.js";

const versionCache = new Map<string, ReturnType<typeof fetchWikisourceLawVersion>>();

function versionKey(record: LawEmbeddingRecord) {
  return `${record.israelLawId}:${record.revisionId}:${record.sourceAsOf}`;
}

async function loadVersion(record: LawEmbeddingRecord) {
  const source = MONITORED_LAW_SOURCES.find((item) => item.israelLawId === record.israelLawId);
  if (!source || source.wikisourceTitle !== record.wikisourceTitle) {
    throw new HttpError(
      503,
      "LAW_SOURCE_INTEGRITY_FAILED",
      `The configured source for law ${record.israelLawId} does not match its active embedding.`,
    );
  }
  const key = versionKey(record);
  let version = versionCache.get(key);
  if (!version) {
    version = fetchWikisourceLawVersion(source, record.sourceAsOf, record.revisionId);
    versionCache.set(key, version);
  }
  try {
    return await version;
  } catch (error) {
    versionCache.delete(key);
    throw error;
  }
}

export async function hydrateLawEmbeddings(records: LawEmbeddingRecord[]): Promise<LawChunk[]> {
  const versions = new Map<string, Awaited<ReturnType<typeof fetchWikisourceLawVersion>>>();
  await Promise.all(records.map(async (record) => {
    const key = versionKey(record);
    if (!versions.has(key)) versions.set(key, await loadVersion(record));
  }));

  return records.map<LawChunk>((record) => {
    const sourceChunk = versions.get(versionKey(record))?.chunks[record.sourceOrdinal];
    if (!sourceChunk
      || sourceChunk.referenceId !== record.referenceId
      || sourceChunk.contentHash !== record.contentHash) {
      throw new HttpError(
        503,
        "LAW_SOURCE_INTEGRITY_FAILED",
        `Wikisource no longer reproduces the verified text for ${record.referenceId}.`,
      );
    }
    return {
      id: record.referenceId,
      israelLawId: record.israelLawId,
      lawName: record.lawName,
      section: record.section,
      kind: "statutory_rule",
      text: sourceChunk.text,
      sourceUrl: `${record.sourceUrl}?oldid=${record.revisionId}`,
      contentHash: record.contentHash,
      revisionId: record.revisionId,
      sourceAsOf: record.sourceAsOf,
    };
  });
}

export async function retrieveLawCorpus(queryEmbedding: number[], topK: number) {
  const records = await (await getStore()).searchLawEmbeddings(queryEmbedding, topK);
  if (!records.length) {
    throw new HttpError(
      503,
      "VERIFIED_LAW_CORPUS_UNAVAILABLE",
      "No verified active law embeddings are available.",
    );
  }
  return hydrateLawEmbeddings(records);
}
