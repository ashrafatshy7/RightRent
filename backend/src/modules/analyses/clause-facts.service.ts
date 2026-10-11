import type { ContractClause } from "../../domain/models.js";

// Reads a clause the way a careful tenant would before judging it: which subjects it deals with
// (concepts), which numbers it sets and what each number is for (facts), and which other sections it
// points to (references). Everything here is plain, local text processing - no model is involved -
// so the same contract always yields the same profile, and every fact keeps the sentence it came from.

export type ConceptId =
  | "RENT"
  | "TERM"
  | "SECURITY"
  | "GUARANTOR"
  | "INDEXATION"
  | "RENT_INCREASE"
  | "OPTION"
  | "URGENT_REPAIR"
  | "REPAIRS"
  | "SELF_REPAIR"
  | "ENTRY"
  | "EARLY_TERMINATION"
  | "REPLACEMENT_TENANT"
  | "BREACH"
  | "VACATING"
  | "PENALTY"
  | "CHARGES"
  | "INSURANCE"
  | "HANDOVER"
  | "WAIVER"
  | "PETS"
  | "SUBLET"
  | "SALE_TRANSFER"
  | "ALTERATIONS";

export type FactKind =
  | "MONTHLY_RENT"
  | "OPTION_RENT"
  | "PREPAID_RENT"
  | "SECURITY_AMOUNT"
  | "LEASE_TERM_MONTHS"
  | "URGENT_REPAIR_DAYS"
  | "REPAIR_DAYS"
  | "SECURITY_RETURN_DAYS"
  | "RENT_INCREASE_PERCENT";

export type ClauseFact = {
  kind: FactKind;
  value: number;
  unit: "ILS" | "days" | "months" | "percent";
  clauseId: string;
  // The sentence the value was read from, verbatim from the clause.
  sentence: string;
};

export type ReferenceKind = "REFERENCE" | "SUBJECT_TO" | "NOTWITHSTANDING";

export type ClauseReference = { kind: ReferenceKind; sectionLabel: string; sentence: string };

export type ClauseProfile = {
  clauseId: string;
  sectionLabel?: string;
  concepts: Map<ConceptId, number>;
  // Concepts the clause is mainly about: named in its heading, mentioned repeatedly, or its most
  // frequent subject. A passing mention ("subject to the rent payments...") does not count.
  primaryConcepts: Set<ConceptId>;
  headingConcepts: Set<ConceptId>;
  facts: ClauseFact[];
  references: ClauseReference[];
  sentences: string[];
};

export const CONCEPT_NAMES: Record<ConceptId, string> = {
  RENT: "דמי השכירות",
  TERM: "תקופת השכירות",
  SECURITY: "הבטוחות והערבות",
  GUARANTOR: "דרישת ערב",
  INDEXATION: "הצמדה למדד",
  RENT_INCREASE: "העלאת דמי השכירות",
  OPTION: "אופציה והארכת השכירות",
  URGENT_REPAIR: "תיקון ליקוי דחוף",
  REPAIRS: "תיקונים ואחזקה",
  SELF_REPAIR: "תיקון עצמאי והחזר הוצאות",
  ENTRY: "כניסת המשכיר לדירה",
  EARLY_TERMINATION: "סיום מוקדם של החוזה",
  REPLACEMENT_TENANT: "שוכר חלופי",
  BREACH: "הפרת החוזה",
  VACATING: "פינוי הדירה",
  PENALTY: "פיצויים וקנסות",
  CHARGES: "תשלומים שוטפים",
  INSURANCE: "ביטוח",
  HANDOVER: "מצב הדירה במסירה",
  WAIVER: "ויתור על טענות",
  PETS: "בעלי חיים",
  SUBLET: "שכירות משנה",
  SALE_TRANSFER: "העברת הבעלות בדירה",
  ALTERATIONS: "שינויים בדירה",
};

export const FACT_NAMES: Record<FactKind, string> = {
  MONTHLY_RENT: "דמי השכירות החודשיים",
  OPTION_RENT: "דמי השכירות בתקופת האופציה",
  PREPAID_RENT: "דמי שכירות ששולמו מראש",
  SECURITY_AMOUNT: "סכום הבטוחה",
  LEASE_TERM_MONTHS: "תקופת השכירות",
  URGENT_REPAIR_DAYS: "המועד לתיקון ליקוי דחוף",
  REPAIR_DAYS: "המועד לתיקון ליקוי רגיל",
  SECURITY_RETURN_DAYS: "המועד להשבת הבטוחה",
  RENT_INCREASE_PERCENT: "שיעור העלאת דמי השכירות",
};

// Hebrew attaches up to a few one-letter prefixes (ו, ה, ב, ל, מ, ש, כ) to the next word, so every
// term may be preceded by them; the lookbehind keeps a term from matching inside another word.
function term(alternatives: string) {
  return new RegExp(`(?<![\\p{L}])(?:[והבלמשכ]{1,3})?(?:${alternatives})`, "giu");
}

const CONCEPT_PATTERNS: Record<ConceptId, RegExp> = {
  RENT: term("דמי\\s+(?:ה)?שכירות|שכר\\s+(?:ה)?דירה|monthly\\s+rent|rent"),
  TERM: term("תקופת\\s+(?:ה)?שכירות|תקופת\\s+(?:ה)?(?:חוזה|הסכם)|lease\\s+term"),
  SECURITY: term("ערבות\\s+בנקאית|ערבות|ערובה|ערובות|פיקדון|פקדון|בטוחה|בטוחות|שטר\\s+חוב|bank\\s+guarantee|deposit"),
  GUARANTOR: term("ערב(?:ים)?\\s+(?:אישי|אישיים|לחוזה|להבטחת|מטעם)|ערבים"),
  INDEXATION: term("צמוד(?:ים|ה|ות)?\\s+ל(?:מדד|דולר)|הצמדה|מדד\\s+(?:המחירים|הבסיס|הידוע)"),
  RENT_INCREASE: term("(?:העלאת|עליית|הגדלת|עדכון)\\s+(?:ה)?(?:דמי|שכר)|יעלו\\s+ב|יוגדלו\\s+ב"),
  OPTION: term("אופציה|האופציה|הארכת\\s+(?:ה)?(?:שכירות|חוזה|הסכם)|תקופה\\s+נוספת|תקופת\\s+ההארכה|התקופה\\s+הנוספת"),
  URGENT_REPAIR: term("ליקוי\\s+דחוף|ליקויים\\s+דחופים|תיקון\\s+דחוף|תקלה\\s+דחופה|ליקוי\\s+המונע\\s+מגורים"),
  // "תיקון" is also an amendment ("תיקון להסכם") or a cure ("תיקון ההפרה"), which are not repairs.
  REPAIRS: term("תיקון(?!\\s+(?:ל|ב)?(?:ה)?(?:חוזה|הסכם|הפרה))|תיקונים(?!\\s+(?:ל|ב)?(?:ה)?(?:חוזה|הסכם))|ליקוי|ליקויים|תקלה|תקלות|תחזוקה|אחזקה|יתקן|תתקן|יתוקן"),
  SELF_REPAIR: term("(?:תיקון|תיקונים|יתקן|תתקן)\\s+(?:עצמאי|בעצמו|בעצמה)|באופן\\s+עצמאי|בעל\\s+מקצוע|החזר\\s+(?:כספי|הוצאה|הוצאות)"),
  ENTRY: term("להיכנס\\s+לדירה|כניסת\\s+המשכיר|ייכנס\\s+לדירה|ביקור\\s+בדירה|ביקורת\\s+בדירה|להציג(?:ה)?\\s+(?:את\\s+הדירה\\s+)?ל"),
  EARLY_TERMINATION: term("(?:סיום|ביטול)\\s+מוקדם|(?:לבטל|יבטל)\\s+את\\s+(?:ה)?(?:חוזה|הסכם)|להביא\\s+את\\s+(?:ה)?(?:חוזה|הסכם)\\s+לסיום|יציאה\\s+מוקדמת"),
  REPLACEMENT_TENANT: term("שוכר\\s+(?:חלופי|מחליף|אחר\\s+במקומו)|העברת\\s+(?:ה)?שכירות"),
  BREACH: term("הפרה\\s+יסודית|הפרות\\s+יסודיות|הפרה|הפרת|יפר|תפר"),
  VACATING: term("פינוי|יפנה|תפנה|לפנות|תום\\s+(?:תקופת\\s+)?(?:ה)?שכירות|השבת\\s+החזקה|החזרת\\s+הדירה"),
  PENALTY: term("פיצוי\\s+מוסכם|פיצויים\\s+מוסכמים|קנס|ריבית\\s+פיגורים|דמי\\s+איחור|לכל\\s+יום\\s+(?:של\\s+)?איחור"),
  CHARGES: term("ארנונה|ועד\\s+(?:ה)?בית|מים|חשמל|גז|תשלומים\\s+(?:שוטפים|נוספים)|הוצאות\\s+מיוחדות|הוצאות\\s+(?:ה)?אחזקה"),
  INSURANCE: term("ביטוח"),
  HANDOVER: term("מצב\\s+הדירה|פרוטוקול\\s+מסירה|מסירת\\s+(?:ה)?(?:דירה|חזקה)|במצבה|כמות\\s+שהיא|רטיבות|ליקויים\\s+ידועים"),
  // The boilerplate "לא תיחשב ויתור" (not exercising a right is no waiver) is not a waiver.
  WAIVER: term("מוותר|מוותרת|(?<!לא\\s+[תיה]?[יי]?חשב\\s+(?:כ)?)ויתור|לא\\s+תהיה\\s+(?:לו|לה|לשוכר|לשוכרת)\\s+כל\\s+טענה"),
  PETS: term("בעל\\s+חיים|בעלי\\s+חיים|כלב|חתול|חיית\\s+מחמד|pets?"),
  SUBLET: term("שכירות\\s+משנה|להעביר\\s+את\\s+(?:ה)?חזקה"),
  SALE_TRANSFER: term("להעביר\\s+את\\s+(?:ה)?(?:בעלות|זכויותיו)|מכירת\\s+(?:ה)?דירה|הרוכש|רוכש\\s+פוטנציאלי"),
  ALTERATIONS: term("שינוי\\s+(?:או\\s+)?התקנה|שינויים\\s+בדירה|התקנה\\s+קבועה"),
};

const HEBREW_UNITS: Record<string, number> = {
  "אחד": 1, "אחת": 1, "שניים": 2, "שנים": 2, "שתיים": 2, "שתים": 2, "שני": 2, "שתי": 2,
  "שלושה": 3, "שלוש": 3, "שלושת": 3, "ארבעה": 4, "ארבע": 4, "ארבעת": 4, "חמישה": 5, "חמש": 5, "חמשת": 5,
  "שישה": 6, "שש": 6, "ששת": 6, "שבעה": 7, "שבע": 7, "שבעת": 7, "שמונה": 8, "שמונת": 8,
  "תשעה": 9, "תשע": 9, "תשעת": 9, "עשרה": 10, "עשר": 10, "עשרת": 10,
};
const HEBREW_TENS: Record<string, number> = {
  "עשרים": 20, "שלושים": 30, "ארבעים": 40, "חמישים": 50, "שישים": 60, "שבעים": 70, "שמונים": 80, "תשעים": 90,
};
const HEBREW_HUNDREDS: Record<string, number> = { "מאה": 100, "מאתיים": 200 };

const NUMBER_WORD = [...Object.keys(HEBREW_HUNDREDS), ...Object.keys(HEBREW_TENS), ...Object.keys(HEBREW_UNITS)]
  .sort((left, right) => right.length - left.length)
  .join("|");
// "שנים עשר", "ארבעים וחמישה", "מאה ועשרים", "שלושה" - one to a few number words in a row.
const NUMBER_WORDS = `(?:(?:${NUMBER_WORD})(?:\\s+ו?(?:${NUMBER_WORD})){0,2})`;

// Parses a run of Hebrew number words into its value, or null if it is not a number phrase.
export function hebrewNumber(phrase: string): number | null {
  const words = phrase.trim().split(/\s+/u).map((word) => word.replace(/^ו(?=.{2,})/u, ""));
  let total = 0;
  let seen = false;
  for (const word of words) {
    if (word in HEBREW_HUNDREDS) total += HEBREW_HUNDREDS[word]!;
    else if (word in HEBREW_TENS) total += HEBREW_TENS[word]!;
    else if (word === "עשר" || word === "עשרה") total += 10;
    else if (word in HEBREW_UNITS) total += HEBREW_UNITS[word]!;
    else return null;
    seen = true;
  }
  return seen ? total : null;
}

const NUMBER = `(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?`;
const MONEY = new RegExp(
  `(?:(?:ILS|₪)\\s*(${NUMBER})|(${NUMBER})\\s*(?:ש["״׳']?\\s?ח|₪|שקלים(?:\\s+חדשים)?|ILS|NIS))`,
  "giu",
);
// Digits may carry a one-letter prefix ("ב-30 יום"); number words must start a word.
const DURATION = new RegExp(
  `(?:(?<![\\d,.])(${NUMBER})|(?<![\\p{L}])(?:[ובלמכ])?(${NUMBER_WORDS}))\\s*(ימי\\s+עבודה|ימים|יום|שעות|שעה|שבועות|חודשים|חודש|שנים|שנה|days?|months?|years?|hours?|weeks?)`,
  "giu",
);
// Dual and singular forms that carry their own number.
const IMPLICIT_DURATION: Array<{ pattern: RegExp; value: number; unit: "days" | "months" }> = [
  { pattern: /(?<![\p{L}])(?:[ובלמכ])?יומיים(?![\p{L}])/gu, value: 2, unit: "days" },
  { pattern: /(?<![\p{L}])(?:[ובלמכ])?שבוע(?![\p{L}])/gu, value: 7, unit: "days" },
  { pattern: /(?<![\p{L}])(?:[ובלמכ])?שבועיים(?![\p{L}])/gu, value: 14, unit: "days" },
  { pattern: /לתקופה\s+של\s+שנה(?![\p{L}\s]*\d)|(?<![\p{L}])שנה\s+(?:אחת|שלמה)/gu, value: 12, unit: "months" },
];
const PERCENT = new RegExp(`(${NUMBER})\\s*(?:%|אחוז(?:ים)?|percent)`, "giu");

function numeric(text: string) {
  return Number(text.replace(/,/gu, ""));
}

function durationValue(match: RegExpExecArray): { value: number; unit: "days" | "months" } | null {
  const amount = match[1] ? numeric(match[1]) : hebrewNumber(match[2] ?? "");
  if (amount === null || !Number.isFinite(amount)) return null;
  const unit = match[3]!.toLowerCase();
  if (/^(?:שעות|שעה|hours?)$/u.test(unit)) return { value: amount / 24, unit: "days" };
  if (/^(?:שבועות|weeks?)$/u.test(unit)) return { value: amount * 7, unit: "days" };
  if (/^(?:חודשים|חודש|months?)$/u.test(unit)) return { value: amount, unit: "months" };
  if (/^(?:שנים|שנה|years?)$/u.test(unit)) return { value: amount * 12, unit: "months" };
  return { value: amount, unit: "days" };
}

// Line breaks in extracted PDF text are visual wraps, not sentence ends, so lines are joined first
// and the text is split on sentence punctuation only - never inside a number ("6,000", "9.2") or
// after a clause number ("9. בטוחות"). A clause's own heading line stays a sentence of its own, so its
// words do not attach to the first sentence of the body.
export function splitSentences(text: string, headingLine = false): string[] {
  const lines = text.split(/\n/u).map((line) => line.trim()).filter(Boolean);
  const heading = headingLine && lines.length > 1 ? [lines.shift()!] : [];
  const body = lines.join(" ")
    .split(/(?<=[^\d\s][.!?;])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 1);
  return [...heading, ...body];
}

function countMatches(pattern: RegExp, text: string) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

// "החודשיים" (monthly) has a double yod; "החודשים" (the months, as in "for the first three months")
// does not, and must not read as a monthly amount.
// "החודשיים" (monthly) has a double yod; "החודשים" (the months, as in "for the first three months")
// does not, and must not read as a monthly amount.
const MONTHLY_MARKER = /(?<![\p{L}])(?:ה)?חודשי(?:ים|ות|ת)?(?![\p{L}])|לחודש|בכל\s+חודש|monthly|per\s+month/iu;
const OPTION_MARKER = /אופציה|תקופה\s+נוספת|התקופה\s+הנוספת|תקופת\s+ההארכה|הארכת\s+(?:ה)?(?:שכירות|חוזה|הסכם)/u;
const PREPAYMENT_MARKER = /מראש|(?<![\p{L}])ל\S*\s+החודשים\s+הראשונים|עבור\s+(?:\d+|\S+)\s+חודשים|בעת\s+החתימה/u;
const SECURITY_RETURN = /(?:יוחזר(?:ו)?|תוחזר(?:נה)?|יושב(?:ו)?|תושב|השבת|החזרת|להחזיר)/u;

type NumberKind = "money" | "days" | "months" | "percent";
type FactTarget = FactKind | "RENT_BY_CONTEXT" | "SECURITY_RETURN_IF_STATED" | null;

// A number belongs to the subject named closest before it in the same sentence ("ערבות בנקאית בסך
// 30,000", "ליקוי דחוף ... בתוך שבעה ימים"). Each subject says what a number of each kind means for
// it; `null` means the number is about that subject but is not a fact we track (a notice period, a
// cure period, a cleaning fee), which keeps it from being attributed to an earlier subject.
// Repair verbs ("יתקן", "יתוקן") are deliberately not subjects: in "ליקוי דחוף ... יתוקן בתוך 7
// ימים" the subject is still the urgent defect.
const SUBJECTS: Array<{ pattern: RegExp; targets: Partial<Record<NumberKind, FactTarget>> }> = [
  { pattern: term("ערבות\\s+בנקאית|ערבות|ערובה|ערובות|פיקדון|פקדון|בטוחה|בטוחות|שטר\\s+חוב|bank\\s+guarantee|(?:cash\\s+|security\\s+)?deposit"), targets: { money: "SECURITY_AMOUNT", days: "SECURITY_RETURN_IF_STATED" } },
  { pattern: term("יוחזר(?:ו)?|תוחזר(?:נה)?|יושב(?:ו)?|השבת|החזרת"), targets: { days: "SECURITY_RETURN_IF_STATED" } },
  { pattern: term("דמי\\s+(?:ה)?שכירות(?:\\s+החודשיים)?|שכר\\s+(?:ה)?דירה|monthly\\s+rent|rent"), targets: { money: "RENT_BY_CONTEXT", months: null, percent: "RENT_INCREASE_PERCENT" } },
  { pattern: term("(?:העלאת|עליית|הגדלת|עדכון)\\s+(?:ה)?(?:דמי|שכר)|יעלו|יוגדלו"), targets: { percent: "RENT_INCREASE_PERCENT", money: null } },
  { pattern: term("תקופת\\s+(?:ה)?שכירות|תקופת\\s+(?:ה)?(?:חוזה|הסכם)|לתקופה\\s+של|lease\\s+term"), targets: { months: "LEASE_TERM_MONTHS", days: null } },
  { pattern: term("אופציה|האופציה|תקופה\\s+נוספת|התקופה\\s+הנוספת|תקופת\\s+ההארכה|הארכה"), targets: { money: "OPTION_RENT", months: null, percent: "RENT_INCREASE_PERCENT", days: null } },
  { pattern: term("ליקוי\\s+דחוף|ליקויים\\s+דחופים|תקלה\\s+דחופה|ליקוי\\s+המונע\\s+מגורים|urgent\\s+(?:defect|repair)"), targets: { days: "URGENT_REPAIR_DAYS", money: null } },
  { pattern: term("ליקוי|ליקויים|תקלה|תקלות|פגם|פגמים|defect|repair"), targets: { days: "REPAIR_DAYS", money: null } },
  // Subjects whose numbers are not tracked facts.
  { pattern: term("הודעה\\s+(?:מראש|מוקדמת|בכתב)|בהודעה\\s+של|התראה|notice"), targets: { days: null, months: null } },
  { pattern: term("איחור|באיחור|פיגור|late"), targets: { days: null, money: null, percent: null } },
  { pattern: term("הפרה|הפרות|הפרת|לתקן\\s+(?:את\\s+)?(?:ה)?הפרה|breach"), targets: { days: null } },
  { pattern: term("ניקיון|עמלה|עמלת|דמי\\s+תיווך|שכר\\s+טרחה|מחירו|עלות"), targets: { money: null } },
  { pattern: term("פיצוי\\s+מוסכם|פיצויים\\s+מוסכמים|קנס"), targets: { money: null, days: null } },
];

// `before` is the sentence up to the amount: "בתקופת האופציה דמי השכירות יהיו 7,500" names the option
// before the rent, and that amount is still the option-period rent.
function rentKind(sentence: string, between: string, before: string): FactKind {
  if (OPTION_MARKER.test(before)) return "OPTION_RENT";
  if (!MONTHLY_MARKER.test(between) && PREPAYMENT_MARKER.test(sentence) && !MONTHLY_MARKER.test(sentence)) return "PREPAID_RENT";
  if (PREPAYMENT_MARKER.test(between)) return "PREPAID_RENT";
  return "MONTHLY_RENT";
}

type SubjectMatch = { index: number; end: number; targets: Partial<Record<NumberKind, FactTarget>> };

function subjectsIn(sentence: string): SubjectMatch[] {
  return SUBJECTS.flatMap(({ pattern, targets }) => {
    pattern.lastIndex = 0;
    return [...sentence.matchAll(pattern)].map((match) => ({ index: match.index, end: match.index + match[0].length, targets }));
  });
}

// The closest subject before the number that says anything about this kind of number; failing
// that, the closest one after it ("6,000 ש״ח הם דמי השכירות"). Of two subjects starting at the
// same place, the longer and more specific one wins ("ליקוי דחוף" over "ליקוי").
function subjectFor(subjects: SubjectMatch[], kind: NumberKind, at: number): SubjectMatch | null {
  const relevant = subjects.filter((subject) => kind in subject.targets);
  const before = relevant.filter((subject) => subject.index < at)
    .sort((left, right) => right.index - left.index || right.end - left.end);
  if (before[0]) return before[0];
  return relevant.filter((subject) => subject.index > at)
    .sort((left, right) => left.index - right.index || right.end - left.end)[0] ?? null;
}

// Facts are read sentence by sentence and number by number, so one clause can say "another defect
// within 45 days" and "an urgent defect within 7 days", or state both the monthly rent and the
// option-period rent, without the numbers being confused.
function sentenceFacts(clauseId: string, sentence: string): ClauseFact[] {
  const facts: ClauseFact[] = [];
  const subjects = subjectsIn(sentence);
  const push = (kind: FactKind, value: number, unit: ClauseFact["unit"]) => {
    if (Number.isFinite(value) && value > 0) facts.push({ kind, value, unit, clauseId, sentence });
  };
  const resolve = (numberKind: NumberKind, at: number, value: number, unit: ClauseFact["unit"]) => {
    const subject = subjectFor(subjects, numberKind, at);
    const target = subject?.targets[numberKind];
    if (!subject || !target) return;
    if (target === "RENT_BY_CONTEXT") push(rentKind(sentence, sentence.slice(subject.index, at), sentence.slice(0, at)), value, unit);
    else if (target === "SECURITY_RETURN_IF_STATED") {
      if (SECURITY_RETURN.test(sentence)) push("SECURITY_RETURN_DAYS", value, unit);
    } else push(target, value, unit);
  };

  for (const match of sentence.matchAll(MONEY)) resolve("money", match.index, numeric(match[1] ?? match[2] ?? ""), "ILS");
  for (const match of sentence.matchAll(DURATION)) {
    const duration = durationValue(match);
    if (duration) resolve(duration.unit, match.index, duration.value, duration.unit);
  }
  for (const { pattern, value, unit } of IMPLICIT_DURATION) {
    for (const match of sentence.matchAll(pattern)) resolve(unit, match.index, value, unit);
  }
  for (const match of sentence.matchAll(PERCENT)) resolve("percent", match.index, numeric(match[1]!), "percent");
  return facts;
}

// "על אף האמור בסעיף 7", "בכפוף לסעיף 12", "כאמור בסעיפים 5 ו-9". A number followed by a Hebrew
// letter ("25י") or by "לחוק" points to a statute, not to this contract, and is skipped.
const SECTION_REFERENCE = /(?<![\p{L}])(?:[ובלמשכ]{1,2})?סעי(?:ף|פים|פי)\s+(\d+(?:\.\d+)*(?![\p{L}\d])(?:\s*(?:,|ו-?|-|עד)\s*\d+(?:\.\d+)*(?![\p{L}\d]))*)(?!\s*(?:\(?[א-ת]\)?\s*)?(?:ל|ב|של\s+)?(?:חוק|תקנות|פקודת))/gu;

function referenceKind(prefix: string): ReferenceKind {
  if (/(?:על\s+אף|למרות|חרף)\s+(?:(?:ה)?אמור\s+)?$/u.test(prefix)) return "NOTWITHSTANDING";
  if (/בכפוף\s*$/u.test(prefix)) return "SUBJECT_TO";
  return "REFERENCE";
}

function sentenceReferences(sentence: string, ownLabel?: string): ClauseReference[] {
  const references: ClauseReference[] = [];
  for (const match of sentence.matchAll(SECTION_REFERENCE)) {
    const kind = referenceKind(sentence.slice(Math.max(0, match.index - 25), match.index));
    for (const label of match[1]!.split(/\s*(?:,|ו-?|-|עד)\s*/u).filter(Boolean)) {
      if (label !== ownLabel) references.push({ kind, sectionLabel: label, sentence });
    }
  }
  return references;
}

export function mentionsConcept(text: string, concept: ConceptId) {
  return countMatches(CONCEPT_PATTERNS[concept], text) > 0;
}

export function profileClause(clause: ContractClause): ClauseProfile {
  const sentences = splitSentences(clause.text, Boolean(clause.heading));
  const concepts = new Map<ConceptId, number>();
  for (const [concept, pattern] of Object.entries(CONCEPT_PATTERNS) as Array<[ConceptId, RegExp]>) {
    const count = countMatches(pattern, clause.text);
    if (count) concepts.set(concept, count);
  }
  const headingConcepts = new Set<ConceptId>();
  if (clause.heading) {
    for (const [concept, pattern] of Object.entries(CONCEPT_PATTERNS) as Array<[ConceptId, RegExp]>) {
      if (countMatches(pattern, clause.heading)) headingConcepts.add(concept);
    }
  }
  const counts = [...concepts.values()];
  const strongest = Math.max(0, ...counts);
  const uniqueStrongest = counts.filter((count) => count === strongest).length === 1;
  const primaryConcepts = new Set<ConceptId>(
    [...concepts].filter(([concept, count]) => headingConcepts.has(concept) || count >= 2
      || (count === strongest && (uniqueStrongest || !headingConcepts.size)))
      .map(([concept]) => concept),
  );
  // Urgent repairs are a kind of repair; a clause about them is also about repairs generally.
  if (primaryConcepts.has("URGENT_REPAIR")) primaryConcepts.add("REPAIRS");

  return {
    clauseId: clause.id,
    ...(clause.sectionLabel ? { sectionLabel: clause.sectionLabel } : {}),
    concepts,
    primaryConcepts,
    headingConcepts,
    facts: sentences.flatMap((sentence) => sentenceFacts(clause.id, sentence)),
    references: sentences.flatMap((sentence) => sentenceReferences(sentence, clause.sectionLabel)),
    sentences,
  };
}

// The contract-wide values other clauses depend on (the security cap needs the monthly rent and the
// lease term, wherever in the contract they are defined). The first clause that defines a value wins,
// which is where contracts state them; option-period and prepaid amounts never count as the rent.
export type ContractFacts = Partial<Record<FactKind, ClauseFact>>;

export function deriveContractFacts(profiles: ClauseProfile[]): ContractFacts {
  const facts: ContractFacts = {};
  for (const profile of profiles) {
    for (const fact of profile.facts) facts[fact.kind] ??= fact;
  }
  return facts;
}
