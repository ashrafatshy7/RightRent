import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ProtectionPanel } from "../components/ProtectionPanel";
import type { Analysis, Finding, Protection } from "../types/api";

const gap: Protection = {
  protectionId: "RR-GAP-SHARED-METER-ALLOCATION",
  title: "חלוקת חשבון משותף",
  status: "PARTIAL",
  basis: "CONTRACT_RISK",
  explanation: "אין מנגנון לבדיקת חלקו של השוכר בחשבון",
  applicability: "חשבון החשמל משותף לכמה יחידות",
  scenario: "השוכר עלול לשלם על צריכת שכניו",
  relevantClauseIds: ["C101"],
  evidence: [{ clauseId: "C101", quote: "חשבון החשמל משותף לשלוש יחידות" }],
  legalReferences: [],
  suggestedText: "יוסכם בכתב על אופן החלוקה ועל זכות לעיין בחשבון.",
};

function show(protections: Protection[], mode: Analysis["protectionAnalysisMode"] = "CONTEXTUAL") {
  const onOpenFinding = vi.fn();
  render(<ProtectionPanel
    analysis={{ protectionReport: protections, protectionAnalysisMode: mode } as Analysis}
    findingsByClauseId={new Map([["C101", { clauseId: "C101", title: "ממצא על התשלום" } as Finding]])}
    onOpenFinding={onOpenFinding}
  />);
  return onOpenFinding;
}

describe("contextual protection presentation", () => {
  test("shows transaction relevance, consequences and evidence without a coverage percentage", () => {
    const open = show([gap]);
    expect(screen.getByText(gap.applicability!)).toBeInTheDocument();
    expect(screen.getByText(gap.scenario!)).toBeInTheDocument();
    expect(screen.getByText(gap.evidence![0]!.quote)).toBeInTheDocument();
    expect(screen.getByText("המלצה לצמצום סיכון")).toBeInTheDocument();
    expect(screen.getByText(gap.suggestedText!)).toBeInTheDocument();
    expect(screen.queryByText(/%/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ממצא על התשלום" }));
    expect(open).toHaveBeenCalledWith("C101");
  });

  test("unknown information is a clarification, never a missing protection or proposed addition", () => {
    show([{ ...gap, status: "UNKNOWN", explanation: "נדרש לקבל את נספח הציוד" }]);
    expect(screen.getByText("דרוש בירור")).toBeInTheDocument();
    expect(screen.queryByText("חסרה")).not.toBeInTheDocument();
    expect(screen.queryByText(gap.suggestedText!)).not.toBeInTheDocument();
  });

  test("an empty discovery does not claim every possible protection is present", () => {
    show([]);
    expect(screen.getByText("לא זוהו פערים נוספים בבדיקה זו.")).toBeInTheDocument();
    expect(screen.queryByText(/כל ההגנות החשובות קיימות/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/100%/u)).not.toBeInTheDocument();
  });

  test("an unavailable offline check does not look like a successful empty discovery", () => {
    show([], "UNAVAILABLE");
    expect(screen.getByRole("status")).toHaveTextContent("בדיקת הגנות חסרות אינה זמינה");
    expect(screen.queryByText("לא זוהו פערים נוספים בבדיקה זו.")).not.toBeInTheDocument();
  });

  test("historical protections without contextual metadata still render", () => {
    show([{ protectionId: "LEGACY", title: "הגנה ישנה", status: "COVERED", explanation: "ההסדר קיים", relevantClauseIds: [], legalReferences: [] }], undefined);
    expect(screen.getByText("הגנה ישנה")).toBeInTheDocument();
    expect(screen.getByText("קיימת")).toBeInTheDocument();
  });
});
