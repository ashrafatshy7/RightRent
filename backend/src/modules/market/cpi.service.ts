import { env } from "../../config/env.js";

// The Israeli consumer price index, read from the Central Bureau of Statistics (הלמ"ס) public API, so
// the cost simulator can project an index-linked rent with real inflation instead of a guess. Only
// public index data is requested; nothing about the tenant or the contract leaves the server.

const CBS_GENERAL_CPI_ID = 120010;
const CBS_PRICE_URL = "https://api.cbs.gov.il/index/data/price";
const CACHE_MS = 24 * 60 * 60 * 1_000;
const TIMEOUT_MS = 5_000;
// Used only when the CBS has never been reachable from this server; shown as an assumption.
export const FALLBACK_ANNUAL_PERCENT = 2.5;

export type CpiSnapshot = {
  source: "CBS" | "ASSUMPTION";
  // "2026-08": the latest month the index was published for.
  latestPeriod: string | null;
  last12MonthsPercent: number;
  // Monthly changes, oldest first, for the months returned.
  monthly: Array<{ period: string; percent: number }>;
  fetchedAt: string;
};

type CbsResponse = {
  month?: Array<{
    date?: Array<{ year?: number; month?: number; percent?: number; percentYear?: number }>;
  }>;
};

// The API reports each month's change from the previous month (`percent`) and over the last twelve
// months (`percentYear`). Index values are relative to a base period that changes every few years,
// so changes are used rather than raw values.
export function parseCbsCpi(body: CbsResponse, fetchedAt: Date): CpiSnapshot | null {
  const dates = body.month?.[0]?.date ?? [];
  const rows = dates
    .filter((row) => Number.isInteger(row.year) && Number.isInteger(row.month))
    .map((row) => ({
      period: `${row.year}-${String(row.month).padStart(2, "0")}`,
      percent: typeof row.percent === "number" ? row.percent : null,
      percentYear: typeof row.percentYear === "number" ? row.percentYear : null,
    }))
    .sort((left, right) => left.period.localeCompare(right.period));
  const latest = rows[rows.length - 1];
  if (!latest || latest.percentYear === null) return null;
  return {
    source: "CBS",
    latestPeriod: latest.period,
    last12MonthsPercent: latest.percentYear,
    monthly: rows.flatMap((row) => (row.percent === null ? [] : [{ period: row.period, percent: row.percent }])),
    fetchedAt: fetchedAt.toISOString(),
  };
}

let cached: { snapshot: CpiSnapshot; expiresAt: number } | null = null;
let lastGood: CpiSnapshot | null = null;

function assumption(now: Date): CpiSnapshot {
  return {
    source: "ASSUMPTION",
    latestPeriod: null,
    last12MonthsPercent: FALLBACK_ANNUAL_PERCENT,
    monthly: [],
    fetchedAt: now.toISOString(),
  };
}

// `fetcher` is injectable for tests, which otherwise run with CPI_LOOKUP=off.
export async function currentCpi(fetcher?: typeof fetch, now = new Date()): Promise<CpiSnapshot> {
  if (!fetcher && !env.cpiLookup) return assumption(now);
  if (cached && cached.expiresAt > now.getTime()) return cached.snapshot;
  try {
    const url = new URL(CBS_PRICE_URL);
    url.searchParams.set("id", String(CBS_GENERAL_CPI_ID));
    url.searchParams.set("format", "json");
    url.searchParams.set("download", "false");
    url.searchParams.set("last", "13");
    const response = await (fetcher ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`CBS returned HTTP ${response.status}`);
    const snapshot = parseCbsCpi(await response.json() as CbsResponse, now);
    if (!snapshot) throw new Error("CBS returned no usable CPI data");
    lastGood = snapshot;
    cached = { snapshot, expiresAt: now.getTime() + CACHE_MS };
    return snapshot;
  } catch (error) {
    console.warn("CPI lookup failed; using the last known value or an assumption.", error instanceof Error ? error.message : error);
    const snapshot = lastGood ?? assumption(now);
    // Retry within the hour rather than a day after a failure.
    cached = { snapshot, expiresAt: now.getTime() + CACHE_MS / 24 };
    return snapshot;
  }
}

export function resetCpiCacheForTests() {
  cached = null;
  lastGood = null;
}
