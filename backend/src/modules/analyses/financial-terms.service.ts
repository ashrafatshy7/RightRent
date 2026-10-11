import type {
  ChargeKind,
  ContractClause,
  EarlyExitKind,
  FinancialTerms,
  IndexationFrequency,
  OneTimeCostKind,
  SecurityKind,
  SourcedNumber,
  TermSource,
} from "../../domain/models.js";
import {
  amountsIn,
  durationsIn,
  hebrewNumber,
  mentionsConcept,
  percentsIn,
  term,
  type ClauseProfile,
  type ContractFacts,
} from "./clause-facts.service.js";
import type { ModelFinancialTerms } from "./ai-providers.js";
import { findVerbatimSpan } from "./classification.js";

// Reads the money terms of a contract for the cost simulator: what is paid, when, how it grows, and
// what leaving early or late costs. The local rules below cover the common phrasings; with the
// Anthropic provider Claude reads the same terms (see extractFinancialTermsWithClaude), and the two
// are merged so that every number shown is traced to a verbatim quote that contains it.

const HEBREW_MONTHS: Record<string, number> = {
  "ינואר": 1, "פברואר": 2, "מרץ": 3, "מרס": 3, "אפריל": 4, "מאי": 5, "יוני": 6,
  "יולי": 7, "אוגוסט": 8, "ספטמבר": 9, "אוקטובר": 10, "נובמבר": 11, "דצמבר": 12,
};
const MONTH_NAMES = Object.keys(HEBREW_MONTHS).join("|");
const NAMED_DATE = new RegExp(`(\\d{1,2})\\s+ב?(${MONTH_NAMES})\\s+(\\d{4})`, "u");
const NUMERIC_DATE = /(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?!\d)/u;
const START_MARKER = /(?:מיום|החל\s+מ|מתאריך|תחילת\s+(?:ה)?(?:שכירות|תקופה))/u;

const TENANT_PAYS = /השוכר(?:ת)?\s+(?:ישלם|תשלם|יישא|תישא|ישא|תשא|אחראי|אחראית)|על\s+(?:חשבון\s+)?השוכר|יחולו\s+על\s+השוכר|ישולמו\s+על\s+ידי\s+השוכר/u;
const LANDLORD_PAYS = /(?:המשכיר|המשכירה|בעל(?:ת)?\s+הדירה)\s+(?:ישלם|תשלם|יישא|תישא|ישא|תשא|אחראי|אחראית)|על\s+(?:חשבון\s+)?(?:המשכיר|בעל(?:ת)?\s+הדירה)|יחולו\s+על\s+(?:המשכיר|בעל(?:ת)?\s+הדירה)/u;

const CHARGE_TERMS: Array<{ kind: ChargeKind; pattern: RegExp; name: string }> = [
  { kind: "ARNONA", pattern: term("ארנונה"), name: "ארנונה" },
  { kind: "WATER", pattern: term("מים"), name: "מים" },
  { kind: "ELECTRICITY", pattern: term("חשמל"), name: "חשמל" },
  { kind: "GAS", pattern: term("גז"), name: "גז" },
  { kind: "VAAD_BAYIT", pattern: term("ועד\\s+(?:ה)?בית|דמי\\s+ועד|תשלומי\\s+ועד"), name: "ועד בית" },
  { kind: "BUILDING_INSURANCE", pattern: term("ביטוח\\s+(?:ה)?מבנה"), name: "ביטוח מבנה" },
  { kind: "SPECIAL_BUILDING_EXPENSES", pattern: term("הוצאות\\s+מיוחדות|חיוב\\s+מיוחד|חיובים\\s+מיוחדים"), name: "הוצאות מיוחדות של הבניין" },
  { kind: "CONTENTS_INSURANCE", pattern: term("ביטוח\\s+(?:ה)?תכולה"), name: "ביטוח תכולה" },
];

const ONE_TIME_TERMS: Array<{ kind: OneTimeCostKind; pattern: RegExp; timing: "START" | "END" }> = [
  { kind: "BROKER_FEE", pattern: term("דמי\\s+(?:ה)?תיווך|עמלת\\s+(?:ה)?תיווך"), timing: "START" },
  { kind: "LEGAL_FEE", pattern: term("שכר\\s+(?:ה)?טרחת?\\s+(?:עורך|עו\"ד|עו״ד)|עריכת\\s+(?:ה)?(?:חוזה|הסכם)"), timing: "START" },
  { kind: "CLEANING", pattern: term("ניקיון|ניקוי"), timing: "END" },
];

const SECURITY_KINDS: Array<{ kind: SecurityKind; pattern: RegExp }> = [
  { kind: "BANK_GUARANTEE", pattern: /ערבות\s+בנקאית|bank\s+guarantee/iu },
  { kind: "PROMISSORY_NOTE", pattern: /שטר\s+חוב/u },
  { kind: "CASH_DEPOSIT", pattern: /פיקדון|פקדון|deposit/iu },
  { kind: "GUARANTOR", pattern: /(?<![\p{L}])ערב(?:ים)?(?![\p{L}])/u },
];

function source(clauseId: string, quote: string): TermSource {
  return { clauseId, quote, verified: true, origin: "RULE" };
}

function sourced(value: number, clauseId: string, quote: string): SourcedNumber {
  return { value, ...source(clauseId, quote) };
}

function isoDate(day: number, month: number, year: number) {
  const fullYear = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "מיום 1 בספטמבר 2026", "החל מ-01/09/2026".
function startDate(sentence: string) {
  const marker = START_MARKER.exec(sentence);
  const tail = marker ? sentence.slice(marker.index) : sentence;
  const named = NAMED_DATE.exec(tail);
  if (named) return isoDate(Number(named[1]), HEBREW_MONTHS[named[2]!]!, Number(named[3]));
  const numeric = NUMERIC_DATE.exec(tail);
  return numeric ? isoDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3])) : null;
}

// "פי שניים מדמי השכירות היומיים", "פי 3 משכר הדירה היומי".
function dailyRentMultiple(sentence: string) {
  const match = /פי\s+(\d+(?:\.\d+)?|\S+)\s+מ(?:דמי\s+(?:ה)?שכירות|שכר\s+(?:ה)?דירה)\s+(?:ה)?יומי/u.exec(sentence);
  if (!match) return null;
  return /^\d/u.test(match[1]!) ? Number(match[1]) : hebrewNumber(match[1]!);
}

const TENANT_MAY_END = /(?:השוכר(?:ת)?|כל\s+אחד\s+מהצדדים|כל\s+צד)\s+(?:יהיה\s+|תהיה\s+)?(?:רשאי|רשאית)/u;
const NO_TENANT_RIGHT = /אין\s+לשוכר(?:ת)?\s+(?:כל\s+)?(?:זכות|רשות)|לשוכר(?:ת)?\s+לא\s+(?:תהיה|יהיה)\s+(?:כל\s+)?(?:זכות|רשות)|השוכר(?:ת)?\s+(?:אינו|אינה|לא\s+יהיה|לא\s+תהיה)\s+רשאי/u;
const REPLACEMENT = /שוכר\s+(?:חלופי|מחליף|אחר\s+במקומ)/u;
const NO_REPLACEMENT = /(?:אין|ללא|לא\s+(?:יוכל|תוכל|רשאי|רשאית))[^.]{0,40}שוכר\s+(?:חלופי|מחליף)/u;
const REPLACEMENT_REQUIRED = /(?:ובלבד|בתנאי|ובתנאי)\s+ש[^.]{0,30}שוכר\s+(?:חלופי|מחליף)|עד\s+(?:ש(?:י|ת)?מצא|למציאת)[^.]{0,20}שוכר\s+(?:חלופי|מחליף)/u;
// The tenant's own right to bring a replacement; a sentence that merely mentions one ("the landlord
// will not refuse a replacement unreasonably") supports a right stated elsewhere.
const MAY_PROPOSE_REPLACEMENT = /(?:רשאי|רשאית|יוכל|תוכל|זכאי|זכאית)\s+(?:ל)?(?:הציע|להציע|להעמיד|להביא|למצוא)[^.]{0,20}שוכר\s+(?:חלופי|מחליף)/u;
const PAYS_UNTIL_END = /(?:ישא|תישא|יישא|ישלם|תשלם)\s+(?:ב|את\s+)?(?:דמי\s+(?:ה)?שכירות|שכר\s+(?:ה)?דירה)[^.]{0,40}(?:עד\s+(?:סוף|תום)\s+(?:ה)?(?:תקופה|שכירות|חוזה|הסכם)|עד\s+סופה|עד\s+תומה)/u;

// How specific each reading of the tenant's early-exit position is; a more specific clause wins, and
// two clauses that disagree (one denies any right, another grants one) are flagged as a conflict.
const EXIT_SPECIFICITY: Record<EarlyExitKind, number> = {
  UNTIL_END: 6,
  FIXED_AMOUNT: 5,
  FIXED_MONTHS: 5,
  UNTIL_REPLACEMENT: 4,
  ALLOWED_WITH_NOTICE: 3,
  NOT_ALLOWED: 2,
};

// The notice the tenant must give: the duration after the tenant is named ("בעלת הדירה בהודעה של 90
// ימים והשוכר בהודעה של 60 ימים" gives 60).
function tenantNoticeDays(sentence: string) {
  if (!/הודעה|התראה/u.test(sentence)) return null;
  const tenantAt = sentence.search(/השוכר/u);
  const days = durationsIn(sentence).filter((duration) => duration.unit === "days");
  return (days.find((duration) => tenantAt >= 0 && duration.index > tenantAt) ?? days[0])?.value ?? null;
}

function earlyExitTerms(sentence: string): { kind: EarlyExitKind; months: number | null; amount: number | null; noticeDays: number | null } | null {
  const notice = tenantNoticeDays(sentence);
  const replacement = REPLACEMENT.test(sentence) && !NO_REPLACEMENT.test(sentence);
  if (PAYS_UNTIL_END.test(sentence)) return { kind: "UNTIL_END", months: null, amount: null, noticeDays: null };
  const months = /דמי\s+(?:ה)?שכירות\s+(?:של|בגין|עבור)\s+(\d+|\S+)\s+חודשים|(\d+|\S+)\s+חודשי\s+שכירות/u.exec(sentence);
  if (months && /פיצוי|ישלם|תשלם/u.test(sentence)) {
    const raw = months[1] ?? months[2]!;
    const value = /^\d/u.test(raw) ? Number(raw) : hebrewNumber(raw);
    if (value) return { kind: "FIXED_MONTHS", months: value, amount: null, noticeDays: notice };
  }
  const amount = amountsIn(sentence)[0];
  if (amount && /פיצוי|קנס/u.test(sentence)) return { kind: "FIXED_AMOUNT", months: null, amount: amount.value, noticeDays: notice };
  if (TENANT_MAY_END.test(sentence)) {
    // "רשאי לסיים בהודעה של 60 ימים, ובלבד שיציע שוכר חלופי" makes a replacement the condition;
    // "בהודעה של 60 ימים, או להציע שוכר חלופי" makes it an alternative to plain notice.
    if (replacement && REPLACEMENT_REQUIRED.test(sentence)) return { kind: "UNTIL_REPLACEMENT", months: null, amount: null, noticeDays: notice };
    if (notice !== null || !replacement) return { kind: "ALLOWED_WITH_NOTICE", months: null, amount: null, noticeDays: notice };
  }
  if (replacement && (REPLACEMENT_REQUIRED.test(sentence) || MAY_PROPOSE_REPLACEMENT.test(sentence))) {
    return { kind: "UNTIL_REPLACEMENT", months: null, amount: null, noticeDays: notice };
  }
  if (NO_TENANT_RIGHT.test(sentence)) return { kind: "NOT_ALLOWED", months: null, amount: null, noticeDays: null };
  return null;
}

function emptyTerms(): FinancialTerms {
  return {
    monthlyRent: null,
    leaseTermMonths: null,
    leaseStart: null,
    indexation: null,
    annualIncreasePercent: null,
    option: { months: null, rent: null, increasePercent: null },
    charges: [],
    oneTimeCosts: [],
    securities: [],
    lateVacating: null,
    latePayment: null,
    earlyExit: null,
    unknowns: [],
  };
}

export function extractFinancialTermsDeterministically(
  clauses: ContractClause[],
  profiles: ReadonlyMap<string, ClauseProfile>,
  contractFacts: ContractFacts,
): FinancialTerms {
  const terms = emptyTerms();
  const rent = contractFacts.MONTHLY_RENT;
  const leaseTerm = contractFacts.LEASE_TERM_MONTHS;
  if (rent) terms.monthlyRent = sourced(rent.value, rent.clauseId, rent.sentence);
  if (leaseTerm) terms.leaseTermMonths = sourced(leaseTerm.value, leaseTerm.clauseId, leaseTerm.sentence);
  const optionRent = contractFacts.OPTION_RENT;
  if (optionRent) terms.option.rent = sourced(optionRent.value, optionRent.clauseId, optionRent.sentence);

  for (const clause of clauses) {
    const profile = profiles.get(clause.id);
    if (!profile) continue;
    for (const sentence of profile.sentences) {
      const about = (concept: Parameters<typeof mentionsConcept>[1]) => mentionsConcept(sentence, concept);

      if (!terms.leaseStart && (about("TERM") || START_MARKER.test(sentence))) {
        const date = startDate(sentence);
        if (date) terms.leaseStart = { value: date, ...source(clause.id, sentence) };
      }

      if (!terms.indexation && about("INDEXATION")) {
        const frequency: IndexationFrequency = /בכל\s+חודש|מדי\s+חודש|חודשית/u.test(sentence)
          ? "MONTHLY"
          : /(?:אחת|פעם)\s+(?:ל|ב)שנה|מדי\s+שנה|בתום\s+כל\s+שנה|שנתי/u.test(sentence)
            ? "ANNUAL"
            : /אופציה|הארכה|תקופה\s+נוספת/u.test(sentence) ? "AT_RENEWAL" : "UNKNOWN";
        terms.indexation = {
          index: /דולר/u.test(sentence) ? "USD" : /מדד/u.test(sentence) ? "CPI" : "OTHER",
          frequency,
          floorAtBase: /לא\s+(?:י|ת)פחת(?:ו)?|לא\s+יקטנו/u.test(sentence),
          ...source(clause.id, sentence),
        };
      }

      // An increase stated in a clause about the option ("the rent above reflects a 3% increase") is
      // the option-period increase, even when the sentence itself does not name the option.
      if (about("OPTION") || (profile.primaryConcepts.has("OPTION") && percentsIn(sentence).length)) {
        const months = durationsIn(sentence).find((duration) => duration.unit === "months");
        if (months && !terms.option.months) terms.option.months = sourced(months.value, clause.id, sentence);
        const percent = percentsIn(sentence)[0];
        if (percent && !terms.option.increasePercent && (about("RENT_INCREASE") || about("RENT"))) {
          terms.option.increasePercent = sourced(percent.value, clause.id, sentence);
        }
      } else if (about("RENT_INCREASE") && !terms.annualIncreasePercent) {
        const percent = percentsIn(sentence)[0];
        if (percent) terms.annualIncreasePercent = sourced(percent.value, clause.id, sentence);
      }

      const chargeMentions = CHARGE_TERMS.filter(({ pattern }) => {
        pattern.lastIndex = 0;
        return pattern.test(sentence);
      });
      if (chargeMentions.length) {
        const payer = LANDLORD_PAYS.test(sentence) && !TENANT_PAYS.test(sentence) ? "LANDLORD" : "TENANT";
        const amounts = amountsIn(sentence);
        for (const charge of chargeMentions) {
          if (terms.charges.some((existing) => existing.kind === charge.kind)) continue;
          // An amount is attributed only when the sentence names exactly one charge.
          const monthlyAmount = chargeMentions.length === 1 && amounts.length === 1 ? amounts[0]!.value : null;
          terms.charges.push({ kind: charge.kind, payer, monthlyAmount, ...source(clause.id, sentence) });
        }
      }

      for (const oneTime of ONE_TIME_TERMS) {
        oneTime.pattern.lastIndex = 0;
        const mention = oneTime.pattern.exec(sentence);
        if (!mention || terms.oneTimeCosts.some((existing) => existing.kind === oneTime.kind)) continue;
        const amount = amountsIn(sentence).find((item) => item.index > mention.index) ?? amountsIn(sentence)[0];
        if (!amount) continue;
        terms.oneTimeCosts.push({ kind: oneTime.kind, amount: amount.value, timing: oneTime.timing, ...source(clause.id, sentence) });
      }

      const lateVacating = /(?:איחור|לא\s+(?:י|ת)פנה|אי\s+פינוי|לא\s+פונתה|עיכוב)[^.]{0,40}(?:פינוי|לפנות|הדירה)|פינוי[^.]{0,30}איחור/u.test(sentence);
      if (lateVacating && !terms.lateVacating) {
        const perDay = /לכל\s+יום|ליום|יומי/u.test(sentence) ? amountsIn(sentence)[0]?.value ?? null : null;
        const multiple = dailyRentMultiple(sentence);
        if (perDay || multiple) {
          terms.lateVacating = { perDay, dailyRentMultiple: multiple, ...source(clause.id, sentence) };
        }
      }

      const latePayment = /(?:איחור|פיגור)\s+(?:של\s+[^.]{0,20}\s+)?(?:ב)?תשלום|ריבית\s+פיגורים|דמי\s+פיגור/u.test(sentence);
      if (latePayment && !terms.latePayment && !lateVacating) {
        const perDay = /לכל\s+יום|ליום/u.test(sentence) ? amountsIn(sentence)[0]?.value ?? null : null;
        const percent = percentsIn(sentence)[0]?.value ?? null;
        const monthlyInterestPercent = percent === null ? null : /לשנה|שנתית/u.test(sentence) ? percent / 12 : percent;
        if (perDay || monthlyInterestPercent) {
          terms.latePayment = { perDay, monthlyInterestPercent, ...source(clause.id, sentence) };
        }
      }

      if (about("EARLY_TERMINATION") || about("REPLACEMENT_TENANT") || NO_TENANT_RIGHT.test(sentence)) {
        const exit = earlyExitTerms(sentence);
        if (exit) {
          const current = terms.earlyExit;
          const contradicts = current !== null
            && (current.kind === "NOT_ALLOWED") !== (exit.kind === "NOT_ALLOWED")
            && current.clauseId !== clause.id;
          if (!current || EXIT_SPECIFICITY[exit.kind] > EXIT_SPECIFICITY[current.kind]) {
            terms.earlyExit = { ...exit, ...source(clause.id, sentence), ...(contradicts || current?.conflict ? { conflict: true } : {}) };
          } else if (contradicts) {
            terms.earlyExit = { ...current, conflict: true };
          }
        }
      }
    }

    for (const fact of profile.facts.filter((item) => item.kind === "SECURITY_AMOUNT")) {
      const kind = SECURITY_KINDS.find(({ pattern }) => pattern.test(fact.sentence))?.kind ?? "OTHER";
      terms.securities.push({ kind, amount: fact.value, returnDays: null, ...source(clause.id, fact.sentence) });
    }
  }

  const returnDays = contractFacts.SECURITY_RETURN_DAYS?.value ?? null;
  terms.securities = terms.securities.map((security) => ({ ...security, returnDays }));
  terms.unknowns = unknownsFor(terms);
  return terms;
}

const CHARGE_NAMES = Object.fromEntries(CHARGE_TERMS.map(({ kind, name }) => [kind, name])) as Record<ChargeKind, string>;

// What the tenant should know the contract does not say, in plain Hebrew.
export function unknownsFor(terms: FinancialTerms): string[] {
  const notes: string[] = [];
  if (!terms.monthlyRent) notes.push("לא מצאנו בחוזה את דמי השכירות החודשיים.");
  if (!terms.leaseTermMonths) notes.push("לא מצאנו בחוזה את משך תקופת השכירות.");
  if (terms.indexation?.frequency === "UNKNOWN") notes.push("החוזה צמוד למדד אך לא קובע באיזו תדירות יעודכנו דמי השכירות.");
  for (const charge of terms.charges) {
    if (charge.payer === "TENANT" && charge.monthlyAmount === null) {
      notes.push(`החוזה מטיל עליכם ${CHARGE_NAMES[charge.kind] ?? "תשלום שוטף"} בלי לציין סכום.`);
    }
  }
  if (!terms.earlyExit) notes.push("החוזה לא קובע מה קורה אם תרצו לעזוב לפני סוף התקופה.");
  else if (terms.earlyExit.conflict) notes.push("סעיפי החוזה סותרים זה את זה לגבי האפשרות שלכם לעזוב לפני סוף התקופה.");
  return notes;
}

// The model returns the same shape with a clause ID and quote for every value. A value survives only
// if its quote is verbatim text of the cited clause (whitespace-insensitive) and, for a number, the
// number itself appears in that quote - otherwise it is kept as unverified, shown for confirmation
// but not counted.
export function verifyQuote(clauses: ReadonlyMap<string, ContractClause>, clauseId: string, quote: string, value?: number) {
  const clause = clauses.get(clauseId);
  const span = clause ? findVerbatimSpan(clause.text, quote) : null;
  if (!span) return { quote, verified: false };
  if (value === undefined) return { quote: span, verified: true };
  const mentioned = [
    ...amountsIn(span).map((item) => item.value),
    ...durationsIn(span).map((item) => item.value),
    ...percentsIn(span).map((item) => item.value),
    ...(span.match(/\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?/gu) ?? []).map((text) => Number(text.replace(/,/gu, ""))),
  ];
  return { quote: span, verified: mentioned.some((candidate) => Math.abs(candidate - value) < 0.005) };
}

type Keyed<T> = T & { clauseId: string };

// Combines the two readings: a verified model value wins and is flagged as a conflict when the rules
// read a different value; an unverified model value never displaces a rule value.
function pickNumber(rule: SourcedNumber | null, model: SourcedNumber | null): SourcedNumber | null {
  if (!model) return rule;
  if (!model.verified) return rule ?? model;
  if (rule && Math.abs(rule.value - model.value) > 0.005) return { ...model, conflict: true };
  return model;
}

function pickTerm<T extends TermSource>(rule: T | null, model: T | null): T | null {
  if (!model) return rule;
  if (!model.verified) return rule ?? model;
  return model;
}

function mergeByKind<T extends Keyed<TermSource> & { kind: string }>(rule: T[], model: T[]): T[] {
  const merged = new Map(rule.map((item) => [item.kind, item]));
  for (const item of model) {
    const existing = merged.get(item.kind);
    if (!existing || item.verified) merged.set(item.kind, item);
  }
  return [...merged.values()];
}

export function mergeFinancialTerms(rule: FinancialTerms, model: FinancialTerms | null): FinancialTerms {
  if (!model) return rule;
  const merged: FinancialTerms = {
    monthlyRent: pickNumber(rule.monthlyRent, model.monthlyRent),
    leaseTermMonths: pickNumber(rule.leaseTermMonths, model.leaseTermMonths),
    leaseStart: pickTerm(rule.leaseStart, model.leaseStart),
    indexation: pickTerm(rule.indexation, model.indexation),
    annualIncreasePercent: pickNumber(rule.annualIncreasePercent, model.annualIncreasePercent),
    option: {
      months: pickNumber(rule.option.months, model.option.months),
      rent: pickNumber(rule.option.rent, model.option.rent),
      increasePercent: pickNumber(rule.option.increasePercent, model.option.increasePercent),
    },
    charges: mergeByKind(rule.charges, model.charges),
    oneTimeCosts: mergeByKind(rule.oneTimeCosts, model.oneTimeCosts),
    // Securities are not unique by kind (two bank guarantees are possible); the model's verified
    // list replaces the rules' when it has one.
    securities: model.securities.some((item) => item.verified) ? model.securities : rule.securities,
    lateVacating: pickTerm(rule.lateVacating, model.lateVacating),
    latePayment: pickTerm(rule.latePayment, model.latePayment),
    earlyExit: pickTerm(rule.earlyExit, model.earlyExit),
    unknowns: [],
  };
  merged.unknowns = unknownsFor(merged);
  return merged;
}

// Turns the model's reading into FinancialTerms, checking every value against the clause it cites.
export function fromModelTerms(model: ModelFinancialTerms, clauses: ContractClause[]): FinancialTerms {
  const byId = new Map(clauses.map((clause) => [clause.id, clause]));
  const checked = (clauseId: string, quote: string, value?: number): TermSource => {
    const { quote: span, verified } = verifyQuote(byId, clauseId, quote, value);
    return { clauseId, quote: span, verified, origin: "MODEL" };
  };
  const number = (item: { value: number; clauseId: string; quote: string } | undefined): SourcedNumber | null =>
    item ? { value: item.value, ...checked(item.clauseId, item.quote, item.value) } : null;
  // An item whose numbers are optional is verified on its first stated number, or on its quote alone.
  const firstNumber = (...values: Array<number | undefined>) => values.find((value) => value !== undefined);

  const terms: FinancialTerms = {
    monthlyRent: number(model.monthlyRent),
    leaseTermMonths: number(model.leaseTermMonths),
    leaseStart: model.leaseStart ? { value: model.leaseStart.value, ...checked(model.leaseStart.clauseId, model.leaseStart.quote) } : null,
    indexation: model.indexation
      ? {
        index: model.indexation.index,
        frequency: model.indexation.frequency,
        floorAtBase: model.indexation.floorAtBase,
        ...checked(model.indexation.clauseId, model.indexation.quote),
      }
      : null,
    annualIncreasePercent: number(model.annualIncreasePercent),
    option: {
      months: number(model.option.months),
      rent: number(model.option.rent),
      increasePercent: number(model.option.increasePercent),
    },
    charges: model.charges.map((charge) => ({
      kind: charge.kind,
      payer: charge.payer,
      monthlyAmount: charge.monthlyAmount ?? null,
      ...checked(charge.clauseId, charge.quote, charge.monthlyAmount),
    })),
    oneTimeCosts: model.oneTimeCosts.map((cost) => ({
      kind: cost.kind,
      amount: cost.amount ?? null,
      timing: cost.timing,
      ...checked(cost.clauseId, cost.quote, cost.amount),
    })),
    securities: model.securities.map((security) => ({
      kind: security.kind,
      amount: security.amount ?? null,
      returnDays: security.returnDays ?? null,
      ...checked(security.clauseId, security.quote, firstNumber(security.amount, security.returnDays)),
    })),
    lateVacating: model.lateVacating
      ? {
        perDay: model.lateVacating.perDay ?? null,
        dailyRentMultiple: model.lateVacating.dailyRentMultiple ?? null,
        ...checked(model.lateVacating.clauseId, model.lateVacating.quote, firstNumber(model.lateVacating.perDay, model.lateVacating.dailyRentMultiple)),
      }
      : null,
    latePayment: model.latePayment
      ? {
        perDay: model.latePayment.perDay ?? null,
        monthlyInterestPercent: model.latePayment.monthlyInterestPercent ?? null,
        ...checked(model.latePayment.clauseId, model.latePayment.quote, firstNumber(model.latePayment.perDay, model.latePayment.monthlyInterestPercent)),
      }
      : null,
    earlyExit: model.earlyExit
      ? {
        kind: model.earlyExit.kind,
        months: model.earlyExit.months ?? null,
        amount: model.earlyExit.amount ?? null,
        noticeDays: model.earlyExit.noticeDays ?? null,
        ...checked(model.earlyExit.clauseId, model.earlyExit.quote, firstNumber(model.earlyExit.amount, model.earlyExit.months, model.earlyExit.noticeDays)),
      }
      : null,
    unknowns: [],
  };
  terms.unknowns = unknownsFor(terms);
  return terms;
}
