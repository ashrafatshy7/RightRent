import type {
  AcceptedSecurityKind,
  AnalysisRecord,
  ContractClause,
  ContractRecord,
  FinancialTerms,
  FindingTopic,
  NegotiationContext,
  SecurityKind,
  TenantPreferences,
} from "../../domain/models.js";
import { isSubstantiveClause } from "../analyses/classification.js";
import { CHARGE_LABELS, EXIT_LABELS, ONE_TIME_LABELS } from "../analyses/cost-simulation.service.js";

// What the agent knows about this tenant and this contract, besides the flagged issues: the
// preferences the analysis ran with, the contract's financial terms (with the tenant's own
// corrections), and the whole contract text. Written in Hebrew so the model reads each value with
// its meaning, never as a bare field name. Snapshotted when the negotiation starts.

const SECURITY_LABELS: Record<SecurityKind, string> = {
  BANK_GUARANTEE: "ערבות בנקאית",
  CASH_DEPOSIT: "פיקדון במזומן",
  PROMISSORY_NOTE: "שטר חוב",
  GUARANTOR: "ערב",
  OTHER: "בטוחה אחרת",
};

const INDEX_LABELS = { CPI: "מדד המחירים לצרכן", USD: "שער הדולר", OTHER: "מדד אחר" } as const;
const FREQUENCY_LABELS = { MONTHLY: "חודשית", ANNUAL: "שנתית", AT_RENEWAL: "בחידוש החוזה", UNKNOWN: "תדירות לא צוינה" } as const;

const ils = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ₪`;
const yesNo = (value: boolean, yes: string, no: string) => (value ? yes : no);

type PreferenceKey = Exclude<keyof TenantPreferences, "additionalNotes"> | "additionalNotes";

function preferenceEntries(preferences: TenantPreferences, redactedNotes: string): Array<[PreferenceKey, string]> {
  const entries: Array<[PreferenceKey, string]> = [
    ["maxMonthlyRentIls", `תקציב מקסימלי לשכר דירה חודשי: ${ils(preferences.maxMonthlyRentIls)}`],
    ["maxMonthlyTotalCostIls", preferences.maxMonthlyTotalCostIls === null
      ? "תקציב חודשי כולל (שכר דירה וחיובים קבועים): לא הוגדר"
      : `תקציב חודשי כולל (שכר דירה וחיובים קבועים): ${ils(preferences.maxMonthlyTotalCostIls)}`],
    ["repairUrgencyHours", `הזמן הארוך ביותר שמקובל עליו לתיקון ליקוי דחוף: ${preferences.repairUrgencyHours} שעות`],
    ["leaseLengthMonths", `אורך השכירות שהוא מחפש: ${preferences.leaseLengthMonths} חודשים`],
    ["maxAnnualRentIncreasePercent", `העלאה שנתית מקסימלית שמקובלת עליו בשכר הדירה: ${preferences.maxAnnualRentIncreasePercent}%`],
    ["acceptsIndexation", `הצמדה של שכר הדירה למדד: ${yesNo(preferences.acceptsIndexation, "מקובלת עליו", "לא מקובלת עליו")}`],
    ["acceptedSecurityKinds", `סוגי הבטוחה שהוא מוכן לתת: ${preferences.acceptedSecurityKinds.map((kind: AcceptedSecurityKind) => SECURITY_LABELS[kind]).join(", ") || "לא צוין"}`],
    ["petsRequired", `חיית מחמד: ${yesNo(preferences.petsRequired, "חייב שהחוזה יאפשר", "לא נדרש")}`],
    ["furnishedRequired", `דירה מרוהטת: ${yesNo(preferences.furnishedRequired, "נדרשת", "לא נדרשת")}`],
    ["earlyExitRequired", `אפשרות לצאת מוקדם מהחוזה: ${yesNo(preferences.earlyExitRequired, "נדרשת", "לא נדרשת")}`],
    ["roommatesRequired", `הכנסת שותף או שכירות משנה: ${yesNo(preferences.roommatesRequired, "נדרשת", "לא נדרשת")}`],
    ["renewalOptionRequired", `אופציה להארכת השכירות: ${yesNo(preferences.renewalOptionRequired, "נדרשת", "לא נדרשת")}`],
    ["minEntryNoticeHours", preferences.minEntryNoticeHours === null
      ? "הודעה מוקדמת לפני כניסת המשכיר: לא הוגדרה דרישה"
      : `הודעה מוקדמת מינימלית לפני כניסת המשכיר: ${preferences.minEntryNoticeHours} שעות`],
    ["acceptsBrokerFee", `תשלום דמי תיווך על ידי השוכר: ${yesNo(preferences.acceptsBrokerFee, "מקובל עליו", "לא מקובל עליו")}`],
  ];
  if (redactedNotes.trim()) entries.push(["additionalNotes", `הערות נוספות שהשוכר כתב: ${redactedNotes.trim()}`]);
  return entries;
}

export function preferenceLines(preferences: TenantPreferences, redactedNotes: string): string[] {
  return preferenceEntries(preferences, redactedNotes).map(([, line]) => line);
}

// Which preferences bear on each subject the analysis tags a finding with. The tenant's own notes
// may touch anything, so they go with every subject.
const TOPIC_PREFERENCES: Record<FindingTopic, PreferenceKey[]> = {
  rent_and_term: ["maxMonthlyRentIls", "maxMonthlyTotalCostIls", "leaseLengthMonths", "maxAnnualRentIncreasePercent", "acceptsIndexation"],
  guarantee_security: ["acceptedSecurityKinds"],
  entry_privacy: ["minEntryNoticeHours"],
  repairs_maintenance: ["repairUrgencyHours"],
  charges_payments: ["maxMonthlyTotalCostIls", "maxMonthlyRentIls", "acceptsBrokerFee"],
  termination_renewal: ["earlyExitRequired", "renewalOptionRequired", "leaseLengthMonths"],
  waiver_liability: [],
  pets_and_use: ["petsRequired", "roommatesRequired", "furnishedRequired"],
  handover_condition: ["furnishedRequired"],
  other: [],
};

export function preferencesForTopic(preferences: TenantPreferences, redactedNotes: string, topic: FindingTopic) {
  const keys = new Set<PreferenceKey>([...TOPIC_PREFERENCES[topic], "additionalNotes"]);
  return preferenceEntries(preferences, redactedNotes).filter(([key]) => keys.has(key)).map(([, line]) => line);
}

// A value the contract states but nobody verified is shown as such, so the agent can ask about it
// instead of treating it as fact.
function sourced(text: string, verified: boolean, clauseId: string | null, overridden = false) {
  const where = clauseId ? ` (מקור: ${clauseId})` : "";
  const status = overridden ? " - כפי שהשוכר אישר" : verified ? "" : " - נקרא מהחוזה ולא אומת";
  return `${text}${where}${status}`;
}

export function contractTermLines(terms: FinancialTerms, overrides: AnalysisRecord["financialOverrides"] = {}): string[] {
  const lines: string[] = [];
  const o = overrides ?? {};
  const rent = o.monthlyRent ?? terms.monthlyRent?.value;
  if (rent !== undefined) lines.push(sourced(`שכר דירה חודשי: ${ils(rent)}`, terms.monthlyRent?.verified ?? false, terms.monthlyRent?.clauseId ?? null, o.monthlyRent !== undefined));
  const months = o.leaseTermMonths ?? terms.leaseTermMonths?.value;
  if (months !== undefined) lines.push(sourced(`תקופת השכירות: ${months} חודשים`, terms.leaseTermMonths?.verified ?? false, terms.leaseTermMonths?.clauseId ?? null, o.leaseTermMonths !== undefined));
  const start = o.leaseStart ?? terms.leaseStart?.value;
  if (start) lines.push(sourced(`תחילת השכירות: ${start}`, terms.leaseStart?.verified ?? false, terms.leaseStart?.clauseId ?? null, o.leaseStart !== undefined));
  if (o.indexationLinked === false) {
    lines.push("הצמדה: אין (כפי שהשוכר אישר)");
  } else if (terms.indexation) {
    lines.push(sourced(`הצמדה ל${INDEX_LABELS[terms.indexation.index]}, ${FREQUENCY_LABELS[o.indexationFrequency ?? terms.indexation.frequency]}${terms.indexation.floorAtBase ? ", בלי ירידה מתחת לסכום הבסיס" : ""}`, terms.indexation.verified, terms.indexation.clauseId, o.indexationLinked !== undefined));
  }
  const increase = o.annualIncreasePercent ?? terms.annualIncreasePercent?.value;
  if (increase !== undefined) lines.push(sourced(`העלאה שנתית קבועה: ${increase}%`, terms.annualIncreasePercent?.verified ?? false, terms.annualIncreasePercent?.clauseId ?? null, o.annualIncreasePercent !== undefined));
  const optionMonths = o.optionMonths ?? terms.option.months?.value;
  const optionRent = o.optionRent ?? terms.option.rent?.value;
  const optionIncrease = o.optionIncreasePercent ?? terms.option.increasePercent?.value;
  if (optionMonths !== undefined || optionRent !== undefined || optionIncrease !== undefined) {
    const parts = [
      optionMonths !== undefined ? `${optionMonths} חודשים` : null,
      optionRent !== undefined ? `שכר דירה ${ils(optionRent)}` : null,
      optionIncrease !== undefined ? `העלאה של ${optionIncrease}%` : null,
    ].filter(Boolean).join(", ");
    const source = terms.option.months ?? terms.option.rent ?? terms.option.increasePercent;
    lines.push(sourced(`אופציה להארכה: ${parts}`, source?.verified ?? false, source?.clauseId ?? null));
  }
  for (const charge of terms.charges) {
    const amount = o.chargeAmounts?.[charge.kind] ?? charge.monthlyAmount;
    lines.push(sourced(`${CHARGE_LABELS[charge.kind]}: על ${charge.payer === "TENANT" ? "השוכר" : "המשכיר"}${amount !== null && amount !== undefined ? `, ${ils(amount)} לחודש` : ", סכום לא צוין"}`, charge.verified, charge.clauseId, o.chargeAmounts?.[charge.kind] !== undefined));
  }
  for (const cost of terms.oneTimeCosts) {
    const amount = o.oneTimeAmounts?.[cost.kind] ?? cost.amount;
    lines.push(sourced(`${ONE_TIME_LABELS[cost.kind]} (${cost.timing === "START" ? "בתחילת השכירות" : "בסיומה"})${amount !== null && amount !== undefined ? `: ${ils(amount)}` : ": סכום לא צוין"}`, cost.verified, cost.clauseId, o.oneTimeAmounts?.[cost.kind] !== undefined));
  }
  terms.securities.forEach((security, index) => {
    const amount = index === 0 && o.securityAmount !== undefined ? o.securityAmount : security.amount;
    const returnDays = security.returnDays !== null ? `, מוחזרת תוך ${security.returnDays} ימים מסיום השכירות` : "";
    lines.push(sourced(`בטוחה - ${SECURITY_LABELS[security.kind]}${amount !== null ? `: ${ils(amount)}` : ": סכום לא צוין"}${returnDays}`, security.verified, security.clauseId, index === 0 && o.securityAmount !== undefined));
  });
  if (terms.lateVacating || o.lateVacatingPerDay !== undefined) {
    const perDay = o.lateVacatingPerDay ?? terms.lateVacating?.perDay;
    const multiple = terms.lateVacating?.dailyRentMultiple;
    const text = perDay !== null && perDay !== undefined ? `${ils(perDay)} ליום` : multiple ? `פי ${multiple} משכר הדירה היומי` : "סכום לא צוין";
    lines.push(sourced(`פיצוי על איחור בפינוי: ${text}`, terms.lateVacating?.verified ?? false, terms.lateVacating?.clauseId ?? null, o.lateVacatingPerDay !== undefined));
  }
  if (terms.latePayment || o.latePaymentPerDay !== undefined) {
    const perDay = o.latePaymentPerDay ?? terms.latePayment?.perDay;
    const interest = terms.latePayment?.monthlyInterestPercent;
    const text = perDay !== null && perDay !== undefined ? `${ils(perDay)} ליום` : interest ? `ריבית של ${interest}% לחודש` : "סכום לא צוין";
    lines.push(sourced(`פיצוי על איחור בתשלום: ${text}`, terms.latePayment?.verified ?? false, terms.latePayment?.clauseId ?? null, o.latePaymentPerDay !== undefined));
  }
  const exitKind = o.earlyExitKind ?? terms.earlyExit?.kind;
  if (exitKind) {
    const details = [
      (o.earlyExitMonths ?? terms.earlyExit?.months) ? `${o.earlyExitMonths ?? terms.earlyExit?.months} חודשי שכירות` : null,
      terms.earlyExit?.amount ? ils(terms.earlyExit.amount) : null,
      (o.earlyExitNoticeDays ?? terms.earlyExit?.noticeDays) ? `הודעה מוקדמת של ${o.earlyExitNoticeDays ?? terms.earlyExit?.noticeDays} ימים` : null,
    ].filter(Boolean).join(", ");
    lines.push(sourced(`יציאה מוקדמת: ${EXIT_LABELS[exitKind]}${details ? ` (${details})` : ""}`, terms.earlyExit?.verified ?? false, terms.earlyExit?.clauseId ?? null, o.earlyExitKind !== undefined));
  }
  for (const unknown of terms.unknowns) lines.push(`לא צוין בחוזה: ${unknown}`);
  return lines;
}

function clauseHeader(clause: ContractClause) {
  return [clause.sectionLabel ? `סעיף ${clause.sectionLabel}` : null, clause.heading].filter(Boolean).join(" - ");
}

// `redact` removes personal details locally; nothing here reaches the model unredacted.
export async function buildNegotiationContext(
  analysis: AnalysisRecord,
  contract: ContractRecord | null,
  redact: (texts: string[]) => Promise<string[]>,
): Promise<{ context: NegotiationContext; redactedNotes: string }> {
  const clauses = (contract?.clauses ?? []).filter(isSubstantiveClause);
  const [notes = "", ...clauseTexts] = await redact([analysis.preferencesSnapshot.additionalNotes ?? "", ...clauses.map((clause) => clause.text)]);
  return {
    redactedNotes: notes,
    context: {
      preferences: preferenceLines(analysis.preferencesSnapshot, notes),
      contractTerms: contractTermLines(analysis.financialTerms, analysis.financialOverrides),
      clauses: clauses.map((clause, index) => ({
        clauseId: clause.id,
        header: clauseHeader(clause) || null,
        text: clauseTexts[index] ?? "",
      })),
    },
  };
}
