import type { ContractClause, Protection } from "../../domain/models.js";

export type ProtectionChecklistItem = {
  protectionId: string;
  title: string;
  description: string;
  suggestedText: string;
  covered: RegExp;
  partial: RegExp;
  excluded?: RegExp;
};

export const PROTECTION_CHECKLIST: readonly ProtectionChecklistItem[] = [
  {
    protectionId: "RR-REC-EARLY-TERMINATION",
    title: "סיום מוקדם ושוכר חלופי",
    description: "מנגנון סביר לסיום מוקדם או להצעת שוכר חלופי ללא סירוב בלתי סביר.",
    suggestedText: "השוכר יהיה רשאי לסיים את השכירות מוקדם בהודעה מראש או להציע שוכר חלופי סביר, והמשכיר לא יסרב מטעמים בלתי סבירים.",
    // Requires the tenant's own right, not just any early-termination language: a clause that gives
    // only the landlord an early-exit right must not read as COVERED just because it mentions
    // "early termination" - it belongs in `partial` (topic addressed, protection incomplete).
    covered: /השוכר[^.\n]{0,60}(?:סיום|ביטול)\s+מוקדם|(?:סיום|ביטול)\s+מוקדם[^.\n]{0,60}השוכר|שוכר\s+חלופי|העברת\s+השכירות/u,
    partial: /(?:סיום|ביטול)\s+מוקדם|הודעה\s+מוקדמת|המחאת\s+זכויות/u,
  },
  {
    protectionId: "RR-REC-WEAR-AND-TEAR",
    title: "בלאי סביר",
    description: "הבחנה ברורה בין נזק שגרם השוכר לבין בלאי סביר או ליקוי שלא באחריותו.",
    suggestedText: "השוכר לא יישא בעלות בלאי סביר או ליקוי שלא נגרם עקב שימוש בלתי סביר שלו.",
    covered: /בלאי\s+סביר|ליקוי\s+שלא\s+נגרם|שימוש\s+בלתי\s+סביר/u,
    partial: /נזק\s+ש(?:נגרם|ייגרם)\s+על[־-]?ידי\s+השוכר/u,
  },
  {
    protectionId: "RR-REC-REPAIR-TIMELINE",
    title: "אחריות ומועדי תיקון",
    description: "חלוקת אחריות לתיקונים ומועד קצר ומוגדר לטיפול בליקוי דחוף.",
    suggestedText: "המשכיר יתקן ליקוי דחוף בתוך שלושה ימים וליקוי אחר בתוך זמן סביר, אלא אם הליקוי נגרם עקב שימוש בלתי סביר של השוכר.",
    covered: /(?:ליקוי|תיקון)\s+דחוף[^.\n]{0,80}(?:שלושה|3)\s+ימים/u,
    partial: /אחריות\s+ל(?:תיקונים|ליקויים)|(?:תיקון|ליקוי)\s+דחוף/u,
  },
  {
    protectionId: "RR-REC-SECURITY-RETURN",
    title: "השבת ערובה",
    description: "תנאים ברורים למימוש ולהשבת פיקדון, ערבות או ערובה לאחר סיום השכירות.",
    suggestedText: "הערובה תוחזר לשוכר בתוך המועד הקבוע בדין לאחר פינוי הדירה, בניכוי סכומים מוכחים שמותר למשכיר לממש.",
    covered: /(?:החזר|השבת|תוחזר)\s+(?:ה)?(?:ערובה|פיקדון|ערבות)/u,
    partial: /ערובה|פיקדון|ערבות\s+בנקאית/u,
  },
  {
    protectionId: "RR-REC-ENTRY-NOTICE",
    title: "פרטיות וכניסת המשכיר",
    description: "כניסת המשכיר לדירה רק לצורך סביר, בתיאום ובהודעה מראש למעט חירום.",
    suggestedText: "המשכיר ייכנס לדירה רק למטרה סבירה, לאחר תיאום והודעה מראש, למעט במקרה חירום.",
    covered: /(?:כניסת|כניסת\s+המשכיר|ייכנס)[^.\n]{0,100}(?:תיאום|הודעה)\s+מראש/u,
    partial: /כניסת\s+המשכיר|ביקור\s+בדירה/u,
    excluded: /אינו\s+(?:קובע|דורש)[^.\n]{0,40}(?:תיאום|הודעה)\s+מראש|ללא\s+(?:תיאום|הודעה)/u,
  },
  {
    protectionId: "RR-REC-CHARGES-ALLOCATION",
    title: "חלוקת תשלומים",
    description: "פירוט התשלומים השוטפים החלים על השוכר לעומת תשלומי בעלים החלים על המשכיר.",
    suggestedText: "החוזה יפרט בנפרד תשלומים שוטפים החלים על השוכר ותשלומים החלים על בעל הדירה לפי הדין.",
    covered: /ארנונה[^.\n]{0,150}(?:מים|חשמל|ועד\s+בית)|(?:מים|חשמל)[^.\n]{0,150}ארנונה/u,
    partial: /תשלומים\s+שוטפים|הוצאות\s+הדירה/u,
  },
  {
    protectionId: "RR-REC-HANDOVER-CONDITION",
    title: "מצב הדירה במסירה",
    description: "פרוטוקול מסירה או רשימת ציוד וליקויים כדי לצמצם מחלוקת בסיום התקופה.",
    suggestedText: "במועד המסירה ייחתם פרוטוקול הכולל את מצב הדירה, הציוד והליקויים הקיימים, ויצורפו תמונות מוסכמות.",
    covered: /פרוטוקול\s+מסירה|רשימת\s+ציוד|מצב\s+הדירה[^.\n]{0,80}(?:מסירה|תמונות|ליקויים)/u,
    partial: /מצב\s+הדירה|ציוד\s+בדירה/u,
  },
  {
    protectionId: "RR-REC-RENEWAL-TERMS",
    title: "חידוש ושינוי דמי שכירות",
    description: "תנאים ברורים לחידוש, מימוש אופציה ושינוי דמי השכירות בתקופה נוספת.",
    suggestedText: "תנאי הארכת השכירות, מועד מימוש האופציה ודמי השכירות בתקופה הנוספת ייקבעו מראש ובכתב.",
    covered: /(?:אופציה|הארכת\s+השכירות)[^.\n]{0,160}דמי\s+השכירות/u,
    partial: /אופציה|הארכת\s+השכירות|תקופה\s+נוספת/u,
  },
];

function matchingClauseIds(clauses: ContractClause[], pattern: RegExp, excluded?: RegExp) {
  return clauses
    .filter((clause) => pattern.test(clause.text) && !excluded?.test(clause.text))
    .map((clause) => clause.id);
}

export function evaluateProtectionChecklistDeterministically(clauses: ContractClause[]): Protection[] {
  return PROTECTION_CHECKLIST.map((item) => {
    const coveredClauseIds = matchingClauseIds(clauses, item.covered, item.excluded);
    const partialClauseIds = matchingClauseIds(clauses, item.partial);
    const status = coveredClauseIds.length ? "COVERED" : partialClauseIds.length ? "PARTIAL" : "MISSING";
    return {
      protectionId: item.protectionId,
      title: item.title,
      status,
      explanation: status === "COVERED"
        ? "החוזה כולל נוסח שעונה על ההגנה שנבדקה."
        : status === "PARTIAL"
          ? "הנושא מוזכר בחוזה, אך ההגנה אינה מלאה או ברורה."
          : `לא נמצאה בחוזה הגנה מספקת בנושא: ${item.description}`,
      relevantClauseIds: coveredClauseIds.length ? coveredClauseIds : partialClauseIds,
      legalReferences: [],
      ...(status === "COVERED" ? {} : { suggestedText: item.suggestedText }),
    };
  });
}

export function detectMissingProtections(clauses: ContractClause[]): Protection[] {
  return evaluateProtectionChecklistDeterministically(clauses)
    .filter((protection) => protection.status !== "COVERED");
}
