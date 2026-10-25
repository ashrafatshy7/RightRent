import type { ContractClause, Finding, FinancialTerms } from "../../domain/models.js";

// A clause can leave a blank for a value the contract states elsewhere: the rent left out of the
// rent clause but written in the payment schedule, or a value typed into a form that extraction
// could not put back in place. A finding whose headline is that such a value is missing is wrong
// about the contract. It is turned into an informational note that says where the value is stated,
// so a filled-in term never shows up as a critical gap. A failed deterministic check is never
// softened this way.

const BLANK = /_{3,}/gu;
const CONTEXT_BEFORE = 80;
const CONTEXT_AFTER = 40;

const CLAIMS_MISSING =
  /(?<!\p{L})(?:לא\s+(?:מולא|מולאה|מולאו|הוגדר|הוגדרה|מוגדר|מוגדרת|מוגדרים|צוין|צוינה|צוינו|נקבע|נקבעה|מופיע|מופיעה|מופיעים|ברור|ברורה|ברורים)|אינ(?:ו|ה|ם|ן)\s+(?:מוגדר|מוגדרת|מוגדרים|ברור|ברורה|ברורים|מופיע|מופיעה|מופיעים)|חסר|חסרה|חסרים|חסרות|ריק|ריקה|ריקים|ריקות)(?!\p{L})/u;

type Field = "TERM" | "START" | "END" | "RENT" | "LATE_VACATING";

const RENT_CONTEXT = /(?:דמי\s+(?:ה)?שכירות|שכר\s+(?:ה)?דירה)[^.]*$/u;
const AMOUNT_BEFORE = /(?:₪|ש["״]ח|סך\s+של|סכום\s+של|השווה\s+ל)[\s(\-]*$/u;
const AMOUNT_AFTER = /^\s*(?:₪|ש["״]ח|שקלים)/u;

// What a blank stands for, read from the words right around it. A blank this cannot place (an ID
// number, an address, the signing date) keeps the finding as it is.
function blankField(before: string, after: string): Field | null {
  if (/^[^.]{0,30}(?:יום\s+של\s+איחור|ליום\s+איחור)/u.test(after)) return "LATE_VACATING";
  if (/^\s*חודשים/u.test(after)) return "TERM";
  if (/(?:^|\s)(?:החל\s+)?מיום\s*$/u.test(before)) return "START";
  if (/(?:עד\s+ליום|עד\s+יום|וכלה\s+ביום)\s*$/u.test(before)) return "END";
  if (RENT_CONTEXT.test(before) && (AMOUNT_BEFORE.test(before) || AMOUNT_AFTER.test(after))) return "RENT";
  return null;
}

function displayDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return year && month && day ? `${day}.${month}.${year}` : isoDate;
}

function where(clauseId: string, clauses: ContractClause[]) {
  const label = clauses.find((clause) => clause.id === clauseId)?.sectionLabel;
  return label ? ` (סעיף ${label})` : "";
}

// The contract's own statement of a field, or null when the contract does not state it verifiably.
function statedValue(field: Field, terms: FinancialTerms, clauses: ContractClause[]): string | null {
  const term = terms.leaseTermMonths?.verified ? terms.leaseTermMonths : null;
  const start = terms.leaseStart?.verified ? terms.leaseStart : null;

  switch (field) {
    case "TERM":
      return term ? `תקופת שכירות של ${term.value} חודשים${where(term.clauseId, clauses)}` : null;
    case "START":
      return start ? `תחילת השכירות ב-${displayDate(start.value)}${where(start.clauseId, clauses)}` : null;
    case "END":
      return term && start
        ? `${term.value} חודשים מ-${displayDate(start.value)}${where(term.clauseId, clauses)}`
        : null;
    case "RENT": {
      const rent = terms.monthlyRent?.verified ? terms.monthlyRent : null;
      return rent ? `דמי שכירות של ${rent.value.toLocaleString("en-US")} ₪ לחודש${where(rent.clauseId, clauses)}` : null;
    }
    case "LATE_VACATING": {
      const late = terms.lateVacating;
      return late?.verified && late.perDay !== null
        ? `${late.perDay.toLocaleString("en-US")} ₪ לכל יום איחור בפינוי${where(late.clauseId, clauses)}`
        : null;
    }
  }
}

// The values a clause's blanks stand for, when the contract states every one of them; null when
// the clause has no blank or a blank the contract leaves open.
function valuesStatedElsewhere(clause: ContractClause, terms: FinancialTerms, clauses: ContractClause[]) {
  const statements: string[] = [];

  for (const match of clause.text.matchAll(BLANK)) {
    const start = match.index;
    const end = start + match[0].length;
    const field = blankField(
      clause.text.slice(Math.max(0, start - CONTEXT_BEFORE), start),
      clause.text.slice(end, end + CONTEXT_AFTER),
    );
    const statement = field ? statedValue(field, terms, clauses) : null;

    if (!statement) return null;
    if (!statements.includes(statement)) statements.push(statement);
  }

  return statements.length ? statements : null;
}

export function reconcileBlankFieldFindings(
  findings: Finding[],
  clauses: ContractClause[],
  terms: FinancialTerms,
): Finding[] {
  return findings.map((finding) => {
    if (finding.severity === "OK") return finding;
    if (finding.deterministicChecks?.some((check) => !check.passesRule)) return finding;
    if (!CLAIMS_MISSING.test(finding.title)) return finding;

    const clause = clauses.find((candidate) => candidate.id === finding.clauseId);
    const statements = clause ? valuesStatedElsewhere(clause, terms, clauses) : null;
    if (!statements) return finding;

    const stated = `בסעיף הזה נשארה משבצת ריקה, אבל החוזה קובע את הערך: ${statements.join("; ")}.`;
    const { suggestedReplacementText: _replacement, ...rest } = finding;

    return {
      ...rest,
      severity: "OK",
      category: "informational",
      confidence: "high",
      title: "משבצת ריקה לערך שמופיע בחוזה",
      plainLanguageExplanation: stated,
      whyItMatters: "משבצת שנשארה ריקה בחוזה חתום אפשר להשלים אחר כך אחרת ממה שסוכם.",
      recommendedAction: "לפני החתימה, מלאו גם את המשבצת הזו באותו ערך, או מחקו אותה בקו.",
      explanation: stated,
      legalAssessment: { violatesLaw: false, riskWarning: false, preferenceConflict: false },
      legalReferences: [],
    };
  });
}
