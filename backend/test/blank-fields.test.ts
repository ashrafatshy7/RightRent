import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContractClause, Finding, FinancialTerms } from "../src/domain/models.js";
import { reconcileBlankFieldFindings } from "../src/modules/analyses/blank-fields.service.js";

function clause(id: string, text: string, sectionLabel?: string): ContractClause {
  return { id, text, locations: [], ...(sectionLabel ? { sectionLabel } : {}) };
}

const clauses = [
  clause("C001", "_________ ת.ז __________ בין:\n___________ ת.ז ________"),
  clause("C002", "תקופת השכירות הנה למשך ____ חודשים בלבד, החל מיום ______ וכלה ביום _________.", "2"),
  clause("C003", "ישלמו השוכרים למשכיר דמי שכירות חודשיים, בשקלים חדשים, בסכום השווה ל-( ₪_______ במילים)", "6.1"),
  clause("C004", "12 תשלומים חודשיים של ₪ 5,000, מראש, עד ה-1 לכל חודש. השכירות ל-12 חודשים מיום 1.11.2026.", "6.2"),
  clause("C005", "ישלמו השוכרים למשכיר סך של ____ש\"ח עבור כל יום של איחור בפינוי המושכר", "12.2"),
];

function terms(overrides: Partial<FinancialTerms> = {}): FinancialTerms {
  const source = { clauseId: "C004", quote: "12 תשלומים חודשיים של ₪ 5,000", verified: true, origin: "RULE" as const };
  return {
    monthlyRent: { ...source, value: 5000 },
    leaseTermMonths: { ...source, value: 12 },
    leaseStart: { ...source, value: "2026-11-01" },
    indexation: null,
    annualIncreasePercent: null,
    option: { months: null, rent: null, increasePercent: null },
    charges: [],
    oneTimeCosts: [],
    securities: [],
    lateVacating: { ...source, clauseId: "C005", perDay: null, dailyRentMultiple: null },
    latePayment: null,
    earlyExit: null,
    unknowns: [],
    ...overrides,
  };
}

function finding(clauseId: string, title: string, overrides: Partial<Finding> = {}): Finding {
  return {
    clauseId,
    severity: "RED",
    category: "legal_compliance",
    topic: "rent_and_term",
    confidence: "medium",
    title,
    clauseQuote: "____",
    plainLanguageExplanation: "חסר ערך.",
    whyItMatters: "",
    suggestedReplacementText: "השלימו את הערך.",
    explanation: "",
    legalAssessment: { violatesLaw: true, riskWarning: false, preferenceConflict: false },
    legalReferences: [{
      lawReferenceId: "rll-schedule-2",
      lawName: "חוק השכירות והשאילה, התשל\"א-1971",
      section: "תוספת שנייה",
      sourceUrl: "https://example.test/law",
      revisionId: null,
      excerpt: null,
      sourceAsOf: null,
    }],
    relatedFindingIds: [],
    locations: [],
    ...overrides,
  };
}

test("a blank whose value the contract states elsewhere is an informational note, not a critical gap", () => {
  const [term, rent] = reconcileBlankFieldFindings(
    [
      finding("C002", "תקופת השכירות לא מוגדרת בחוזה"),
      finding("C003", "סכום דמי השכירות לא מולא בחוזה", { severity: "ORANGE" }),
    ],
    clauses,
    terms(),
  );

  assert.equal(term!.severity, "OK");
  assert.equal(term!.category, "informational");
  assert.deepEqual(term!.legalAssessment, { violatesLaw: false, riskWarning: false, preferenceConflict: false });
  assert.deepEqual(term!.legalReferences, []);
  assert.ok(!("suggestedReplacementText" in term!));
  assert.match(term!.plainLanguageExplanation, /12 חודשים \(סעיף 6\.2\)/u);
  assert.match(term!.plainLanguageExplanation, /1\.11\.2026/u);

  assert.equal(rent!.severity, "OK");
  assert.match(rent!.plainLanguageExplanation, /5,000 ₪ לחודש \(סעיף 6\.2\)/u);
});

test("a blank-field finding stays when the contract does not state the value verifiably", () => {
  const unverified = terms({
    leaseTermMonths: { clauseId: "C004", quote: "12", verified: false, origin: "MODEL", value: 12 },
  });
  const [term, late] = reconcileBlankFieldFindings(
    [
      finding("C002", "תקופת השכירות לא מוגדרת בחוזה"),
      // The daily amount is blank everywhere.
      finding("C005", "סכום הפיצוי היומי לא מולא", { severity: "ORANGE" }),
    ],
    clauses,
    unverified,
  );

  assert.equal(term!.severity, "RED");
  assert.equal(late!.severity, "ORANGE");
});

test("only findings that claim a stated value is missing are reconciled", () => {
  const withLateFee = terms({
    lateVacating: { clauseId: "C004", quote: "200", verified: true, origin: "RULE", perDay: 200, dailyRentMultiple: 1.2 },
  });
  const [ids, penalty, checked] = reconcileBlankFieldFindings(
    [
      // ID numbers are not a value the contract states anywhere else.
      finding("C001", "חלקים חסרים בחוזה", { severity: "ORANGE" }),
      // A finding about the clause itself, not about its blank.
      finding("C005", "קנס יומי ללא צורך להוכיח נזק", { severity: "ORANGE" }),
      // A failed legal-limit check is never softened.
      finding("C002", "תקופת השכירות לא מוגדרת בחוזה", {
        deterministicChecks: [{
          ruleId: "IL-RLL-25Y-SECURITY-CAP",
          label: "ערובה",
          legalReferenceId: "IL-RLL-25Y-SECURITY-CAP",
          contractValue: 30000,
          legalLimit: 15000,
          calculatedLimit: 15000,
          difference: 15000,
          unit: "ILS",
          passesRule: false,
        }],
      }),
    ],
    clauses,
    withLateFee,
  );

  assert.equal(ids!.severity, "ORANGE");
  assert.equal(penalty!.severity, "ORANGE");
  assert.equal(checked!.severity, "RED");
});
