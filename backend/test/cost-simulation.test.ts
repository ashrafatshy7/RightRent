import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { defaultPreferences, type ContractClause, type FinancialTerms } from "../src/domain/models.js";
import { isSubstantiveClause } from "../src/modules/analyses/classification.js";
import { linkClauses } from "../src/modules/analyses/clause-linking.service.js";
import { costInputs, simulateCost, type CostScenario } from "../src/modules/analyses/cost-simulation.service.js";
import {
  extractFinancialTermsDeterministically,
  fromModelTerms,
  mergeFinancialTerms,
} from "../src/modules/analyses/financial-terms.service.js";
import { currentCpi, FALLBACK_ANNUAL_PERCENT, parseCbsCpi, resetCpiCacheForTests } from "../src/modules/market/cpi.service.js";
import { extractClausesFromPlainText } from "../src/modules/contracts/pdf-extraction.service.js";

function termsFor(clauses: ContractClause[]) {
  const analyzable = clauses.filter(isSubstantiveClause);
  const graph = linkClauses(analyzable);
  return extractFinancialTermsDeterministically(analyzable, graph.profiles, graph.contractFacts);
}

function termsForText(lines: string[]) {
  return termsFor(extractClausesFromPlainText(lines.join("\n")));
}

const stay: CostScenario = {
  annualInflationPercent: 0,
  includeOption: false,
  exitAfterMonth: null,
  replacementAfterMonths: 2,
  lateVacatingDays: 0,
  latePaymentDays: 0,
};

const financialContract = extractClausesFromPlainText(
  await readFile(path.resolve("evaluation/contracts/synthetic/RR-EVAL-007-financial-terms.txt"), "utf8"),
);

test("the money terms of a contract are read with the clause each came from", () => {
  const terms = termsFor(financialContract);
  assert.equal(terms.monthlyRent?.value, 5_500);
  assert.equal(terms.monthlyRent?.clauseId, "C002");
  assert.equal(terms.leaseTermMonths?.value, 12);
  assert.equal(terms.leaseStart?.value, "2027-01-01");
  assert.deepEqual(
    terms.indexation && { index: terms.indexation.index, frequency: terms.indexation.frequency, floor: terms.indexation.floorAtBase },
    { index: "CPI", frequency: "ANNUAL", floor: true },
  );
  assert.equal(terms.option.months?.value, 12);
  assert.equal(terms.option.increasePercent?.value, 4);
  assert.equal(terms.annualIncreasePercent, null);
  assert.deepEqual(terms.charges.find((charge) => charge.kind === "VAAD_BAYIT")?.monthlyAmount, 280);
  assert.equal(terms.charges.find((charge) => charge.kind === "ARNONA")?.monthlyAmount, null);
  assert.deepEqual(terms.oneTimeCosts.map(({ kind, amount }) => [kind, amount]), [["BROKER_FEE", 5_500]]);
  assert.deepEqual(terms.securities.map(({ kind, amount, returnDays }) => [kind, amount, returnDays]), [["CASH_DEPOSIT", 11_000, 30]]);
  assert.equal(terms.lateVacating?.perDay, 400);
  assert.equal(terms.latePayment?.monthlyInterestPercent, 1.5);
  assert.deepEqual(terms.earlyExit && [terms.earlyExit.kind, terms.earlyExit.noticeDays], ["UNTIL_REPLACEMENT", 60]);
  assert.ok(terms.unknowns.some((note) => note.includes("ארנונה")));
});

test("the tenant's early-exit position is read from the clause that states it", () => {
  const untilEnd = termsForText([
    "[C001]",
    "המשכיר רשאי להביא את החוזה לסיום מכל סיבה בהודעה של 30 ימים מראש. לשוכרת לא תהיה זכות מקבילה לבטל את החוזה לפני תום התקופה, והיא תישא בדמי השכירות עד סופה גם אם תפנה את הדירה קודם לכן.",
  ]);
  assert.equal(untilEnd.earlyExit?.kind, "UNTIL_END");

  // Plain notice, with a replacement tenant only as an alternative.
  const notice = termsForText([
    "[C001]",
    "השוכר רשאי לסיים את השכירות מוקדם בהודעה מראש של 60 ימים, או להציע שוכר חלופי סביר. המשכירה לא תסרב לשוכר חלופי מטעמים בלתי סבירים.",
  ]);
  assert.deepEqual(notice.earlyExit && [notice.earlyExit.kind, notice.earlyExit.noticeDays], ["ALLOWED_WITH_NOTICE", 60]);

  // One clause denies any right and another grants one: the grant is used and flagged.
  const conflicting = termsForText([
    "[C001]",
    "תקופת השכירות היא עשרה חודשים. אין לשוכר זכות לסיום מוקדם ואין מנגנון להצעת שוכר חלופי.",
    "[C002]",
    "כל אחד מהצדדים רשאי לבטל את ההסכם ללא הפרה: בעלת הדירה בהודעה של 90 ימים מראש והשוכר בהודעה של 60 ימים מראש.",
  ]);
  assert.deepEqual(
    conflicting.earlyExit && [conflicting.earlyExit.kind, conflicting.earlyExit.noticeDays, conflicting.earlyExit.conflict],
    ["ALLOWED_WITH_NOTICE", 60, true],
  );
  assert.ok(conflicting.unknowns.some((note) => note.includes("סותרים")));
});

test("a model reading counts only when its quote is the clause's own text and contains the number", () => {
  const clauses = financialContract.filter(isSubstantiveClause);
  const model = fromModelTerms({
    // Verbatim and containing the number.
    monthlyRent: { value: 5_500, clauseId: "C002", quote: "דמי השכירות החודשיים הם 5,500 ש״ח" },
    // Verbatim, but the number in it is not the reported one.
    leaseTermMonths: { value: 24, clauseId: "C001", quote: "תקופת השכירות היא 12 חודשים" },
    // A paraphrase, not contract text.
    option: { increasePercent: { value: 5, clauseId: "C004", quote: "העלאה של חמישה אחוזים באופציה" } },
    charges: [],
    oneTimeCosts: [],
    securities: [],
  }, clauses);
  assert.equal(model.monthlyRent?.verified, true);
  assert.equal(model.leaseTermMonths?.verified, false);
  assert.equal(model.option.increasePercent?.verified, false);

  const merged = mergeFinancialTerms(termsFor(financialContract), model);
  // Unverified model values never displace the rules' reading.
  assert.equal(merged.leaseTermMonths?.value, 12);
  assert.equal(merged.option.increasePercent?.value, 4);
  assert.equal(merged.monthlyRent?.origin, "MODEL");

  // A model number that is not in its quote stays out; the rules' reading is kept.
  const unsupported = mergeFinancialTerms(termsFor(financialContract), fromModelTerms({
    monthlyRent: { value: 5, clauseId: "C002", quote: "וישולמו עד ליום החמישי בכל חודש" },
    option: {},
    charges: [],
    oneTimeCosts: [],
    securities: [],
  }, clauses));
  assert.deepEqual([unsupported.monthlyRent?.value, unsupported.monthlyRent?.origin], [5_500, "RULE"]);

  // A verified model value that disagrees with the rules wins but is flagged for confirmation.
  const disagreeing = mergeFinancialTerms(termsFor(financialContract), fromModelTerms({
    monthlyRent: { value: 400, clauseId: "C009", quote: "פיצוי מוסכם בסך 400 ש״ח" },
    option: {},
    charges: [],
    oneTimeCosts: [],
    securities: [],
  }, clauses));
  assert.deepEqual([disagreeing.monthlyRent?.value, disagreeing.monthlyRent?.conflict], [400, true]);
});

test("the cost of a plain lease is rent and known charges, month by month", () => {
  const simulation = simulateCost(costInputs(termsForText([
    "[C001]",
    "תקופת השכירות היא 12 חודשים. דמי השכירות החודשיים הם 6,000 ש״ח.",
    "[C002]",
    "השוכר ישלם לוועד הבית סך של 250 ש״ח לחודש.",
  ])), stay, defaultPreferences);
  assert.equal(simulation.ready, true);
  assert.equal(simulation.months.length, 12);
  assert.equal(simulation.totals.rent, 72_000);
  assert.equal(simulation.totals.charges, 3_000);
  assert.equal(simulation.totals.total, 75_000);
  assert.equal(simulation.months.at(-1)?.cumulative, 75_000);
  assert.equal(simulation.budget.firstMonthOverBudget, null);
});

test("annual CPI linkage raises the rent once a year and never below the base with a floor", () => {
  const inputs = costInputs(termsFor(financialContract));
  const inflated = simulateCost(inputs, { ...stay, annualInflationPercent: 3, includeOption: true }, defaultPreferences);
  // Year one at the base rent; the option year at base × 1.04 (option) × 1.03 (one year of CPI).
  assert.equal(inflated.months[0]!.indexation, 0);
  assert.equal(inflated.months[11]!.indexation, 0);
  assert.equal(inflated.months[12]!.baseRent, 5_720);
  assert.equal(inflated.months[12]!.indexation, 171.6);
  assert.equal(inflated.increase.effectiveAnnualPercent, 7.12);
  assert.equal(inflated.increase.exceedsPreference, true);

  const deflation = simulateCost(inputs, { ...stay, annualInflationPercent: -2, includeOption: true }, defaultPreferences);
  assert.equal(deflation.months[12]!.indexation, 0, "the floor keeps the rent at its base when prices fall");
});

test("leaving early costs what the contract says about early exit", () => {
  const lease = ["[C001]", "תקופת השכירות היא 12 חודשים. דמי השכירות החודשיים הם 5,000 ש״ח."];
  const exitAfterFour = { ...stay, exitAfterMonth: 4 };
  const owed = (extra: string[]) => {
    const simulation = simulateCost(costInputs(termsForText([...lease, ...extra])), exitAfterFour, defaultPreferences);
    return simulation.lines.find((line) => line.id === "early-exit")?.amount;
  };
  assert.equal(owed(["[C002]", "לשוכר לא תהיה זכות לבטל את החוזה, והוא יישא בדמי השכירות עד סוף התקופה."]), 40_000);
  assert.equal(owed(["[C002]", "השוכר רשאי לסיים את השכירות בהודעה מוקדמת של 60 ימים."]), 10_000);
  assert.equal(owed(["[C002]", "השוכר רשאי לסיים את השכירות בהודעה מוקדמת של 30 ימים, ובלבד שיציע שוכר חלופי."]), 10_000);
  // Nothing in the contract: the worst case is assumed and said so.
  const silent = simulateCost(costInputs(termsForText(lease)), exitAfterFour, defaultPreferences);
  assert.equal(silent.lines.find((line) => line.id === "early-exit")?.amount, 40_000);
  assert.ok(silent.notes.some((note) => note.includes("המקרה הגרוע")));
});

test("late vacating and late payment use the contract's own penalties", () => {
  const simulation = simulateCost(costInputs(termsFor(financialContract)), { ...stay, lateVacatingDays: 5, latePaymentDays: 10 }, defaultPreferences);
  assert.equal(simulation.lines.find((line) => line.id === "late-vacating")?.amount, 2_000);
  assert.equal(simulation.lines.find((line) => line.id === "late-payment")?.amount, 27.5);
  // A contract without a late-vacating penalty is charged at least the daily rent, as a note says.
  const plain = simulateCost(costInputs(termsForText(["[C001]", "תקופת השכירות היא 12 חודשים. דמי השכירות החודשיים הם 6,000 ש״ח."])),
    { ...stay, lateVacatingDays: 3 }, defaultPreferences);
  assert.equal(plain.lines.find((line) => line.id === "late-vacating")?.amount, 600);
  assert.ok(plain.notes.some((note) => note.includes("דמי שכירות יומיים")));
});

test("the tenant's corrections confirm or replace values, and unverified values wait for them", () => {
  const terms: FinancialTerms = termsFor(financialContract);
  const unverified = { ...terms, monthlyRent: { ...terms.monthlyRent!, verified: false } };
  assert.equal(simulateCost(costInputs(unverified), stay, defaultPreferences).ready, false);
  const confirmed = simulateCost(costInputs(unverified, { monthlyRent: 5_500, chargeAmounts: { ARNONA: 400 } }), stay, defaultPreferences);
  assert.equal(confirmed.ready, true);
  assert.equal(confirmed.totals.charges, (280 + 400) * 12);
});

test("the CBS response is read from monthly changes, and an unreachable CBS falls back openly", async () => {
  const body = {
    month: [{
      date: [
        { year: 2026, month: 8, percent: 0.7, percentYear: 1.5 },
        { year: 2026, month: 7, percent: 0.3, percentYear: 1.5 },
        { year: 2026, month: 6, percent: 0.0, percentYear: 1.6 },
      ],
    }],
  };
  const snapshot = parseCbsCpi(body, new Date("2026-10-11T00:00:00Z"));
  assert.equal(snapshot?.latestPeriod, "2026-08");
  assert.equal(snapshot?.last12MonthsPercent, 1.5);
  assert.deepEqual(snapshot?.monthly.map((row) => row.period), ["2026-06", "2026-07", "2026-08"]);

  resetCpiCacheForTests();
  const failing = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
  const fallback = await currentCpi(failing, new Date("2026-10-11T00:00:00Z"));
  assert.equal(fallback.source, "ASSUMPTION");
  assert.equal(fallback.last12MonthsPercent, FALLBACK_ANNUAL_PERCENT);
  resetCpiCacheForTests();
});
