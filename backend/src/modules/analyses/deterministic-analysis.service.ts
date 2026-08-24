import type { ContractClause, TenantPreferences } from "../../domain/models.js";
import type { ProviderVerdict } from "./ai-providers.js";

function amountNear(text: string, phrase: RegExp) {
  const match = phrase.exec(text);
  if (!match) return null;
  const amount = /(?:בסך|הם|של|is|of)?\s*(?:ILS\s*)?([\d,.]+)\s*(?:ש["״']?ח|₪|ILS)?/iu.exec(match[0])?.[1];
  return amount ? Number(amount.replace(/[,.]/g, "")) : null;
}

function leaseMonths(text: string, fallback: number) {
  const numeric = /(?:תקופת\s+השכירות|לתקופה|lease\s+term)[^\n.]{0,80}?(\d{1,3})\s*(?:חודש|months?)/iu.exec(text)?.[1];
  if (numeric) return Number(numeric);
  if (/שנים\s+עשר\s+חודש/iu.test(text)) return 12;
  if (/שנה\s+(?:אחת|שלמה)/u.test(text)) return 12;
  return fallback;
}

function daysInClause(text: string) {
  const numeric = /(\d+)\s*(?:ימים|יום)/u.exec(text)?.[1];
  if (numeric) return Number(numeric);
  if (/שלושה\s+ימים/u.test(text)) return 3;
  if (/שבעה\s+ימים|שבוע/u.test(text)) return 7;
  return null;
}

export function deterministicVerdict(
  clause: ContractClause,
  fullText: string,
  preferences: TenantPreferences,
): ProviderVerdict {
  const assessment = { violatesLaw: false, riskWarning: false, preferenceConflict: false };
  const legalReferenceIds: string[] = [];
  let title = "סעיף תקין";
  let explanation = "לא זוהתה בסעיף זה הפרה, אזהרת סיכון או התנגשות עם העדפות השוכר.";

  const monthlyRent = amountNear(
    fullText,
    /(?:דמי\s+השכירות(?:\s+החודשיים)?|monthly\s+rent)[^\n.]{0,100}?(?:בסך|הם|של|is)?\s*(?:ILS\s*)?[\d,.]+\s*(?:ש["״']?ח|₪|ILS)?/iu,
  );
  const security = amountNear(
    clause.text,
    /(?:ערבות\s+בנקאית|פיקדון\s+כספי|ערובה|bank\s+guarantee|cash\s+deposit)[^\n.]{0,120}?(?:בסך|של|of)?\s*(?:ILS\s*)?[\d,.]+\s*(?:ש["״']?ח|₪|ILS)?/iu,
  );

  if (monthlyRent !== null && security !== null) {
    const months = leaseMonths(fullText, preferences.leaseLengthMonths);
    const cap = Math.min((monthlyRent * months) / 3, monthlyRent * 3);
    if (security > cap) {
      assessment.violatesLaw = true;
      legalReferenceIds.push("IL-RLL-25Y-SECURITY-CAP");
      title = "ערובה מעל התקרה החוקית";
      explanation = `הערובה בסך ${security.toLocaleString("he-IL")} ש״ח גבוהה מהתקרה המחושבת של ${cap.toLocaleString("he-IL")} ש״ח.`;
    }
  }

  if (!assessment.violatesLaw && /ליקוי\s+דחוף|תיקון\s+דחוף/u.test(clause.text)) {
    const days = daysInClause(clause.text);
    if (days !== null && days > 3) {
      assessment.violatesLaw = true;
      legalReferenceIds.push("IL-RLL-25Z-REPAIRS");
      title = "מועד תיקון ליקוי דחוף חורג מהדין";
      explanation = `הסעיף מאפשר ${days} ימים לתיקון ליקוי דחוף, מעבר למועד המרבי שבמאגר החוק.`;
    }
  }

  if (!assessment.violatesLaw && preferences.petsRequired && /(?:(?:אין|אסור)[^\n.]{0,50}(?:בעל\s+חיים|כלב|חתול)|(?:pets?|animals?)\s+(?:are\s+)?(?:not\s+allowed|prohibited))/iu.test(clause.text)) {
    assessment.preferenceConflict = true;
    title = "איסור בעלי חיים מתנגש עם ההעדפות";
    explanation = "החוזה אוסר החזקת בעל חיים, בעוד שבהעדפות השוכר נדרש היתר לבעל חיים.";
  }

  if (!assessment.violatesLaw && monthlyRent !== null && monthlyRent > preferences.maxMonthlyRentIls && /דמי\s+השכירות|monthly\s+rent/iu.test(clause.text)) {
    assessment.preferenceConflict = true;
    title = "דמי השכירות חורגים מהתקציב";
    explanation = `דמי השכירות החודשיים גבוהים מתקציב השוכר בסך ${preferences.maxMonthlyRentIls.toLocaleString("he-IL")} ש״ח.`;
  }

  if (!assessment.violatesLaw && preferences.furnishedRequired && /(?:אינה|ללא)\s+מרוהט/u.test(clause.text)) {
    assessment.preferenceConflict = true;
    title = "הדירה אינה מרוהטת";
    explanation = "הסעיף אינו תואם את דרישת השוכר לדירה מרוהטת.";
  }

  if (!assessment.violatesLaw && !preferences.acceptsGuarantorRequirement && /(?:ערב|ערבים)\s+(?:אישי|מטעם|להבטחת)/u.test(clause.text)) {
    assessment.preferenceConflict = true;
    title = "דרישת ערב אינה תואמת את ההעדפות";
    explanation = "החוזה דורש ערב, בעוד שהשוכר סימן שאינו מקבל דרישה זו.";
  }

  const increase = /(?:העלאת|עליית|הגדלת)\s+דמי\s+השכירות[^\n.]{0,80}?(\d+(?:\.\d+)?)\s*%/u.exec(clause.text)?.[1];
  if (!assessment.violatesLaw && increase && Number(increase) > preferences.maxAnnualRentIncreasePercent) {
    assessment.preferenceConflict = true;
    title = "שיעור העלאת השכירות גבוה מההעדפה";
    explanation = `החוזה מאפשר העלאה של ${increase}%, מעל התקרה האישית שהוגדרה.`;
  }

  if (!assessment.violatesLaw && /מוותר\s+(?:באופן\s+)?בלתי\s+חוזר\s+על\s+כל/u.test(clause.text)) {
    assessment.riskWarning = true;
    title = "ויתור זכויות רחב";
    explanation = "נוסח הוויתור רחב ועלול לפגוע בזכויות השוכר; מומלץ לבחון ולצמצם אותו.";
  }

  return { title, explanation, legalAssessment: assessment, legalReferenceIds };
}
