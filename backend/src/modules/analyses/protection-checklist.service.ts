import type { ContractClause, Protection } from "../../domain/models.js";

export function detectMissingProtections(clauses: ContractClause[]): Protection[] {
  const text = clauses.map((clause) => clause.text).join("\n");
  const protections: Protection[] = [];

  if (!/(?:סיום|ביטול)\s+מוקדם|שוכר\s+חלופי|העברת\s+השכירות/u.test(text)) {
    protections.push({
      protectionId: "RR-REC-EARLY-TERMINATION",
      status: "MISSING",
      explanation: "לא נמצא מנגנון ברור לסיום מוקדם או למציאת שוכר חלופי.",
      suggestedText: "השוכר יהיה רשאי לסיים את השכירות מוקדם בהודעה מראש או להציע שוכר חלופי סביר, והמשכיר לא יסרב מטעמים בלתי סבירים.",
    });
  }

  if (!/בלאי\s+סביר|שימוש\s+בלתי\s+סביר|ליקוי\s+שלא\s+נגרם/u.test(text)) {
    protections.push({
      protectionId: "RR-REC-WEAR-AND-TEAR",
      status: "MISSING",
      explanation: "לא נמצאה הגנה מפורשת מפני חיוב השוכר בגין בלאי סביר.",
      suggestedText: "השוכר לא יישא בעלות בלאי סביר או ליקוי שלא נגרם עקב שימוש בלתי סביר שלו.",
    });
  }

  return protections;
}
