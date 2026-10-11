import type {
  AcceptedSecurityKind,
  ConfidenceLevel,
  ContractClause,
  DeterministicCheck,
  FindingTopic,
  TenantPreferences,
} from "../../domain/models.js";
import type { ProviderVerdict } from "./ai-providers.js";
import { durationsIn, mentionsConcept, type ClauseFact, type ClauseProfile, type ContractFacts } from "./clause-facts.service.js";
import type { ClauseLink } from "./clause-linking.service.js";
import { earlyExitTerms, SECURITY_KINDS, TENANT_PAYS } from "./financial-terms.service.js";

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

const URGENT_REPAIR_LIMIT_DAYS = 3;

const MENTIONS_GUARANTEE_REALIZATION = /(?:לממש|מימוש|לחלט|חילוט)[^.\n]{0,50}(?:ערבות|ערובה|פיקדון)/u;
const MENTIONS_NO_NOTICE = /ללא[^.\n]{0,15}(?:הודעה|התראה)/u;
const MENTIONS_ENTRY = /(?:להיכנס|כניסת\s+המשכיר|ייכנס|רשאי\s+להיכנס)[^.\n]{0,40}לדירה/u;
const MENTIONS_NO_COORDINATION = /ללא[^.\n]{0,15}(?:תיאום|הודעה)/u;
const MENTIONS_OWNER_SIDE_CHARGES = /(?:ביטוח\s+(?:ה)?מבנה|הוצאות\s+מיוחדות)[^.\n]{0,60}(?:השוכר)/u;
const MENTIONS_NO_REIMBURSEMENT = /לא\s+(?:יהיה|תהיה)\s+זכאי[^.\n]{0,20}(?:החזר|פיצוי)/u;
const MENTIONS_SELF_REPAIR = /תיקון[^.\n]{0,30}(?:עצמאי|בעצמו|באופן\s+עצמאי)|(?:ביצע|שביצע)[^.\n]{0,20}(?:תיקון|תיקונים)/u;
// Language that moves a cost or a risk onto the tenant, used to tell a "notwithstanding section X"
// clause that takes a protection away from one that merely adjusts it.
const SHIFTS_BURDEN_TO_TENANT = /השוכר(?:ת)?\s+(?:יישא|תישא|ישא|תשא|אחראי|אחראית|ישלם|תשלם)|על\s+חשבון\s+השוכר|לא\s+(?:יהיה|תהיה)\s+זכאי|מוותר/u;
const SECURITY_RETURN_MAX_REASONABLE_DAYS = 60;

// Preference heuristics. A sentence that hands over a security, as opposed to one about returning
// or realizing it; a choice between kinds ("ערבות בנקאית או שטר חוב") conflicts only when the tenant
// accepts none of them.
const DEMANDS_SECURITY = /להבטחת|ימסור|תמסור|יימסר|תימסר|יפקיד|תפקיד|יופקד|תופקד|יעמיד|תעמיד|ימציא|תמציא|יחתום|תחתום/u;
const OFFERS_CHOICE = /(?<![\p{L}])או(?![\p{L}])|לבחירת/u;
const SECURITY_NAMES: Record<AcceptedSecurityKind, string> = {
  BANK_GUARANTEE: "ערבות בנקאית",
  CASH_DEPOSIT: "פיקדון",
  PROMISSORY_NOTE: "שטר חוב",
  GUARANTOR: "ערב",
};
const RENT_INDEXED = /(?:דמי\s+(?:ה)?שכירות|שכר\s+(?:ה)?דירה)[^.\n]{0,60}(?:צמוד|הצמדה)|(?:צמוד|הצמדה)[^.\n]{0,60}(?:דמי\s+(?:ה)?שכירות|שכר\s+(?:ה)?דירה)/u;
// "הפרשי הצמדה" is the interest on a late payment, not a link of the rent itself to an index.
const NOT_INDEXED = /(?:אינם|אינה|אינו|לא\s+(?:יהיו|יהיה|תהיה))\s+צמוד|ללא\s+הצמדה|הפרשי\s+הצמדה/u;
const BROKER_FEE = /דמי\s+(?:ה)?תיווך|עמלת\s+(?:ה)?תיווך/u;
const NO_RENEWAL_OPTION = /(?:אין|לא\s+(?:תהיה|יהיה|תינתן))\s+(?:ל)?(?:שוכר(?:ת)?\s+)?(?:כל\s+)?(?:אופציה|זכות\s+(?:ל)?(?:הארכ|חידוש))|ללא\s+(?:זכות\s+|אפשרות\s+)?(?:אופציה|הארכה)|לא\s+(?:י|ת)וארך/u;
const SUBLET_FORBIDDEN = /(?:אין|אסור|(?:אינו|אינה|לא\s+(?:יהיה|תהיה))\s+רשאי(?:ת)?|לא\s+(?:י|ת)(?:שכיר|עביר|כניס))[^.\n]{0,60}(?:שכירות\s+משנה|שותפ|דיירים|אנשים\s+(?:נוספים|אחרים)|אדם\s+אחר|להעביר\s+את\s+(?:ה)?(?:חזקה|שכירות))/u;
const WITHOUT_CONSENT = /(?:ללא|בלי|אלא\s+ב)\s*(?:קבלת\s+)?הסכמת/u;
const NOTICE = /הודעה|תיאום|מראש/u;

function hoursLabel(hours: number) {
  if (hours === 168) return "שבוע";
  return hours === 1 ? "שעה אחת" : `${hours.toLocaleString("he-IL", { maximumFractionDigits: 1 })} שעות`;
}

function daysLabel(days: number) {
  return days < 1 ? hoursLabel(days * 24) : days === 1 ? "יום אחד" : `${days.toLocaleString("he-IL", { maximumFractionDigits: 1 })} ימים`;
}
// Reported from both clauses of the pair and merged into one issue, so it names neither as "this".
const OVERRIDE_EXPLANATION = "סעיף אחד בחוזה חל \"על אף האמור\" בסעיף אחר ומעביר לשוכר נטל שהסעיף האחר הטיל על המשכיר, כך שההגנה שבסעיף האחר מתבטלת בפועל.";

function shekels(value: number) {
  return `${value.toLocaleString("he-IL", { maximumFractionDigits: 2 })} ש״ח`;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

// Legally defined numeric limits, computed in code rather than left for a language model to work
// out (section 12 of the brief). Shared by both analysis providers: the offline fallback below
// bakes these straight into its verdict, and the Claude-backed pipeline (analysis.service.ts) both
// feeds these to the model as ground truth and forces a RED verdict when one fails, regardless of
// what the model concludes. The rent and the lease term come from the clauses that define them
// (see deriveContractFacts), which are often sections away from the guarantee clause.
export function computeDeterministicChecks(profile: ClauseProfile, contractFacts: ContractFacts): DeterministicCheck[] {
  const checks: DeterministicCheck[] = [];
  const sources = (...facts: Array<ClauseFact | undefined>) => [...new Set(facts
    .filter((fact): fact is ClauseFact => Boolean(fact) && fact!.clauseId !== profile.clauseId)
    .map((fact) => fact.clauseId))];

  const security = profile.facts.find((fact) => fact.kind === "SECURITY_AMOUNT");
  const rent = contractFacts.MONTHLY_RENT;
  const term = contractFacts.LEASE_TERM_MONTHS;
  if (security && rent) {
    const threeMonths = rent.value * 3;
    // Without a stated lease term the exact cap cannot be computed, but it is never above three
    // months' rent, so a guarantee above that is over the cap whatever the term. Anything lower is
    // left undecided rather than measured against a guessed term.
    const cap = term ? round(Math.min((rent.value * term.value) / 3, threeMonths)) : threeMonths;
    if (term || security.value > threeMonths) {
      checks.push({
        ruleId: "IL-RLL-25Y-SECURITY-CAP",
        label: "תקרת הערובה המותרת",
        legalReferenceId: "IL-RLL-25Y-SECURITY-CAP",
        contractValue: security.value,
        legalLimit: cap,
        calculatedLimit: cap,
        difference: round(security.value - cap),
        unit: "ILS",
        passesRule: security.value <= cap,
        formula: term
          ? `הנמוך מבין ${shekels(rent.value)} × ${term.value} חודשים ÷ 3 לבין 3 × ${shekels(rent.value)} = ${shekels(cap)}`
          : `3 × ${shekels(rent.value)} = ${shekels(cap)} (תקופת השכירות לא צוינה בחוזה, וזו התקרה הגבוהה ביותר האפשרית)`,
        sourceClauseIds: sources(rent, term),
      });
    }
  }

  const urgentRepair = profile.facts.find((fact) => fact.kind === "URGENT_REPAIR_DAYS");
  if (urgentRepair) {
    checks.push({
      ruleId: "IL-RLL-25Z-REPAIRS",
      label: "מועד מרבי לתיקון ליקוי דחוף",
      legalReferenceId: "IL-RLL-25Z-REPAIRS",
      contractValue: urgentRepair.value,
      legalLimit: URGENT_REPAIR_LIMIT_DAYS,
      calculatedLimit: URGENT_REPAIR_LIMIT_DAYS,
      difference: round(urgentRepair.value - URGENT_REPAIR_LIMIT_DAYS),
      unit: "days",
      passesRule: urgentRepair.value <= URGENT_REPAIR_LIMIT_DAYS,
      formula: `ליקוי דחוף יתוקן בתוך ${URGENT_REPAIR_LIMIT_DAYS} ימים לכל היותר`,
      sourceClauseIds: [],
    });
  }

  return checks;
}

// Everything the offline heuristic needs about a clause beyond its own text: the tenant's
// preferences, what the clause and the contract define, the clauses linked to it, and the checks.
export type HeuristicContext = {
  preferences: TenantPreferences;
  profile: ClauseProfile;
  contractFacts: ContractFacts;
  links: ClauseLink[];
  checks: DeterministicCheck[];
};

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
export function deterministicVerdict(clause: ContractClause, context: HeuristicContext): ProviderVerdict {
  const { preferences, profile, contractFacts, links, checks } = context;
  const assessment = { violatesLaw: false, riskWarning: false, preferenceConflict: false };
  const legalReferenceIds: string[] = [];
  let fields: HeuristicVerdictFields = NO_ISSUE_FOUND;

  let crossClauseIssue: ProviderVerdict["crossClauseIssue"];
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

  const monthlyRent = contractFacts.MONTHLY_RENT;

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

  if (!assessment.violatesLaw && monthlyRent?.clauseId === clause.id && monthlyRent.value > preferences.maxMonthlyRentIls) {
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

  const accepted = preferences.acceptedSecurityKinds;
  const refusedSecurities = new Set<AcceptedSecurityKind>();
  for (const sentence of profile.sentences.filter((item) => DEMANDS_SECURITY.test(item))) {
    const demanded = SECURITY_KINDS
      .filter(({ kind, pattern }) => kind !== "OTHER" && pattern.test(sentence))
      .map(({ kind }) => kind as AcceptedSecurityKind);
    const refused = demanded.filter((kind) => !accepted.includes(kind));
    if (refused.length && (!OFFERS_CHOICE.test(sentence) || refused.length === demanded.length)) {
      for (const kind of refused) refusedSecurities.add(kind);
    }
  }
  if (!assessment.violatesLaw && refusedSecurities.size) {
    assessment.preferenceConflict = true;
    const names = [...refusedSecurities].map((kind) => SECURITY_NAMES[kind]).join(" ו");
    const alternatives = accepted.map((kind) => SECURITY_NAMES[kind]).join(" או ");
    fields = {
      title: "סוג הבטוחה שהחוזה דורש לא מקובל עליכם",
      explanation: `החוזה דורש ${names}, וזה לא אחד מסוגי הבטוחה שהשוכר סימן שהוא מוכן לתת.`,
      plainLanguageExplanation: `החוזה דורש מכם ${names}, וציינתם שזה סוג בטוחה שלא מתאים לכם.`,
      whyItMatters: "זו התאמה להעדפותיכם, לא בעיה משפטית. סוג הבטוחה קובע כמה כסף ייתקע אצל המשכיר ומי נוסף עליכם יהיה אחראי לחוב.",
      recommendedAction: alternatives
        ? `בקשו מהמשכיר לקבל במקום זאת ${alternatives}.`
        : "בקשו מהמשכיר לוותר על הבטוחה הזו, או הציעו לו בטוחה אחרת שנוחה לכם יותר.",
      topic: "guarantee_security",
      confidence: "high",
    };
  }

  const increase = profile.facts.find((fact) => fact.kind === "RENT_INCREASE_PERCENT")?.value;
  if (!assessment.violatesLaw && increase !== undefined && increase > preferences.maxAnnualRentIncreasePercent) {
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

  const leaseTerm = contractFacts.LEASE_TERM_MONTHS;
  if (!assessment.violatesLaw && leaseTerm?.clauseId === clause.id && leaseTerm.value !== preferences.leaseLengthMonths) {
    assessment.preferenceConflict = true;
    const longer = leaseTerm.value > preferences.leaseLengthMonths;
    fields = {
      title: longer ? "החוזה ארוך מהתקופה שחיפשתם" : "החוזה קצר מהתקופה שחיפשתם",
      explanation: `תקופת השכירות בחוזה היא ${leaseTerm.value} חודשים, והשוכר ביקש חוזה ל-${preferences.leaseLengthMonths} חודשים.`,
      plainLanguageExplanation: `החוזה הוא לתקופה של ${leaseTerm.value} חודשים, וציינתם שאתם מחפשים חוזה ל-${preferences.leaseLengthMonths} חודשים.`,
      whyItMatters: longer
        ? "זו התאמה להעדפותיכם, לא בעיה משפטית. חוזה ארוך יותר מחייב אתכם לתקופה ארוכה יותר, ויציאה לפני הסוף עלולה לעלות לכם כסף."
        : "זו התאמה להעדפותיכם, לא בעיה משפטית. בחוזה קצר יותר תצטרכו להאריך אותו או לחפש דירה חדשה מוקדם ממה שתכננתם.",
      recommendedAction: longer
        ? `בקשו לקצר את תקופת השכירות ל-${preferences.leaseLengthMonths} חודשים, או להוסיף לחוזה זכות ליציאה מוקדמת.`
        : `בקשו להאריך את תקופת השכירות ל-${preferences.leaseLengthMonths} חודשים, או להוסיף לחוזה אופציה להארכה.`,
      topic: "rent_and_term",
      confidence: "high",
    };
  }

  const indexed = profile.sentences.some((sentence) => RENT_INDEXED.test(sentence) && !NOT_INDEXED.test(sentence));
  if (!assessment.violatesLaw && !preferences.acceptsIndexation && indexed) {
    assessment.preferenceConflict = true;
    fields = {
      title: "דמי השכירות צמודים למדד",
      explanation: "הסעיף מצמיד את דמי השכירות למדד, והשוכר סימן שהצמדה אינה מקובלת עליו.",
      plainLanguageExplanation: "דמי השכירות צמודים למדד, ולכן יעלו כשהמדד עולה. ציינתם שהצמדה למדד לא מקובלת עליכם.",
      whyItMatters: "זו התאמה להעדפותיכם, לא בעיה משפטית. בחוזה צמוד אי אפשר לדעת מראש כמה תשלמו בכל חודש.",
      recommendedAction: "בקשו לבטל את ההצמדה, או לפחות לקבוע תקרה לעלייה השנתית בגללה.",
      suggestedReplacementText: "דמי השכירות יהיו קבועים לכל תקופת השכירות ולא יהיו צמודים למדד כלשהו.",
      topic: "rent_and_term",
      confidence: "high",
    };
  }

  const brokerFee = profile.sentences.some((sentence) => BROKER_FEE.test(sentence) && TENANT_PAYS.test(sentence));
  if (!assessment.violatesLaw && !preferences.acceptsBrokerFee && brokerFee) {
    assessment.preferenceConflict = true;
    fields = {
      title: "תצטרכו לשלם דמי תיווך",
      explanation: "הסעיף מטיל על השוכר את דמי התיווך, והשוכר סימן שאינו מוכן לשלם אותם.",
      plainLanguageExplanation: "לפי החוזה אתם משלמים את דמי התיווך, וציינתם שאתם לא מוכנים לשלם דמי תיווך.",
      whyItMatters: "דמי תיווך הם תשלום חד־פעמי שמתווסף לעלות הכניסה לדירה, מעבר לשכר הדירה הראשון ולבטוחות.",
      recommendedAction: "בררו עם המשכיר אם הוא מוכן לשלם את דמי התיווך בעצמו, להתחלק בהם איתכם או להפחית אותם.",
      topic: "charges_payments",
      confidence: "high",
    };
  }

  const exitKind = profile.sentences
    .filter((sentence) => mentionsConcept(sentence, "EARLY_TERMINATION") || mentionsConcept(sentence, "REPLACEMENT_TENANT"))
    .map((sentence) => earlyExitTerms(sentence)?.kind)
    .find((kind) => kind === "NOT_ALLOWED" || kind === "UNTIL_END");
  if (!assessment.violatesLaw && preferences.earlyExitRequired && exitKind) {
    assessment.preferenceConflict = true;
    fields = {
      title: exitKind === "UNTIL_END" ? "אם תעזבו מוקדם, תשלמו עד סוף התקופה" : "לא תוכלו לצאת מהחוזה לפני סוף התקופה",
      explanation: exitKind === "UNTIL_END"
        ? "הסעיף מחייב את השוכר בדמי השכירות עד תום התקופה גם אם יעזוב לפניה, והשוכר סימן שחשובה לו אפשרות יציאה מוקדמת."
        : "הסעיף שולל מהשוכר זכות לסיים את השכירות לפני תום התקופה, והשוכר סימן שחשובה לו אפשרות כזו.",
      plainLanguageExplanation: exitKind === "UNTIL_END"
        ? "אם תעזבו לפני סוף התקופה, תמשיכו לשלם את דמי השכירות עד סופה. ציינתם שחשוב לכם שתהיה אפשרות לצאת מוקדם."
        : "החוזה לא מאפשר לכם לסיים את השכירות לפני סוף התקופה, וציינתם שחשוב לכם שתהיה אפשרות כזו.",
      whyItMatters: "אם תצטרכו לעזוב בגלל עבודה, לימודים או שינוי משפחתי, תמשיכו לשלם על דירה שאתם כבר לא גרים בה.",
      recommendedAction: "בקשו להוסיף זכות לסיים את השכירות בהודעה מוקדמת סבירה, או בהעמדת שוכר חלופי מתאים.",
      suggestedReplacementText: "השוכר יהיה רשאי לסיים את השכירות לפני תום התקופה בהודעה בכתב של 60 ימים מראש, או בהעמדת שוכר חלופי מתאים, והמשכיר לא יסרב לשוכר החלופי מטעמים בלתי סבירים.",
      topic: "termination_renewal",
      confidence: "high",
    };
  }

  if (!assessment.violatesLaw && preferences.renewalOptionRequired && NO_RENEWAL_OPTION.test(clause.text)) {
    assessment.preferenceConflict = true;
    fields = {
      title: "אין לכם אופציה להאריך את החוזה",
      explanation: "הסעיף שולל מהשוכר אופציה להארכת השכירות, והשוכר סימן שחשובה לו אופציה כזו.",
      plainLanguageExplanation: "החוזה לא נותן לכם אפשרות להאריך את השכירות בסוף התקופה, וציינתם שחשוב לכם שתהיה אופציה כזו.",
      whyItMatters: "בלי אופציה, בסוף התקופה המשכיר יכול לסרב להאריך או לדרוש דמי שכירות גבוהים יותר, ואז תצטרכו לחפש דירה חדשה.",
      recommendedAction: "בקשו להוסיף אופציה להארכת השכירות בתקופה נוספת, עם דמי שכירות או שיעור העלאה שנקבעים כבר עכשיו.",
      suggestedReplacementText: "לשוכר תהיה אופציה להאריך את השכירות בתקופה נוספת של 12 חודשים, בהודעה בכתב למשכיר 60 ימים לפני תום התקופה, ודמי השכירות בתקופה הנוספת ייקבעו מראש בחוזה.",
      topic: "termination_renewal",
      confidence: "high",
    };
  }

  const subletSentence = profile.sentences.find((sentence) => SUBLET_FORBIDDEN.test(sentence));
  if (!assessment.violatesLaw && preferences.roommatesRequired && subletSentence) {
    assessment.preferenceConflict = true;
    const needsConsent = WITHOUT_CONSENT.test(subletSentence);
    fields = {
      title: needsConsent ? "תצטרכו את הסכמת המשכיר כדי לגור עם שותף" : "החוזה לא מאפשר שותפים או שכירות משנה",
      explanation: needsConsent
        ? "הסעיף מתנה הכנסת אדם נוסף לדירה או שכירות משנה בהסכמת המשכיר, והשוכר סימן שהוא צריך אפשרות כזו."
        : "הסעיף אוסר הכנסת אדם נוסף לדירה או שכירות משנה, והשוכר סימן שהוא צריך אפשרות כזו.",
      plainLanguageExplanation: needsConsent
        ? "לפי החוזה תוכלו להכניס שותף או להשכיר בשכירות משנה רק אם המשכיר יסכים, וציינתם שאתם צריכים אפשרות כזו."
        : "החוזה אוסר להכניס שותף או להשכיר בשכירות משנה, וציינתם שאתם צריכים אפשרות כזו.",
      whyItMatters: needsConsent
        ? "המשכיר יכול לסרב בלי לנמק, ואז תישארו לשלם את כל שכר הדירה לבד."
        : "אם תכניסו שותף בכל זאת, המשכיר עלול לטעון שהפרתם את החוזה.",
      recommendedAction: "אם אתם יודעים מראש שתגורו עם שותף, בקשו לכתוב את זה בחוזה, או לקבוע שהמשכיר לא יסרב לשותף או לשוכר משנה מטעמים לא סבירים.",
      suggestedReplacementText: "השוכר רשאי להכניס לדירה שותף לשכירות או להשכיר חלק ממנה בשכירות משנה, בהודעה מראש למשכיר, והמשכיר לא יסרב לכך מטעמים בלתי סבירים.",
      topic: "pets_and_use",
      confidence: "high",
    };
  }

  const minNotice = preferences.minEntryNoticeHours;
  const noticeHours = profile.sentences
    .filter((sentence) => mentionsConcept(sentence, "ENTRY") && NOTICE.test(sentence))
    .map((sentence) => durationsIn(sentence).find((duration) => duration.unit === "days"))
    .find((duration) => duration !== undefined);
  if (!assessment.violatesLaw && minNotice !== null && noticeHours && noticeHours.value * 24 < minNotice) {
    assessment.preferenceConflict = true;
    const stated = hoursLabel(Math.round(noticeHours.value * 24 * 10) / 10);
    fields = {
      title: "המשכיר יכול להיכנס אחרי הודעה קצרה מדי",
      explanation: `הסעיף מתיר כניסת המשכיר לדירה לאחר הודעה של ${stated}, פחות מ-${minNotice} השעות שהשוכר ביקש.`,
      plainLanguageExplanation: `המשכיר יכול להיכנס לדירה אחרי הודעה של ${stated} בלבד, פחות מ-${minNotice} השעות שביקשתם.`,
      whyItMatters: "הודעה קצרה לא משאירה לכם זמן להתארגן או להיות בבית כשהמשכיר מגיע.",
      recommendedAction: `בקשו לקבוע שהמשכיר ייכנס רק בתיאום ובהודעה של ${minNotice} שעות מראש לפחות, למעט במקרה חירום.`,
      suggestedReplacementText: `המשכיר ייכנס לדירה רק לאחר תיאום עם השוכר והודעה של ${minNotice} שעות מראש לפחות, למעט במקרה חירום המצריך כניסה מיידית.`,
      topic: "entry_privacy",
      confidence: "high",
    };
  }

  const urgentRepair = profile.facts.find((fact) => fact.kind === "URGENT_REPAIR_DAYS");
  if (!assessment.violatesLaw && urgentRepair && urgentRepair.value * 24 > preferences.repairUrgencyHours) {
    assessment.preferenceConflict = true;
    const wanted = hoursLabel(preferences.repairUrgencyHours);
    fields = {
      title: "תיקון ליקוי דחוף ייקח יותר זמן ממה שביקשתם",
      explanation: `הסעיף מאפשר ${daysLabel(urgentRepair.value)} לתיקון ליקוי דחוף, יותר מ-${wanted} שהשוכר הגדיר כמועד המרבי.`,
      plainLanguageExplanation: `לפי החוזה המשכיר יתקן ליקוי דחוף בתוך ${daysLabel(urgentRepair.value)}, וציינתם שאתם צריכים תיקון בתוך ${wanted} לכל היותר.`,
      whyItMatters: "ליקוי דחוף, כמו נזילה או תקלת חשמל, פוגע ביכולת לגור בדירה, וכל יום של עיכוב מורגש.",
      recommendedAction: `בקשו לקצר את המועד לתיקון ליקוי דחוף ל-${wanted}.`,
      suggestedReplacementText: `המשכיר יתקן ליקוי דחוף המונע מגורים סבירים בדירה בתוך ${wanted} ממועד קבלת הודעת השוכר.`,
      topic: "repairs_maintenance",
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

  const returnDays = profile.facts.find((fact) => fact.kind === "SECURITY_RETURN_DAYS")?.value;
  if (!assessment.violatesLaw && returnDays !== undefined && returnDays > SECURITY_RETURN_MAX_REASONABLE_DAYS) {
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

  // A "notwithstanding section X" clause that moves a burden onto the tenant takes away what section
  // X gave; both clauses are flagged, and the pair is reported once as an override.
  const overrides = links.filter((link) => link.relation === "OVERRIDES");
  const overriddenBy = links.filter((link) => link.relation === "OVERRIDDEN_BY" && SHIFTS_BURDEN_TO_TENANT.test(link.excerpt));
  if (!assessment.violatesLaw && overrides.length && SHIFTS_BURDEN_TO_TENANT.test(clause.text)) {
    assessment.riskWarning = true;
    crossClauseIssue = {
      kind: "OVERRIDE",
      clauseIds: overrides.map((link) => link.clauseId),
      explanation: OVERRIDE_EXPLANATION,
    };
    fields = {
      title: "הסעיף הזה מבטל הגנה שניתנה לכם בסעיף אחר",
      explanation: "הסעיף קובע שהוא חל על אף האמור בסעיף אחר בחוזה, ומטיל על השוכר נטל שהסעיף האחר הטיל על המשכיר.",
      plainLanguageExplanation: "סעיף אחר בחוזה נותן לכם הגנה, והסעיף הזה מבטל אותה במפורש ומעביר את הנטל אליכם.",
      whyItMatters: "קריאה של כל סעיף לבד עלולה להטעות: ההגנה נראית קיימת, אבל בפועל הסעיף הזה גובר עליה.",
      recommendedAction: "בקשו למחוק את הסעיף הזה או לצמצם אותו כך שלא יגבר על ההגנה שבסעיף האחר.",
      topic: "other",
      confidence: "medium",
    };
  } else if (!assessment.violatesLaw && overriddenBy.length) {
    assessment.riskWarning = true;
    crossClauseIssue = {
      kind: "OVERRIDE",
      clauseIds: overriddenBy.map((link) => link.clauseId),
      explanation: OVERRIDE_EXPLANATION,
    };
    fields = {
      ...fields,
      title: "ההגנה בסעיף הזה מבוטלת בסעיף אחר בחוזה",
      plainLanguageExplanation: "הסעיף הזה נראה מגן עליכם, אבל סעיף אחר בחוזה קובע שהוא גובר עליו ומעביר אליכם את הנטל.",
      whyItMatters: "בפועל ייתכן שלא תוכלו להסתמך על ההגנה שבסעיף הזה.",
      recommendedAction: "בקשו למחוק את הסעיף שגובר על הסעיף הזה, כדי שההגנה תישאר בתוקף.",
      confidence: "medium",
    };
  }

  const contextClauseIds = [...new Set([
    ...checks.flatMap((check) => check.sourceClauseIds ?? []),
    ...(crossClauseIssue?.clauseIds ?? []),
  ])];
  return {
    ...fields,
    clauseQuote: clause.text,
    legalAssessment: assessment,
    legalReferenceIds,
    contextClauseIds,
    ...(crossClauseIssue ? { crossClauseIssue } : {}),
  };
}
