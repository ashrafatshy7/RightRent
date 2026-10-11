import type { HistoryAnalysis } from "../types/api";

// The most recent analysis of each contract (history arrives newest first).
export function latestAnalysisByContract(history: HistoryAnalysis[]) {
  const latest = new Map<string, HistoryAnalysis>();
  for (const entry of history) {
    if (!latest.has(entry.contractId)) latest.set(entry.contractId, entry);
  }
  return latest;
}

// The latest analysis of the version this analysis's contract replaced, to compare against.
export function previousVersionAnalysis(history: HistoryAnalysis[], analysisId: string) {
  const entry = history.find((item) => item.analysisId === analysisId);
  const previousContractId = entry?.contract?.previousContractId;
  return previousContractId ? latestAnalysisByContract(history).get(previousContractId) ?? null : null;
}

export type ContractGroup = {
  rootContractId: string;
  fileName: string;
  versionCount: number;
  entries: HistoryAnalysis[];
};

// History grouped by contract: all versions of one contract together, newest version first, and the
// contracts ordered by their most recent analysis.
export function groupByContract(history: HistoryAnalysis[]): ContractGroup[] {
  const groups = new Map<string, HistoryAnalysis[]>();
  for (const entry of history) {
    const root = entry.contract?.rootContractId ?? entry.contractId;
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  }
  return [...groups].map(([rootContractId, entries]) => {
    const sorted = [...entries].sort((left, right) =>
      (right.contract?.version ?? 1) - (left.contract?.version ?? 1) || right.createdAt.localeCompare(left.createdAt));
    return {
      rootContractId,
      fileName: sorted[0]?.contract?.originalFileName ?? "חוזה שכירות",
      versionCount: new Set(entries.map((entry) => entry.contractId)).size,
      entries: sorted,
    };
  });
}
