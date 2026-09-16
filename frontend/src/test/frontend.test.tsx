import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BrandMark } from "../components/BrandMark";
import { API_PATHS } from "../config/app";
import { api } from "../lib/api-client";
import { LAW_STATUS_META, LAW_STATUS_ORDER } from "../lib/law-status";
import type { LawApproval, LawSourceStatus } from "../types/api";

afterEach(() => vi.restoreAllMocks());

describe("shared frontend contracts", () => {
  test("every law source status has one centralized presentation", () => {
    const expected: LawSourceStatus[] = [
      "ACTIVE",
      "AWAITING_VERIFICATION",
      "OFFICIAL_UPDATE_PENDING",
      "WIKISOURCE_CHANGED",
      "FAILED",
    ];
    expect(Object.keys(LAW_STATUS_META).toSorted()).toEqual(expected.toSorted());
    expect(new Set(LAW_STATUS_ORDER)).toEqual(new Set(expected));
  });

  test("the brand exposes the product promise accessibly", () => {
    render(<MemoryRouter><BrandMark /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "RightRent — דף הבית" })).toBeInTheDocument();
    expect(screen.getByText("זכות לפני חתימה")).toBeInTheDocument();
  });

  test("law approval uses the authenticated admin API and exact candidate payload", async () => {
    const approval: LawApproval = {
      revisionId: 123,
      contentHash: "a".repeat(64),
      sectionCount: 10,
      sectionsHash: "b".repeat(64),
      confirmedComplete: true,
      verifiedBy: "Reviewer",
      verificationReference: "Official source",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ law: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await api.approveLaw("admin-token", 2000596, approval);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(API_PATHS.approveLaw(2000596));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(JSON.parse(String(init?.body))).toEqual(approval);
  });

  test("readiness treats an expected 503 not-ready response as state, not an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "not_ready",
      database: true,
      analysisProvider: "anthropic",
      activeLaws: "0/13",
      activeEmbeddingCount: 0,
      vectorSearch: false,
      timestamp: "2026-08-26T13:09:31.389Z",
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));

    await expect(api.getReadiness()).resolves.toMatchObject({
      status: "not_ready",
      activeLaws: "0/13",
    });
  });
});
