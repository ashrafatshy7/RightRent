import type {
  ChargeKind,
  EarlyExitKind,
  FinancialOverrides,
  FinancialTerms,
  IndexationFrequency,
  OneTimeCostKind,
  SecurityKind,
  SourcedNumber,
  TenantPreferences,
} from "../../domain/models.js";

// Turns a contract's money terms into shekels, month by month. Pure arithmetic in code: the model
// may help read the terms, but never computes an amount (the same principle as the deterministic
// legal checks). Every line of the result carries the formula behind it and the clauses its inputs
// came from.

export type CostScenario = {
  annualInflationPercent: number;
  includeOption: boolean;
  // The tenant leaves after this many months of the lease term (null: stays to the end).
  exitAfterMonth: number | null;
  // For a replacement-tenant exit: how long it takes to find one.
  replacementAfterMonths: number;
  lateVacatingDays: number;
  latePaymentDays: number;
};

export type CostInputs = {
  monthlyRent: number | null;
  leaseTermMonths: number | null;
  leaseStart: string | null;
  indexation: { linked: boolean; frequency: Exclude<IndexationFrequency, "UNKNOWN">; floorAtBase: boolean; assumedFrequency: boolean };
  annualIncreasePercent: number | null;
  option: { months: number | null; rent: number | null; increasePercent: number | null };
  charges: Array<{ kind: ChargeKind; payer: "TENANT" | "LANDLORD"; monthlyAmount: number | null; clauseId: string }>;
  oneTimeCosts: Array<{ kind: OneTimeCostKind; amount: number | null; timing: "START" | "END"; clauseId: string }>;
  securities: Array<{ kind: SecurityKind; amount: number | null; returnDays: number | null; clauseId: string }>;
  lateVacating: { perDay: number | null; dailyRentMultiple: number | null; clauseId: string | null };
  latePayment: { perDay: number | null; monthlyInterestPercent: number | null; clauseId: string | null };
  earlyExit: { kind: EarlyExitKind | null; months: number | null; amount: number | null; noticeDays: number | null; clauseId: string | null };
  sources: Partial<Record<"monthlyRent" | "leaseTermMonths" | "indexation" | "annualIncreasePercent" | "option", string>>;
};

export type CostLine = { id: string; label: string; amount: number; formula: string; sourceClauseIds: string[] };

export type CostMonth = {
  month: number;
  period: string | null;
  phase: "TERM" | "OPTION" | "EXIT" | "LATE";
  baseRent: number;
  increase: number;
  indexation: number;
  charges: number;
  oneTime: number;
  penalties: number;
  total: number;
  cumulative: number;
};

export type CostSimulation = {
  ready: boolean;
  missing: Array<"monthlyRent" | "leaseTermMonths">;
  months: CostMonth[];
  totals: {
    rent: number;
    increases: number;
    indexation: number;
    charges: number;
    oneTime: number;
    penalties: number;
    total: number;
    averageMonthly: number;
  };
  baselineTotal: number;
  security: { total: number; cashLocked: number; returnDays: number | null };
  // The rent budget, and the total budget for rent plus the tenant's recurring charges with a known
  // amount (null when the tenant set none).
  budget: {
    maxMonthlyRentIls: number;
    peakMonthlyRent: number;
    firstMonthOverBudget: number | null;
    maxMonthlyTotalCostIls: number | null;
    peakMonthlyTotal: number;
    firstMonthOverTotalBudget: number | null;
  };
  increase: { effectiveAnnualPercent: number; preferenceMax: number; exceedsPreference: boolean };
  lines: CostLine[];
  notes: string[];
  scenario: CostScenario;
};

export const CHARGE_LABELS: Record<ChargeKind, string> = {
  ARNONA: "ארנונה",
  WATER: "מים",
  ELECTRICITY: "חשמל",
  GAS: "גז",
  VAAD_BAYIT: "ועד בית",
  BUILDING_INSURANCE: "ביטוח מבנה",
  SPECIAL_BUILDING_EXPENSES: "הוצאות מיוחדות של הבניין",
  CONTENTS_INSURANCE: "ביטוח תכולה",
  OTHER: "תשלום שוטף אחר",
};

export const ONE_TIME_LABELS: Record<OneTimeCostKind, string> = {
  BROKER_FEE: "דמי תיווך",
  LEGAL_FEE: "שכר טרחת עורך דין",
  CLEANING: "ניקיון בסיום",
  OTHER: "תשלום חד־פעמי",
};

function trusted(value: SourcedNumber | null): number | null {
  return value && value.verified ? value.value : null;
}

// Only verified values (or values the tenant set) are counted; an unverified reading waits for the
// tenant to confirm it.
export function costInputs(terms: FinancialTerms, overrides: FinancialOverrides = {}): CostInputs {
  const indexationLinked = overrides.indexationLinked ?? Boolean(terms.indexation?.verified && terms.indexation.index !== "OTHER");
  const statedFrequency = terms.indexation?.frequency ?? "UNKNOWN";
  const frequency = overrides.indexationFrequency ?? (statedFrequency === "UNKNOWN" ? "MONTHLY" : statedFrequency);
  const exit = terms.earlyExit?.verified ? terms.earlyExit : null;
  return {
    monthlyRent: overrides.monthlyRent ?? trusted(terms.monthlyRent),
    leaseTermMonths: overrides.leaseTermMonths ?? trusted(terms.leaseTermMonths),
    leaseStart: overrides.leaseStart ?? (terms.leaseStart?.verified ? terms.leaseStart.value : null),
    indexation: {
      linked: indexationLinked,
      frequency,
      floorAtBase: terms.indexation?.floorAtBase ?? false,
      assumedFrequency: indexationLinked && !overrides.indexationFrequency && statedFrequency === "UNKNOWN",
    },
    annualIncreasePercent: overrides.annualIncreasePercent ?? trusted(terms.annualIncreasePercent),
    option: {
      months: overrides.optionMonths ?? trusted(terms.option.months),
      rent: overrides.optionRent ?? trusted(terms.option.rent),
      increasePercent: overrides.optionIncreasePercent ?? trusted(terms.option.increasePercent),
    },
    charges: terms.charges.map((charge) => ({
      kind: charge.kind,
      payer: charge.payer,
      monthlyAmount: overrides.chargeAmounts?.[charge.kind] ?? (charge.verified ? charge.monthlyAmount : null),
      clauseId: charge.clauseId,
    })),
    oneTimeCosts: terms.oneTimeCosts.map((cost) => ({
      kind: cost.kind,
      amount: overrides.oneTimeAmounts?.[cost.kind] ?? (cost.verified ? cost.amount : null),
      timing: cost.timing,
      clauseId: cost.clauseId,
    })),
    securities: terms.securities.map((security, index) => ({
      kind: security.kind,
      amount: index === 0 && overrides.securityAmount !== undefined ? overrides.securityAmount : security.verified ? security.amount : null,
      returnDays: security.returnDays,
      clauseId: security.clauseId,
    })),
    lateVacating: {
      perDay: overrides.lateVacatingPerDay ?? (terms.lateVacating?.verified ? terms.lateVacating.perDay : null),
      dailyRentMultiple: terms.lateVacating?.verified ? terms.lateVacating.dailyRentMultiple : null,
      clauseId: terms.lateVacating?.clauseId ?? null,
    },
    latePayment: {
      perDay: overrides.latePaymentPerDay ?? (terms.latePayment?.verified ? terms.latePayment.perDay : null),
      monthlyInterestPercent: terms.latePayment?.verified ? terms.latePayment.monthlyInterestPercent : null,
      clauseId: terms.latePayment?.clauseId ?? null,
    },
    earlyExit: {
      kind: overrides.earlyExitKind ?? exit?.kind ?? null,
      months: overrides.earlyExitMonths ?? exit?.months ?? null,
      amount: exit?.amount ?? null,
      noticeDays: overrides.earlyExitNoticeDays ?? exit?.noticeDays ?? null,
      clauseId: exit?.clauseId ?? null,
    },
    sources: {
      ...(terms.monthlyRent ? { monthlyRent: terms.monthlyRent.clauseId } : {}),
      ...(terms.leaseTermMonths ? { leaseTermMonths: terms.leaseTermMonths.clauseId } : {}),
      ...(terms.indexation ? { indexation: terms.indexation.clauseId } : {}),
      ...(terms.annualIncreasePercent ? { annualIncreasePercent: terms.annualIncreasePercent.clauseId } : {}),
      ...(terms.option.months || terms.option.rent || terms.option.increasePercent
        ? { option: (terms.option.rent ?? terms.option.increasePercent ?? terms.option.months)!.clauseId }
        : {}),
    },
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function shekels(value: number) {
  return `${Math.round(value).toLocaleString("he-IL")} ש״ח`;
}

function addMonths(isoDate: string | null, months: number) {
  if (!isoDate) return null;
  const [year, month] = isoDate.split("-").map(Number);
  if (!year || !month) return null;
  const index = year * 12 + (month - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function sources(...ids: Array<string | null | undefined>) {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

export const EXIT_LABELS: Record<EarlyExitKind, string> = {
  UNTIL_END: "תשלום עד סוף התקופה",
  UNTIL_REPLACEMENT: "תשלום עד שיימצא שוכר חלופי",
  FIXED_MONTHS: "פיצוי של מספר חודשי שכירות",
  FIXED_AMOUNT: "פיצוי בסכום קבוע",
  ALLOWED_WITH_NOTICE: "יציאה בהודעה מוקדמת",
  NOT_ALLOWED: "החוזה אינו מאפשר יציאה מוקדמת",
};

export function simulateCost(inputs: CostInputs, scenario: CostScenario, preferences: TenantPreferences): CostSimulation {
  const missing: CostSimulation["missing"] = [];
  if (!inputs.monthlyRent) missing.push("monthlyRent");
  if (!inputs.leaseTermMonths) missing.push("leaseTermMonths");
  const baseline = (withEvents: boolean) => schedule(inputs, scenario, withEvents);
  const empty = {
    ready: false,
    missing,
    months: [],
    totals: { rent: 0, increases: 0, indexation: 0, charges: 0, oneTime: 0, penalties: 0, total: 0, averageMonthly: 0 },
    baselineTotal: 0,
    security: securitySummary(inputs),
    budget: {
      maxMonthlyRentIls: preferences.maxMonthlyRentIls,
      peakMonthlyRent: 0,
      firstMonthOverBudget: null,
      maxMonthlyTotalCostIls: preferences.maxMonthlyTotalCostIls,
      peakMonthlyTotal: 0,
      firstMonthOverTotalBudget: null,
    },
    increase: { effectiveAnnualPercent: 0, preferenceMax: preferences.maxAnnualRentIncreasePercent, exceedsPreference: false },
    lines: [],
    notes: [],
    scenario,
  };
  if (missing.length) return empty;

  const result = baseline(true);
  const plain = baseline(false);
  const occupied = result.months.filter((month) => month.phase === "TERM" || month.phase === "OPTION");
  const monthlyRents = occupied.map((month) => month.baseRent + month.increase + month.indexation);
  const peakMonthlyRent = Math.max(0, ...monthlyRents);
  const overBudget = occupied.find((month) => month.baseRent + month.increase + month.indexation > preferences.maxMonthlyRentIls + 0.005);
  const monthlyTotal = (month: CostMonth) => month.baseRent + month.increase + month.indexation + month.charges;
  const peakMonthlyTotal = Math.max(0, ...occupied.map(monthlyTotal));
  const maxTotal = preferences.maxMonthlyTotalCostIls;
  const overTotalBudget = maxTotal === null ? undefined : occupied.find((month) => monthlyTotal(month) > maxTotal + 0.005);
  const span = Math.min(13, monthlyRents.length);
  const effectiveAnnualPercent = span > 1
    ? round(((monthlyRents[span - 1]! / monthlyRents[0]!) ** (12 / (span - 1)) - 1) * 100)
    : 0;

  return {
    ready: true,
    missing: [],
    months: result.months,
    totals: result.totals,
    baselineTotal: plain.totals.total,
    security: securitySummary(inputs),
    budget: {
      maxMonthlyRentIls: preferences.maxMonthlyRentIls,
      peakMonthlyRent: round(peakMonthlyRent),
      firstMonthOverBudget: overBudget?.month ?? null,
      maxMonthlyTotalCostIls: maxTotal,
      peakMonthlyTotal: round(peakMonthlyTotal),
      firstMonthOverTotalBudget: overTotalBudget?.month ?? null,
    },
    increase: {
      effectiveAnnualPercent,
      preferenceMax: preferences.maxAnnualRentIncreasePercent,
      exceedsPreference: effectiveAnnualPercent > preferences.maxAnnualRentIncreasePercent + 0.005,
    },
    lines: result.lines,
    notes: result.notes,
    scenario,
  };
}

function securitySummary(inputs: CostInputs) {
  const known = inputs.securities.filter((security) => security.amount !== null);
  return {
    total: round(known.reduce((sum, security) => sum + security.amount!, 0)),
    cashLocked: round(known.filter((security) => security.kind === "CASH_DEPOSIT").reduce((sum, security) => sum + security.amount!, 0)),
    returnDays: inputs.securities.find((security) => security.returnDays !== null)?.returnDays ?? null,
  };
}

function schedule(inputs: CostInputs, scenario: CostScenario, withEvents: boolean) {
  const rent = inputs.monthlyRent!;
  const term = inputs.leaseTermMonths!;
  const notes: string[] = [];
  const lines: CostLine[] = [];
  const inflation = scenario.annualInflationPercent / 100;
  const exitAfter = withEvents && scenario.exitAfterMonth !== null
    ? Math.min(Math.max(1, Math.round(scenario.exitAfterMonth)), term - 1)
    : null;
  const optionMonths = exitAfter === null && scenario.includeOption ? inputs.option.months ?? 0 : 0;
  if (scenario.includeOption && !inputs.option.months && exitAfter === null) {
    notes.push("לא מצאנו בחוזה תקופת אופציה, ולכן החישוב כולל את תקופת השכירות בלבד.");
  }

  const indexFactor = (month: number) => {
    if (!inputs.indexation.linked) return 1;
    let factor: number;
    if (inputs.indexation.frequency === "ANNUAL") factor = (1 + inflation) ** Math.floor((month - 1) / 12);
    else if (inputs.indexation.frequency === "AT_RENEWAL") factor = month > term ? (1 + inflation) ** (term / 12) : 1;
    else factor = (1 + inflation) ** ((month - 1) / 12);
    return inputs.indexation.floorAtBase ? Math.max(1, factor) : factor;
  };
  const increaseFactor = (month: number) =>
    month <= term && inputs.annualIncreasePercent ? (1 + inputs.annualIncreasePercent / 100) ** Math.floor((month - 1) / 12) : 1;
  const lastTermFactor = increaseFactor(term);
  // Option months start from a fixed option rent when the contract states one, or from the last
  // rent of the term raised by the option increase. A fixed option rent is a nominal amount, so it is
  // not indexed again.
  const optionBase = inputs.option.rent ?? rent * lastTermFactor * (1 + (inputs.option.increasePercent ?? 0) / 100);
  const rentFor = (month: number) => {
    if (month > term) {
      const index = inputs.option.rent ? 1 : indexFactor(month);
      return { base: optionBase, increase: 0, indexation: optionBase * (index - 1) };
    }
    const increased = rent * increaseFactor(month);
    return { base: rent, increase: increased - rent, indexation: increased * (indexFactor(month) - 1) };
  };

  const tenantCharges = inputs.charges.filter((charge) => charge.payer === "TENANT");
  const knownCharges = tenantCharges.filter((charge) => charge.monthlyAmount !== null);
  const monthlyCharges = knownCharges.reduce((sum, charge) => sum + charge.monthlyAmount!, 0);
  const unpriced = tenantCharges.filter((charge) => charge.monthlyAmount === null).map((charge) => CHARGE_LABELS[charge.kind]);
  if (unpriced.length) notes.push(`לא כלולים בחישוב כי החוזה לא מציין להם סכום: ${unpriced.join(", ")}. אפשר להזין הערכה.`);

  const occupiedMonths = exitAfter ?? term + optionMonths;
  const months: CostMonth[] = [];
  for (let month = 1; month <= occupiedMonths; month += 1) {
    const { base, increase, indexation } = rentFor(month);
    months.push({
      month,
      period: addMonths(inputs.leaseStart, month - 1),
      phase: month > term ? "OPTION" : "TERM",
      baseRent: base,
      increase,
      indexation,
      charges: monthlyCharges,
      oneTime: 0,
      penalties: 0,
      total: 0,
      cumulative: 0,
    });
  }

  for (const cost of inputs.oneTimeCosts) {
    if (cost.amount === null) continue;
    const target = cost.timing === "START" ? months[0] : months[months.length - 1];
    if (target) target.oneTime += cost.amount;
    lines.push({
      id: `one-time-${cost.kind}`,
      label: ONE_TIME_LABELS[cost.kind],
      amount: cost.amount,
      formula: `${shekels(cost.amount)} ${cost.timing === "START" ? "בתחילת השכירות" : "בסיום השכירות"}`,
      sourceClauseIds: [cost.clauseId],
    });
  }

  if (exitAfter !== null) {
    const remaining = term - exitAfter;
    const kind = inputs.earlyExit.kind ?? "NOT_ALLOWED";
    const noticeMonths = Math.max(1, Math.ceil((inputs.earlyExit.noticeDays ?? 30) / 30));
    let owedMonths = 0;
    let owedAmount = 0;
    let formula = "";
    if (kind === "UNTIL_END" || kind === "NOT_ALLOWED") {
      owedMonths = remaining;
      formula = `${remaining} חודשי שכירות שנותרו עד סוף התקופה`;
      if (kind === "NOT_ALLOWED" || !inputs.earlyExit.kind) {
        notes.push("החוזה אינו מאפשר לכם לעזוב לפני סוף התקופה, ולכן החישוב מניח את המקרה הגרוע: תשלום עד סוף התקופה.");
      }
    } else if (kind === "UNTIL_REPLACEMENT") {
      owedMonths = Math.min(remaining, Math.max(noticeMonths, Math.round(scenario.replacementAfterMonths)));
      formula = `${owedMonths} חודשים עד שנמצא שוכר חלופי (לפי ההנחה שלכם)`;
    } else if (kind === "ALLOWED_WITH_NOTICE") {
      owedMonths = Math.min(remaining, noticeMonths);
      formula = `הודעה מוקדמת של ${inputs.earlyExit.noticeDays ?? 30} ימים ≈ ${owedMonths} חודשי שכירות`;
      if (inputs.earlyExit.noticeDays === null) notes.push("החוזה לא מציין את משך ההודעה המוקדמת; החישוב מניח חודש אחד.");
    } else if (kind === "FIXED_MONTHS") {
      owedMonths = Math.min(remaining, inputs.earlyExit.months ?? remaining);
      formula = `פיצוי של ${owedMonths} חודשי שכירות`;
    } else {
      owedAmount = inputs.earlyExit.amount ?? 0;
      formula = `פיצוי קבוע של ${shekels(owedAmount)}`;
    }
    for (let index = 1; index <= owedMonths; index += 1) {
      const month = exitAfter + index;
      const { base, increase, indexation } = rentFor(month);
      owedAmount += base + increase + indexation;
      months.push({
        month,
        period: addMonths(inputs.leaseStart, month - 1),
        phase: "EXIT",
        baseRent: base,
        increase,
        indexation,
        charges: 0,
        oneTime: 0,
        penalties: 0,
        total: 0,
        cumulative: 0,
      });
    }
    if (kind === "FIXED_AMOUNT" && months.length) months[exitAfter - 1]!.penalties += owedAmount;
    lines.push({
      id: "early-exit",
      label: `יציאה אחרי ${exitAfter} חודשים: ${EXIT_LABELS[kind]}`,
      amount: round(owedAmount),
      formula,
      sourceClauseIds: sources(inputs.earlyExit.clauseId),
    });
  }

  const lastOccupied = months.filter((month) => month.phase !== "EXIT").at(-1);
  const lastRent = lastOccupied ? lastOccupied.baseRent + lastOccupied.increase + lastOccupied.indexation : rent;
  if (withEvents && scenario.lateVacatingDays > 0 && lastOccupied) {
    const days = scenario.lateVacatingDays;
    const daily = lastRent / 30;
    const { perDay, dailyRentMultiple } = inputs.lateVacating;
    const amount = perDay !== null ? perDay * days : dailyRentMultiple !== null ? dailyRentMultiple * daily * days : daily * days;
    const formula = perDay !== null
      ? `${shekels(perDay)} × ${days} ימים`
      : dailyRentMultiple !== null
        ? `${dailyRentMultiple} × (${shekels(lastRent)} ÷ 30) × ${days} ימים`
        : `(${shekels(lastRent)} ÷ 30) × ${days} ימים`;
    if (perDay === null && dailyRentMultiple === null) {
      notes.push("החוזה לא קובע פיצוי על איחור בפינוי; החישוב מניח לפחות דמי שכירות יומיים על כל יום איחור.");
    }
    months.push({
      month: lastOccupied.month + 1,
      period: addMonths(inputs.leaseStart, lastOccupied.month),
      phase: "LATE",
      baseRent: 0,
      increase: 0,
      indexation: 0,
      charges: 0,
      oneTime: 0,
      penalties: amount,
      total: 0,
      cumulative: 0,
    });
    lines.push({ id: "late-vacating", label: `איחור של ${days} ימים בפינוי`, amount: round(amount), formula, sourceClauseIds: sources(inputs.lateVacating.clauseId) });
  }

  if (withEvents && scenario.latePaymentDays > 0 && months[0]) {
    const days = scenario.latePaymentDays;
    const { perDay, monthlyInterestPercent } = inputs.latePayment;
    let amount = 0;
    let formula = "";
    if (perDay !== null) {
      amount = perDay * days;
      formula = `${shekels(perDay)} × ${days} ימים`;
    } else if (monthlyInterestPercent !== null) {
      amount = rent * (monthlyInterestPercent / 100) * (days / 30);
      formula = `${shekels(rent)} × ${monthlyInterestPercent}% לחודש × (${days} ÷ 30)`;
    } else {
      notes.push("החוזה לא קובע קנס או ריבית על איחור בתשלום, אבל איחור ממושך עלול להיחשב הפרה של החוזה.");
    }
    if (amount > 0) {
      months[0].penalties += amount;
      lines.push({ id: "late-payment", label: `איחור של ${days} ימים בתשלום אחד`, amount: round(amount), formula, sourceClauseIds: sources(inputs.latePayment.clauseId) });
    }
  }

  let cumulative = 0;
  const totals = { rent: 0, increases: 0, indexation: 0, charges: 0, oneTime: 0, penalties: 0, total: 0, averageMonthly: 0 };
  for (const month of months) {
    month.total = round(month.baseRent + month.increase + month.indexation + month.charges + month.oneTime + month.penalties);
    cumulative += month.total;
    month.cumulative = round(cumulative);
    totals.rent += month.baseRent;
    totals.increases += month.increase;
    totals.indexation += month.indexation;
    totals.charges += month.charges;
    totals.oneTime += month.oneTime;
    totals.penalties += month.penalties;
    month.baseRent = round(month.baseRent);
    month.increase = round(month.increase);
    month.indexation = round(month.indexation);
    month.penalties = round(month.penalties);
  }
  const occupiedCount = months.filter((month) => month.phase === "TERM" || month.phase === "OPTION").length;
  totals.total = round(cumulative);
  totals.averageMonthly = occupiedCount ? round(cumulative / occupiedCount) : 0;
  for (const key of ["rent", "increases", "indexation", "charges", "oneTime", "penalties"] as const) totals[key] = round(totals[key]);

  lines.unshift(
    {
      id: "rent",
      label: "דמי שכירות בסיסיים",
      amount: totals.rent,
      formula: optionMonths
        ? `${shekels(rent)} × ${term} חודשים + ${shekels(optionBase)} × ${optionMonths} חודשי אופציה`
        : `${shekels(rent)} × ${months.filter((month) => month.phase !== "LATE").length} חודשים`,
      sourceClauseIds: sources(inputs.sources.monthlyRent, inputs.sources.leaseTermMonths, optionMonths ? inputs.sources.option : null),
    },
    ...(inputs.annualIncreasePercent ? [{
      id: "increase",
      label: "העלאות שנקבעו בחוזה",
      amount: totals.increases,
      formula: `${inputs.annualIncreasePercent}% בתחילת כל שנת שכירות`,
      sourceClauseIds: sources(inputs.sources.annualIncreasePercent),
    }] : []),
    ...(inputs.indexation.linked ? [{
      id: "indexation",
      label: "הצמדה למדד המחירים לצרכן",
      amount: totals.indexation,
      formula: `${scenario.annualInflationPercent}% אינפלציה שנתית, עדכון ${{ MONTHLY: "חודשי", ANNUAL: "שנתי", AT_RENEWAL: "בחידוש" }[inputs.indexation.frequency]}${inputs.indexation.floorAtBase ? ", בלי ירידה מתחת לסכום הבסיסי" : ""}`,
      sourceClauseIds: sources(inputs.sources.indexation),
    }] : []),
    ...(monthlyCharges ? [{
      id: "charges",
      label: "תשלומים שוטפים בסכום ידוע",
      amount: totals.charges,
      formula: `${knownCharges.map((charge) => `${CHARGE_LABELS[charge.kind]} ${shekels(charge.monthlyAmount!)}`).join(" + ")} לחודש`,
      sourceClauseIds: sources(...knownCharges.map((charge) => charge.clauseId)),
    }] : []),
  );
  if (inputs.indexation.assumedFrequency) {
    notes.push("החוזה צמוד למדד אך לא מציין באיזו תדירות; החישוב מניח עדכון חודשי.");
  }
  return { months, totals, lines, notes };
}
