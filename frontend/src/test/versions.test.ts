import { describe, expect, test } from "vitest";
import { groupByContract, previousVersionAnalysis } from "../lib/versions";
import type { HistoryAnalysis } from "../types/api";

function entry(analysisId: string, contractId: string, version: number, createdAt: string, previous: string | null): HistoryAnalysis {
  return {
    analysisId,
    contractId,
    createdAt,
    contract: { id: contractId, originalFileName: `${contractId}.pdf`, version, rootContractId: "c1", previousContractId: previous },
  } as HistoryAnalysis;
}

// Newest first, as the history API returns it. Version 1 was analyzed twice.
const history = [
  entry("a3", "c2", 2, "2026-10-11T12:00:00Z", "c1"),
  entry("a2", "c1", 1, "2026-10-11T11:00:00Z", null),
  entry("a1", "c1", 1, "2026-10-11T10:00:00Z", null),
  { ...entry("b1", "x1", 1, "2026-10-10T10:00:00Z", null), contract: { id: "x1", originalFileName: "other.pdf", version: 1, rootContractId: "x1", previousContractId: null } },
];

describe("contract versions in the history", () => {
  test("a revised version is compared with the latest analysis of the version it replaced", () => {
    expect(previousVersionAnalysis(history, "a3")?.analysisId).toBe("a2");
    expect(previousVersionAnalysis(history, "a2")).toBeNull();
  });

  test("versions of one contract are grouped, newest version first", () => {
    const groups = groupByContract(history);
    expect(groups.map((group) => [group.rootContractId, group.versionCount, group.entries.map((item) => item.analysisId)])).toEqual([
      ["c1", 2, ["a3", "a2", "a1"]],
      ["x1", 1, ["b1"]],
    ]);
    expect(groups[0]!.fileName).toBe("c2.pdf");
  });
});
