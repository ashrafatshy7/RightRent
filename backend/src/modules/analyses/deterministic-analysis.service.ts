import type { ConfidenceLevel, ContractClause, DeterministicCheck, FindingTopic, TenantPreferences } from "../../domain/models.js";
import type { ProviderVerdict } from "./ai-providers.js";

// Authoritative citation for each rule id a deterministic check can produce. Used both to attach a
// legal reference to a forced-RED finding (see toFinding in analysis.service.ts, which does not rely
// on RAG retrieval having happened to surface the same section) and by the non-anthropic fallback
// provider below.
export const DETERMINISTIC_RULE_LAW_INFO: Record<string, { lawName: string; section: string; sourceUrl: string }> = {
  "IL-RLL-25Y-SECURITY-CAP": {
    lawName: "חוק השכירות והשאילה, תשל״א–1971",
    section: "25י",
    sourceUrl: "https://main.knesset.gov.il/apps/legislation/main/laws/2000596",
  },
  "IL-RLL-25Z-REPAIRS": {
    lawName: "חוק השכירות והשאילה, תשל״א–1971",
    section: "25ז",
    sourceUrl: "https://main.knesset.gov.il/apps/legislation/main/laws/2000596",
  },
};

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

function securityReturnDays(text: string) {
  // The `{0,N}?` gaps are lazy, matching as few characters as possible: with a greedy `{0,N}`,
  // `[^.\n]` also matches digits, so it would swallow the leading digits of a multi-digit number
  // before backtracking, and (\d+) would only capture the number's last digit or two.
  const numeric = /(?:פיקדון|ערבות|ערובה)[^.\n]{0,60}?(?:יוחזר(?:ו)?|תוחזר|יושב(?:ו)?)[^.\n]{0,40}?(\d+)\s*(?:ימים|יום)/u
    .exec(text)?.[1];
  return numeric ? Number(numeric) : null;
}

const MENTIONS_GUARANTEE_REALIZATION = /(?:לממש|מימוש|לחלט|חילוט)[^.\n]{0,50}(?:ערבות|ערובה|פיקדון)/u;
const MENTIONS_NO_NOTICE = /ללא[^.\n]{0,15}(?:הודעה|התראה)/u;
const MENTIONS_ENTRY = /(?:להיכנס|כניסת\s+המשכיר|ייכנס|רשאי\s+להיכנס)[^.\n]{0,40}לדירה/u;
const MENTIONS_NO_COORDINATION = /ללא[^.\n]{0,15}(?:תיאום|הודעה)/u;
const MENTIONS_OWNER_SIDE_CHARGES = /(?:ביטוח\s+(?:ה)?מבנה|הוצאות\s+מיוחדות)[^.\n]{0,60}(?:השוכר)/u;
const MENTIONS_NO_REIMBURSEMENT = /לא\s+(?:יהיה|תהיה)\s+זכאי[^.\n]{0,20}(?:החזר|פיצוי)/u;
const MENTIONS_SELF_REPAIR = /תיקון[^.\n]{0,30}(?:עצמאי|בעצמו|באופן\s+עצמאי)|(?:ביצע|שביצע)[^.\n]{0,20}(?:תיקון|תיקונים)/u;
const SECURITY_RETURN_MAX_REASONABLE_DAYS = 60;

// Legally defined numeric limits, computed in code rather than left for a language model to work
// out (section 12 of the brief). Shared by both analysis providers: the offline fallback below
// bakes these straight into its verdict, and the Claude-backed pipeline (analysis.service.ts) both
// feeds these to the model as ground truth and forces a RED verdict when one fails, regardless of
// what the model concludes.
export function computeDeterministicChecks(
  clause: ContractClause,
  fullText: string,
  preferences: TenantPreferences,
): DeterministicCheck[] {
  const checks: DeterministicCheck[] = [];

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
    checks.push({
      ruleId: "IL-RLL-25Y-SECURITY-CAP",
      label: "תקרת הערובה המותרת",
      legalReferenceId: "IL-RLL-25Y-SECURITY-CAP",
      contractValue: security,
      legalLimit: cap,
      calculatedLimit: cap,
      difference: security - cap,
      unit: "ILS",
      passesRule: security <= cap,
    });
  }

  if (/ליקוי\s+דחוף|תיקון\s+דחוף/u.test(clause.text)) {
    const days = daysInClause(clause.text);
    if (days !== null) {
      checks.push({
        ruleId: "IL-RLL-25Z-REPAIRS",
        label: "מועד מרבי לתיקון ליקוי דחוף",
        legalReferenceId: "IL-RLL-25Z-REPAIRS",
        contractValue: days,
        legalLimit: 3,
        calculatedLimit: 3,
        difference: days - 3,
        unit: "days",
        passesRule: days <= 3,
      });
    }
  }

  return checks;
}

type HeuristicVerdictFields = {
  title: string;
  explanation: string;
  plainLanguageExplanation: string;
  whyItMatters: string;
  recommendedAction?: string;
  suggestedReplacementText?: string;
  topic: FindingTopic;
  confidence: ConfidenceLevel;
};

const NO_ISSUE_FOUND: HeuristicVerdictFields = {
  title: "סעיף תקין",
  explanation: "לא זוהתה בסעיף זה הפרה, אזהרת סיכון או התנגשות עם העדפות השוכר.",
  plainLanguageExplanation: "לא זיהינו בסעיף הזה בעיה משפטית, סיכון משמעותי או התנגשות עם ההעדפות שהגדרתם.",
  whyItMatters: "זו בדיקה אוטומטית ראשונית בלבד ואינה תחליף לבדיקה משפטית מלאה של החוזה.",
  topic: "other",
  confidence: "medium",
};

// The offline fallback provider (env.analysisProvider !== "anthropic"): cheap, dependency-free, and
// used by tests and local development without an API key. It reuses computeDeterministicChecks for
// its two numeric legal-limit rules, then applies a chain of text-pattern heuristics for everything
// else. Only the last matching heuristic's copy is shown when several match the same clause -
// acceptable here because this provider exists for testability, not as the production analyzer.
export function deterministicVerdict(
  clause: ContractClause,
  fullText: string,
  preferences: TenantPreferences,
): ProviderVerdict {
  const assessment = { violatesLaw: false, riskWarning: false, preferenceConflict: false };
  const legalReferenceIds: string[] = [];
  let fields: HeuristicVerdictFields = NO_ISSUE_FOUND;

  const checks = computeDeterministicChecks(clause, fullText, preferences);
  const failedCheck = checks.find((check) => !check.passesRule);
  if (failedCheck) {
    assessment.violatesLaw = true;
    legalReferenceIds.push(failedCheck.legalReferenceId);
    fields = failedCheck.ruleId === "IL-RLL-25Y-SECURITY-CAP"
      ? {
        title: "ערובה מעל התקרה החוקית",
        explanation: `הערובה בסך ${failedCheck.contractValue.toLocaleString("he-IL")} ש״ח גבוהה מהתקרה המחושבת של ${failedCheck.calculatedLimit.toLocaleString("he-IL")} ש״ח.`,
        plainLanguageExplanation: `הבקשה לערובה בסך ${failedCheck.contractValue.toLocaleString("he-IL")} ש״ח גבוהה מהסכום המרבי שמותר לדרוש מכם בחוזה שכירות כזה.`,
        whyItMatters: "החוק קובע תקרה לגובה הערובה שמשכיר רשאי לדרוש, כדי להגן על השוכר מפני נטל כספי מוגזם בתחילת השכירות.",
        recommendedAction: `בקשו מהמשכיר להפחית את סכום הערובה ל-${failedCheck.calculatedLimit.toLocaleString("he-IL")} ש״ח או פחות, בהתאם לתקרה החוקית.`,
        suggestedReplacementText: `להבטחת התחייבויות השוכר ימסור השוכר למשכיר ערבות בנקאית בסך שלא יעלה על ${failedCheck.calculatedLimit.toLocaleString("he-IL")} ש״ח.`,
        topic: "guarantee_security",
        confidence: "high",
      }
      : {
        title: "מועד תיקון ליקוי דחוף חורג מהדין",
        explanation: `הסעיף מאפשר ${failedCheck.contractValue} ימים לתיקון ליקוי דחוף, מעבר למועד המרבי שבמאגר החוק.`,
        plainLanguageExplanation: `הסעיף נותן למשכיר ${failedCheck.contractValue} ימים לתקן ליקוי דחוף, יותר משלושת הימים שהחוק קובע כמועד המרבי.`,
        whyItMatters: "ליקוי דחוף עלול לפגוע בשימוש הסביר בדירה, ולכן החוק קובע מועד תיקון קצר במיוחד.",
        recommendedAction: "בקשו לשנות את הסעיף כך שהמשכיר יתחייב לתקן ליקוי דחוף תוך שלושה ימים, כפי שהחוק קובע.",
        suggestedReplacementText: "המשכיר יתקן ליקוי דחוף המונע מגורים סבירים בדירה בתוך שלושה ימים ממועד קבלת הודעת השוכר.",
        topic: "repairs_maintenance",
        confidence: "high",
      };
  }

  const monthlyRent = amountNear(
    fullText,
    /(?:דמי\s+השכירות(?:\s+החודשיים)?|monthly\s+rent)[^\n.]{0,100}?(?:בסך|הם|של|is)?\s*(?:ILS\s*)?[\d,.]+\s*(?:ש["״']?ח|₪|ILS)?/iu,
  );

  if (!assessment.violatesLaw && preferences.petsRequired && /(?:(?:אין|אסור)[^\n.]{0,50}(?:בעל\s+חיים|כלב|חתול)|(?:pets?|animals?)\s+(?:are\s+)?(?:not\s+allowed|prohibited))/iu.test(clause.text)) {
    assessment.preferenceConflict = true;
    fields = {
      title: "איסור בעלי חיים מתנגש עם ההעדפות",
      explanation: "החוזה אוסר החזקת בעל חיים, בעוד שבהעדפות השוכר נדרש היתר לבעל חיים.",
      plainLanguageExplanation: "החוזה אוסר להחזיק בעל חיים, וזה מתנגש עם מה שציינתם שחשוב לכם.",
      whyItMatters: "זו לא בעיה משפטית, אלא אי-התאמה לצרכים שהגדרתם מראש.",
      recommendedAction: "בררו עם המשכיר אם ניתן לקבל אישור להחזקת בעל חיים, ובקשו לעגן זאת בכתב בחוזה.",
      topic: "pets_and_use",
      confidence: "high",
    };
  }

  if (!assessment.violatesLaw && monthlyRent !== null && monthlyRent > preferences.maxMonthlyRentIls && /דמי\s+השכירות|monthly\s+rent/iu.test(clause.text)) {
    assessment.preferenceConflict = true;
    fields = {
      title: "דמי השכירות חורגים מהתקציב",
      explanation: `דמי השכירות החודשיים גבוהים מתקציב השוכר בסך ${preferences.maxMonthlyRentIls.toLocaleString("he-IL")} ש״ח.`,
      plainLanguageExplanation: "דמי השכירות החודשיים גבוהים מהתקציב שהגדרתם.",
      whyItMatters: "זו התאמה לתקציב שלכם, לא בעיה בחוזה עצמו.",
      recommendedAction: "בדקו אם דמי השכירות ניתנים למשא ומתן, או עדכנו את התקציב שהגדרתם אם הוא כבר לא רלוונטי.",
      topic: "rent_and_term",
      confidence: "high",
    };
  }

  if (!assessment.violatesLaw && preferences.furnishedRequired && /(?:אינה|ללא)\s+מרוהט/u.test(clause.text)) {
    assessment.preferenceConflict = true;
    fields = {
      title: "הדירה אינה מרוהטת",
      explanation: "הסעיף אינו תואם את דרישת השוכר לדירה מרוהטת.",
      plainLanguageExplanation: "הדירה אינה מרוהטת, בעוד שציינתם שאתם צריכים דירה מרוהטת.",
      whyItMatters: "זו התאמה לצרכים שהגדרתם, לא בעיה משפטית.",
      recommendedAction: "בררו עם המשכיר על אפשרות לריהוט הדירה, או עדכנו את ההעדפות שלכם אם הדבר אינו קריטי.",
      topic: "handover_condition",
      confidence: "high",
    };
  }

  if (!assessment.violatesLaw && !preferences.acceptsGuarantorRequirement && /(?:ערב|ערבים)\s+(?:אישי|מטעם|להבטחת)/u.test(clause.text)) {
    assessment.preferenceConflict = true;
    fields = {
      title: "דרישת ערב אינה תואמת את ההעדפות",
      explanation: "החוזה דורש ערב, בעוד שהשוכר סימן שאינו מקבל דרישה זו.",
      plainLanguageExplanation: "החוזה דורש ערב אישי, וציינתם שאינכם מעוניינים בדרישה כזו.",
      whyItMatters: "זו התאמה להעדפותיכם, לא בעיה משפטית.",
      recommendedAction: "בררו עם המשכיר אם ניתן לוותר על דרישת הערב או להחליפה בבטוחה אחרת שנוחה לכם יותר.",
      topic: "guarantee_security",
      confidence: "high",
    };
  }

  const increase = /(?:העלאת|עליית|הגדלת)\s+דמי\s+השכירות[^\n.]{0,80}?(\d+(?:\.\d+)?)\s*%/u.exec(clause.text)?.[1];
  if (!assessment.violatesLaw && increase && Number(increase) > preferences.maxAnnualRentIncreasePercent) {
    assessment.preferenceConflict = true;
    fields = {
      title: "שיעור העלאת השכירות גבוה מההעדפה",
      explanation: `החוזה מאפשר העלאה של ${increase}%, מעל התקרה האישית שהוגדרה.`,
      plainLanguageExplanation: `החוזה מאפשר למשכיר להעלות את דמי השכירות ב-${increase}%, יותר מהתקרה שהגדרתם לעצמכם.`,
      whyItMatters: "זו התאמה להעדפותיכם האישיות, לא בעיה משפטית.",
      recommendedAction: "בקשו להגביל את שיעור העלאת דמי השכירות בהתאם למה שנוח לכם.",
      topic: "rent_and_term",
      confidence: "high",
    };
  }

  if (!assessment.violatesLaw && /מוותר\s+(?:באופן\s+)?בלתי\s+חוזר\s+על\s+כל/u.test(clause.text)) {
    assessment.riskWarning = true;
    fields = {
      title: "ויתור זכויות רחב",
      explanation: "נוסח הוויתור רחב ועלול לפגוע בזכויות השוכר; מומלץ לבחון ולצמצם אותו.",
      plainLanguageExplanation: "אתם מוותרים מראש על כל טענה הנוגעת למצב הדירה, כולל ליקויים שעוד לא התגלו.",
      whyItMatters: "ויתור כה רחב עלול למנוע מכם לדרוש תיקון או פיצוי גם על ליקויים משמעותיים שיתגלו בהמשך.",
      recommendedAction: "בקשו לצמצם את הוויתור כך שיחול רק על ליקויים ידועים וגלויים שתועדו במפורש, ולא על ליקויים נסתרים.",
      suggestedReplacementText: "השוכר מאשר את מצב הדירה כפי שתועד בפרוטוקול המסירה, ואינו מוותר על זכותו לדרוש תיקון ליקויים נסתרים שיתגלו בהמשך.",
      topic: "waiver_liability",
      confidence: "medium",
    };
  }

  if (!assessment.violatesLaw && MENTIONS_GUARANTEE_REALIZATION.test(clause.text) && MENTIONS_NO_NOTICE.test(clause.text)) {
    assessment.riskWarning = true;
    fields = {
      title: "המשכיר יכול לממש את הערבות שלכם בלי להתרות בכם",
      explanation: "הסעיף מתיר מימוש הערבות ללא הודעה מוקדמת או הזדמנות לתיקון.",
      plainLanguageExplanation: "הסעיף מאפשר למשכיר לחלט את הערבות הבנקאית באופן מיידי, בלי לתת לכם הודעה מראש או הזדמנות לתקן את מה שגרם לחילוט.",
      whyItMatters: "בלי הודעה מראש אתם עלולים לגלות שהערבות מומשה רק בדיעבד, ולא לקבל הזדמנות הוגנת לברר או לתקן את הבעיה.",
      recommendedAction: "בקשו שהמימוש יותנה בהודעה מראש ובזמן סביר לתיקון, אלא אם מדובר במקרה חירום מוצדק.",
      suggestedReplacementText: "המשכיר רשאי לממש את הערבות הבנקאית רק לאחר מתן הודעה בכתב לשוכר ומתן שהות סבירה לתיקון, למעט במקרה חירום.",
      topic: "guarantee_security",
      confidence: "medium",
    };
  }

  if (!assessment.violatesLaw && MENTIONS_ENTRY.test(clause.text) && MENTIONS_NO_COORDINATION.test(clause.text)) {
    assessment.riskWarning = true;
    fields = {
      title: "המשכיר יכול להיכנס לדירה בלי לתאם איתכם",
      explanation: "הסעיף מתיר כניסת המשכיר לדירה ללא תיאום או הודעה מראש.",
      plainLanguageExplanation: "הסעיף מאפשר למשכיר להיכנס לדירה בלי לתאם מראש ובלי להודיע לכם.",
      whyItMatters: "זו פגיעה בפרטיות שלכם בדירה שאתם גרים בה, גם אם המשכיר הוא בעל הנכס.",
      recommendedAction: "בקשו לקבוע שהכניסה לדירה תהיה רק בתיאום ובהודעה מראש, למעט מקרי חירום.",
      suggestedReplacementText: "המשכיר ייכנס לדירה רק לאחר תיאום והודעה מראש בזמן סביר, למעט במקרה חירום המצריך כניסה מיידית.",
      topic: "entry_privacy",
      confidence: "medium",
    };
  }

  if (!assessment.violatesLaw && MENTIONS_OWNER_SIDE_CHARGES.test(clause.text)) {
    assessment.riskWarning = true;
    fields = {
      title: "אתם נדרשים לשלם הוצאות שבדרך כלל חלות על בעל הדירה",
      explanation: "הסעיף מטיל על השוכר ביטוח מבנה ו/או הוצאות מיוחדות של הבניין, שאינן תשלומים שוטפים רגילים.",
      plainLanguageExplanation: "בנוסף לתשלומים השוטפים הרגילים, הסעיף מטיל עליכם גם את ביטוח המבנה ו/או הוצאות מיוחדות של הבניין.",
      whyItMatters: "הוצאות אלו קשורות לבעלות על הנכס ולא לשימוש השוטף בו, ולכן בדרך כלל נהוג שהן חלות על בעל הדירה.",
      recommendedAction: "בררו עם המשכיר מדוע הוצאות אלו הועברו אליכם, ובקשו שהן יחולו על בעל הדירה כמקובל.",
      topic: "charges_payments",
      confidence: "medium",
    };
  }

  const returnDays = securityReturnDays(clause.text);
  if (!assessment.violatesLaw && returnDays !== null && returnDays > SECURITY_RETURN_MAX_REASONABLE_DAYS) {
    assessment.riskWarning = true;
    fields = {
      title: "ייקח זמן רב מדי עד שתקבלו בחזרה את הפיקדון או הערבות",
      explanation: `הערובה תוחזר רק כעבור ${returnDays} ימים מסיום השכירות, פרק זמן ארוך מהמקובל.`,
      plainLanguageExplanation: `לפי הסעיף, הערובה תוחזר רק כעבור ${returnDays} ימים מסיום השכירות.`,
      whyItMatters: "פרק זמן ארוך כזה משאיר את הכסף שלכם אצל המשכיר הרבה אחרי שכבר עזבתם את הדירה.",
      recommendedAction: "בקשו לקצר את מועד השבת הערובה לפרק זמן סביר, לרוב עד 30 יום מיום פינוי הדירה.",
      suggestedReplacementText: "הערובה תוחזר לשוכר בתוך 30 יום מיום פינוי הדירה, בניכוי סכומים מוכחים שהמשכיר רשאי לנכות.",
      topic: "guarantee_security",
      confidence: "medium",
    };
  }

  if (!assessment.violatesLaw && MENTIONS_NO_REIMBURSEMENT.test(clause.text) && MENTIONS_SELF_REPAIR.test(clause.text)) {
    assessment.riskWarning = true;
    fields = {
      title: "לא תקבלו החזר אם תתקנו בעצמכם תקלה דחופה",
      explanation: "הסעיף שולל החזר כספי לשוכר שתיקן ליקוי בעצמו, גם אם המשכיר לא טיפל בזמן סביר.",
      plainLanguageExplanation: "הסעיף קובע שלא תהיו זכאים להחזר כספי אם תתקנו בעצמכם ליקוי דחוף, גם אם המשכיר לא הגיב בזמן סביר.",
      whyItMatters: "אם למשכיר לוקח יותר מדי זמן לטפל בליקוי דחוף, ייתכן שתצטרכו לתקן בעצמכם כדי להמשיך לגור בדירה בצורה סבירה - וסעיף כזה מונע מכם לקבל את ההוצאה בחזרה.",
      recommendedAction: "בקשו סעיף שמאפשר לכם לתקן ליקוי דחוף בעצמכם ולקבל החזר, אם המשכיר לא טיפל בו תוך זמן סביר שקבעתם מראש.",
      suggestedReplacementText: "לא טיפל המשכיר בליקוי דחוף תוך זמן סביר לאחר קבלת הודעה, רשאי השוכר לתקנו בעצמו ולקבל החזר בגין הוצאות סבירות שהוציא.",
      topic: "repairs_maintenance",
      confidence: "medium",
    };
  }

  return { ...fields, clauseQuote: clause.text, legalAssessment: assessment, legalReferenceIds };
}
