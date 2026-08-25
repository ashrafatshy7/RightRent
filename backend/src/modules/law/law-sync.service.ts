import { randomUUID } from "node:crypto";
import type {
  LawEmbeddingRecord,
  LawSourceState,
  LawSourceStatus,
  LawSyncRecord,
  LawSyncStatus,
} from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { embedTexts } from "../analyses/ai-providers.js";
import { fetchOfficialLawState, type OfficialLawState } from "./knesset-law.service.js";
import {
  MONITORED_LAW_SOURCES,
  type MonitoredLawSource,
} from "./law-source.catalog.js";
import {
  fetchWikisourceLawVersion,
  type WikisourceLawVersion,
} from "./wikisource-law.service.js";

const EMBEDDING_BATCH_SIZE = 32;

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

function syncRecord(
  source: MonitoredLawSource,
  status: LawSyncStatus,
  checkedAt: string,
  official: OfficialLawState | null,
  wiki: WikisourceLawVersion | null,
  error: string | null = null,
): LawSyncRecord {
  return {
    id: randomUUID(),
    israelLawId: source.israelLawId,
    status,
    sectionCount: wiki?.chunks.length ?? 0,
    officialFingerprint: official?.fingerprint ?? "",
    wikisourceRevisionId: wiki?.revisionId ?? null,
    contentHash: wiki?.contentHash ?? null,
    checkedAt,
    error,
  };
}

function observedState(
  source: MonitoredLawSource,
  previous: LawSourceState | null,
  official: OfficialLawState,
  wiki: WikisourceLawVersion,
  status: LawSourceStatus,
  checkedAt: string,
  candidate: boolean,
): LawSourceState {
  return {
    israelLawId: source.israelLawId,
    lawName: official.law.Name,
    knessetUrl: official.knessetUrl,
    wikisourceTitle: source.wikisourceTitle,
    wikisourceUrl: wiki.sourceUrl,
    status,
    latestOfficialPublicationDate: official.law.LatestPublicationDate,
    observedOfficialFingerprint: official.fingerprint,
    observedBindingIds: official.bindingIds,
    observedAmendingLawIds: official.amendingLawIds,
    observedRevisionId: wiki.revisionId,
    observedRevisionTimestamp: wiki.revisionTimestamp,
    observedContentHash: wiki.contentHash,
    activeOfficialFingerprint: previous?.activeOfficialFingerprint ?? null,
    activeRevisionId: previous?.activeRevisionId ?? null,
    activeSourceAsOf: previous?.activeSourceAsOf ?? null,
    activeContentHash: previous?.activeContentHash ?? null,
    candidateOfficialFingerprint: candidate ? official.fingerprint : null,
    candidateRevisionId: candidate ? wiki.revisionId : null,
    candidateSourceAsOf: candidate ? wiki.sourceAsOf : null,
    candidateContentHash: candidate ? wiki.contentHash : null,
    checkedAt,
    verifiedAt: previous?.verifiedAt ?? null,
    verifiedBy: previous?.verifiedBy ?? null,
    verificationReference: previous?.verificationReference ?? null,
    error: null,
  };
}

function failedState(
  source: MonitoredLawSource,
  previous: LawSourceState | null,
  checkedAt: string,
  error: string,
): LawSourceState {
  if (previous) return { ...previous, status: "FAILED", checkedAt, error };
  return {
    israelLawId: source.israelLawId,
    lawName: `IsraelLaw ${source.israelLawId}`,
    knessetUrl: `https://main.knesset.gov.il/apps/legislation/main/laws/${source.israelLawId}`,
    wikisourceTitle: source.wikisourceTitle,
    wikisourceUrl: `https://he.wikisource.org/wiki/${encodeURIComponent(source.wikisourceTitle.replace(/ /gu, "_"))}`,
    status: "FAILED",
    latestOfficialPublicationDate: "",
    observedOfficialFingerprint: "",
    observedBindingIds: [],
    observedAmendingLawIds: [],
    observedRevisionId: 0,
    observedRevisionTimestamp: "",
    observedContentHash: "",
    activeOfficialFingerprint: null,
    activeRevisionId: null,
    activeSourceAsOf: null,
    activeContentHash: null,
    candidateOfficialFingerprint: null,
    candidateRevisionId: null,
    candidateSourceAsOf: null,
    candidateContentHash: null,
    checkedAt,
    verifiedAt: null,
    verifiedBy: null,
    verificationReference: null,
    error,
  };
}

async function createEmbeddingRecords(
  official: OfficialLawState,
  wiki: WikisourceLawVersion,
): Promise<LawEmbeddingRecord[]> {
  const records: LawEmbeddingRecord[] = [];
  const createdAt = new Date().toISOString();
  for (let offset = 0; offset < wiki.chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = wiki.chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const vectors = await embedTexts(batch.map((chunk) => chunk.text));
    for (const [index, chunk] of batch.entries()) {
      records.push({
        id: `${official.law.IsraelLawID}:${wiki.revisionId}:${wiki.sourceAsOf}:${chunk.sourceOrdinal}:${chunk.contentHash}`,
        referenceId: chunk.referenceId,
        israelLawId: official.law.IsraelLawID,
        lawName: official.law.Name,
        section: chunk.section,
        sourceOrdinal: chunk.sourceOrdinal,
        sourceUrl: wiki.sourceUrl,
        wikisourceTitle: wiki.title,
        revisionId: wiki.revisionId,
        revisionTimestamp: wiki.revisionTimestamp,
        sourceAsOf: wiki.sourceAsOf,
        officialFingerprint: official.fingerprint,
        latestOfficialPublicationDate: official.law.LatestPublicationDate,
        contentHash: chunk.contentHash,
        status: "CANDIDATE",
        createdAt,
        embedding: vectors[index]!,
      });
    }
  }
  return records;
}

export async function checkMonitoredLaw(source: MonitoredLawSource) {
  const store = await getStore();
  const previous = await store.getLawSourceState(source.israelLawId);
  const checkedAt = new Date().toISOString();
  let official: OfficialLawState | null = null;
  let wiki: WikisourceLawVersion | null = null;

  try {
    official = await fetchOfficialLawState(source);
    wiki = await fetchWikisourceLawVersion(source, israelDate());

    const activeOfficialUnchanged = previous?.activeOfficialFingerprint === official.fingerprint;
    const activeContentUnchanged = previous?.activeContentHash === wiki.contentHash;
    const activeRevisionUnchanged = previous?.activeRevisionId === wiki.revisionId;
    if (activeOfficialUnchanged && activeContentUnchanged && activeRevisionUnchanged) {
      const state = observedState(source, previous, official, wiki, "ACTIVE", checkedAt, false);
      const sync = syncRecord(source, "UNCHANGED", checkedAt, official, wiki);
      await store.recordLawCheck(state, sync);
      return sync;
    }

    const candidateAlreadyStaged = previous?.candidateOfficialFingerprint === official.fingerprint
      && previous.candidateRevisionId === wiki.revisionId
      && previous.candidateContentHash === wiki.contentHash;
    if (candidateAlreadyStaged) {
      const state: LawSourceState = {
        ...observedState(source, previous, official, wiki, "AWAITING_VERIFICATION", checkedAt, false),
        candidateOfficialFingerprint: previous.candidateOfficialFingerprint,
        candidateRevisionId: previous.candidateRevisionId,
        candidateSourceAsOf: previous.candidateSourceAsOf,
        candidateContentHash: previous.candidateContentHash,
      };
      const sync = syncRecord(source, "UNCHANGED", checkedAt, official, wiki);
      await store.recordLawCheck(state, sync);
      return sync;
    }

    if (previous?.activeOfficialFingerprint === official.fingerprint
      && previous.activeRevisionId !== wiki.revisionId) {
      const state = observedState(source, previous, official, wiki, "WIKISOURCE_CHANGED", checkedAt, false);
      const sync = syncRecord(source, "WIKISOURCE_CHANGED", checkedAt, official, wiki);
      await store.recordLawCheck(state, sync);
      return sync;
    }

    if (previous?.activeContentHash === wiki.contentHash) {
      const state = observedState(source, previous, official, wiki, "OFFICIAL_UPDATE_PENDING", checkedAt, false);
      const sync = syncRecord(source, "OFFICIAL_UPDATE_PENDING", checkedAt, official, wiki);
      await store.recordLawCheck(state, sync);
      return sync;
    }

    const embeddings = await createEmbeddingRecords(official, wiki);
    const state = observedState(source, previous, official, wiki, "AWAITING_VERIFICATION", checkedAt, true);
    const sync = syncRecord(source, "CANDIDATE_STAGED", checkedAt, official, wiki);
    await store.stageLawVersion(embeddings, state, sync);
    return sync;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown synchronization error";
    const state = failedState(source, previous, checkedAt, reason);
    const sync = syncRecord(source, "FAILED", checkedAt, official, wiki, reason);
    await store.recordLawCheck(state, sync);
    return sync;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

export function syncLawKnowledgeBase() {
  return mapWithConcurrency(MONITORED_LAW_SOURCES, 2, checkMonitoredLaw);
}

export async function approveLawVersion(
  israelLawId: number,
  revisionId: number,
  verifiedBy: string,
  verificationReference: string,
) {
  if (!MONITORED_LAW_SOURCES.some((source) => source.israelLawId === israelLawId)) {
    throw new HttpError(404, "LAW_NOT_MONITORED", "The requested law is not monitored.");
  }
  const active = await (await getStore()).activateLawVersion(
    israelLawId,
    revisionId,
    verifiedBy,
    verificationReference,
  );
  if (!active) {
    throw new HttpError(
      409,
      "LAW_CANDIDATE_NOT_FOUND",
      "The requested Wikisource revision is not the candidate awaiting verification.",
    );
  }
  return active;
}

export async function getLawMonitoringStatus() {
  return (await getStore()).listLawSourceStates();
}
