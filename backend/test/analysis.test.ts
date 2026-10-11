import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  defaultPreferences,
  normalizePreferences,
  type ContractClause,
  type FindingCategory,
  type FindingTopic,
  type TenantPreferences,
} from "../src/domain/models.js";
import { redactClauses } from "../src/modules/analyses/anonymization.service.js";
import {
  categoryForAssessment,
  classifyClause,
  isSubstantiveClause,
  resolveClauseQuote,
} from "../src/modules/analyses/classification.js";
import {
  deriveContractFacts,
  hebrewNumber,
  profileClause,
} from "../src/modules/analyses/clause-facts.service.js";
import { linkClauses } from "../src/modules/analyses/clause-linking.service.js";
import {
  computeDeterministicChecks,
  deterministicVerdict,
} from "../src/modules/analyses/deterministic-analysis.service.js";
import {
  detectMissingProtections,
  evaluateProtectionChecklistDeterministically,
} from "../src/modules/analyses/protection-checklist.service.js";
import { extractClausesFromPlainText } from "../src/modules/contracts/pdf-extraction.service.js";

type EvaluationCase = {
  id: string;
  contractPath: string;
  preferenceProfileId: string;
  findings: Array<{
    clauseId: string;
    severity: string;
    category?: FindingCategory;
    topic?: FindingTopic;
    legalReferenceIds: string[];
  }>;
  expectedLinks?: Array<{ from: string; to: string; relation: string }>;
  unexpectedLinks?: Array<{ from: string; to: string }>;
  missingProtectionIds: string[];
  privacy: { rawValuesThatMustBeAbsent: string[]; requiredPlaceholders: string[] };
};

// The offline analysis exactly as analysis.service.ts runs it: only substantive clauses, each
// judged with the facts and linked clauses of the whole contract.
function analyzeOffline(clauses: ContractClause[], preferences: TenantPreferences) {
  const analyzable = clauses.filter(isSubstantiveClause);
  const graph = linkClauses(analyzable);
  return {
    graph,
    verdicts: analyzable.map((clause) => {
      const profile = graph.profiles.get(clause.id)!;
      const links = graph.links.get(clause.id)!;
      const checks = computeDeterministicChecks(profile, graph.contractFacts);
      return {
        clauseId: clause.id,
        checks,
        verdict: deterministicVerdict(clause, { preferences, profile, contractFacts: graph.contractFacts, links, checks }),
      };
    }),
  };
}

const evaluationRoot = path.resolve("evaluation");
const annotations = JSON.parse(
  await readFile(path.join(evaluationRoot, "annotations/expected-findings.json"), "utf8"),
) as { cases: EvaluationCase[] };
const profiles = JSON.parse(
  await readFile(path.join(evaluationRoot, "preferences/tenant-profiles.json"), "utf8"),
) as { profiles: Array<TenantPreferences & { id: string }> };

for (const evaluationCase of annotations.cases) {
  test(`${evaluationCase.id} satisfies the executable analysis specification`, async () => {
    const source = await readFile(path.join(evaluationRoot, evaluationCase.contractPath), "utf8");
    const extracted = extractClausesFromPlainText(source);
    const redaction = await redactClauses(extracted);
    const modelBoundText = redaction.clauses.map((clause) => clause.text).join("\n");
    const profile = profiles.profiles.find((item) => item.id === evaluationCase.preferenceProfileId);
    assert.ok(profile);

    for (const raw of evaluationCase.privacy.rawValuesThatMustBeAbsent) {
      assert.equal(modelBoundText.includes(raw), false, `${raw} reached the model-bound payload`);
    }
    for (const placeholder of evaluationCase.privacy.requiredPlaceholders) {
      assert.equal(modelBoundText.includes(placeholder), true, `${placeholder} is missing`);
    }

    const { graph, verdicts } = analyzeOffline(redaction.clauses, profile);
    for (const expected of evaluationCase.findings) {
      const actual = verdicts.find((item) => item.clauseId === expected.clauseId);
      assert.ok(actual);
      assert.equal(classifyClause(actual.verdict.legalAssessment), expected.severity);
      if (expected.category) {
        assert.equal(categoryForAssessment(actual.verdict.legalAssessment), expected.category);
      }
      if (expected.topic) {
        assert.equal(actual.verdict.topic, expected.topic);
      }
      for (const referenceId of expected.legalReferenceIds) {
        assert.ok(actual.verdict.legalReferenceIds.includes(referenceId));
      }
    }

    for (const expected of evaluationCase.expectedLinks ?? []) {
      const link = graph.links.get(expected.from)?.find((item) => item.clauseId === expected.to);
      assert.ok(link, `${expected.from} was not supplied with ${expected.to}`);
      assert.equal(link.relation, expected.relation, `${expected.from} -> ${expected.to}`);
    }
    for (const unexpected of evaluationCase.unexpectedLinks ?? []) {
      const link = graph.links.get(unexpected.from)?.find((item) => item.clauseId === unexpected.to);
      assert.equal(link, undefined, `${unexpected.from} must not be supplied with ${unexpected.to}`);
    }

    const missing = detectMissingProtections(redaction.clauses).map((item) => item.protectionId);
    for (const expected of evaluationCase.missingProtectionIds) assert.ok(missing.includes(expected));
  });
}

test("classification is deterministic and never lets a violation become OK", () => {
  assert.equal(classifyClause({ violatesLaw: true, riskWarning: false, preferenceConflict: false }), "RED");
  assert.equal(classifyClause({ violatesLaw: false, riskWarning: true, preferenceConflict: false }), "ORANGE");
  assert.equal(classifyClause({ violatesLaw: false, riskWarning: false, preferenceConflict: true }), "ORANGE");
  assert.equal(classifyClause({ violatesLaw: false, riskWarning: false, preferenceConflict: false }), "OK");
});

test("category is derived from the same assessment as severity, independently of the model", () => {
  assert.equal(categoryForAssessment({ violatesLaw: true, riskWarning: true, preferenceConflict: true }), "legal_compliance");
  assert.equal(categoryForAssessment({ violatesLaw: false, riskWarning: true, preferenceConflict: true }), "contractual_risk");
  assert.equal(categoryForAssessment({ violatesLaw: false, riskWarning: false, preferenceConflict: true }), "tenant_preference");
  assert.equal(categoryForAssessment({ violatesLaw: false, riskWarning: false, preferenceConflict: false }), "informational");
});

test("non-substantive clauses (headers, page numbers, the document title) are filtered from findings", () => {
  assert.equal(isSubstantiveClause({ id: "C000", text: "חוזה שכירות למגורים — תרחיש הערכה RR-EVAL-005, תל אביב", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "עמוד 2 מתוך 5", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "חוזה שכירות למגורים — תרחיש הערכה, גרסה 2\nלאחר תיקוני המשכיר", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "12/03/2026", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "----------", locations: [] }), false);
  assert.equal(isSubstantiveClause({ id: "C000", text: "   ", locations: [] }), false);
  assert.equal(
    isSubstantiveClause({ id: "C001", text: "תקופת השכירות היא שנים עשר חודשים.", locations: [] }),
    true,
  );
});

test("a quote is trusted only when it is genuinely part of the clause, otherwise a safe excerpt is used", () => {
  const clause = { id: "C001", text: "  להבטחת התחייבויות השוכר ימסור השוכר למשכיר ערבות בנקאית בסך 30,000 ש״ח.  ", locations: [] };
  assert.equal(
    resolveClauseQuote(clause, "ערבות בנקאית בסך 30,000 ש״ח"),
    "ערבות בנקאית בסך 30,000 ש״ח",
  );
  // A quote spaced differently from the clause (per-glyph extraction, or a re-spaced model copy) is
  // still recognized, and the tenant sees the clause's own spacing.
  assert.equal(resolveClauseQuote(clause, "ע ר ב ו ת  בנקאית"), "ערבות בנקאית");
  // A candidate the model invented (not present in the clause) never reaches the tenant verbatim.
  const fallback = resolveClauseQuote(clause, "הדירה תימסר כשהיא מרוהטת במלואה");
  assert.equal(fallback, clause.text.trim());
});

test("computeDeterministicChecks reports the security-deposit cap as a pure numeric calculation", () => {
  const clauses = [
    { id: "C001", text: "תקופת השכירות היא שנים עשר חודשים. דמי השכירות החודשיים הם 6,000 ש״ח.", locations: [] },
    { id: "C007", text: "להבטחת התחייבויות השוכר ימסור השוכר למשכיר ערבות בנקאית בסך 30,000 ש״ח.", locations: [] },
  ];
  const profiles = clauses.map(profileClause);
  const checks = computeDeterministicChecks(profiles[1]!, deriveContractFacts(profiles));
  const securityCheck = checks.find((check) => check.ruleId === "IL-RLL-25Y-SECURITY-CAP");
  assert.ok(securityCheck);
  assert.equal(securityCheck.contractValue, 30_000);
  assert.equal(securityCheck.calculatedLimit, 18_000);
  assert.equal(securityCheck.difference, 12_000);
  assert.equal(securityCheck.passesRule, false);
  // The rent and term came from another clause, and the formula shows the contract's own numbers.
  assert.deepEqual(securityCheck.sourceClauseIds, ["C001"]);
  assert.match(securityCheck.formula ?? "", /6,000.*12.*18,000/u);
});

test("without a stated lease term the cap is decided only when the guarantee exceeds three months' rent", () => {
  const rent = { id: "C001", text: "דמי השכירות החודשיים הם 5,000 ש״ח.", locations: [] };
  const facts = deriveContractFacts([rent].map(profileClause));
  const high = profileClause({ id: "C002", text: "השוכר ימסור ערבות בנקאית בסך 16,000 ש״ח.", locations: [] });
  const low = profileClause({ id: "C003", text: "השוכר ימסור ערבות בנקאית בסך 12,000 ש״ח.", locations: [] });
  const [highCheck] = computeDeterministicChecks(high, facts);
  assert.equal(highCheck?.calculatedLimit, 15_000);
  assert.equal(highCheck?.passesRule, false);
  // 12,000 may or may not exceed the cap depending on the unknown term; no guessed term is used.
  assert.deepEqual(computeDeterministicChecks(low, facts), []);
});

test("each number is attributed to the subject named before it in its own sentence", () => {
  const repairs = profileClause({
    id: "C008",
    text: "7. תיקונים ותחזוקה\nהמשכיר יתקן תקלה אחרת שאינה קלת ערך בתוך 45 ימים ממועד הודעת השוכרת. ליקוי דחוף שאינו מאפשר מגורים סבירים בדירה יתוקן בתוך שבעה ימים ממועד קבלת הודעת השוכרת.",
    heading: "תיקונים ותחזוקה",
    sectionLabel: "7",
    locations: [],
  });
  assert.deepEqual(repairs.facts.map(({ kind, value }) => [kind, value]), [["REPAIR_DAYS", 45], ["URGENT_REPAIR_DAYS", 7]]);

  const sameSentence = profileClause({
    id: "C009",
    text: "בעלת הדירה תתקן תקלה אחרת בתוך 30 ימים, וליקוי דחוף שאינו מאפשר מגורים סבירים בתוך שלושה ימים ממועד הודעה.",
    locations: [],
  });
  assert.deepEqual(sameSentence.facts.map(({ kind, value }) => [kind, value]), [["REPAIR_DAYS", 30], ["URGENT_REPAIR_DAYS", 3]]);

  const rents = [
    "בעת החתימה ישלם השוכר את דמי השכירות לשלושה החודשים הראשונים בסך 21,000 ש״ח.",
    "דמי השכירות החודשיים הם 7,000 ש״ח.",
    "בתקופת האופציה דמי השכירות יהיו 7,500 ש״ח.",
  ].map((text, index) => profileClause({ id: `C00${index + 1}`, text, locations: [] }));
  assert.deepEqual(rents.flatMap((profile) => profile.facts.map(({ kind, value }) => [kind, value])), [
    ["PREPAID_RENT", 21_000],
    ["MONTHLY_RENT", 7_000],
    ["OPTION_RENT", 7_500],
  ]);
  assert.equal(deriveContractFacts(rents).MONTHLY_RENT?.value, 7_000);

  // Numbers that belong to a notice period, a cure period, or a fee are not mistaken for facts.
  const noise = profileClause({
    id: "C010",
    text: "בעלת הדירה רשאית להיכנס לדירה לאחר הודעה מראש של 12 שעות לצורך תיקון. הצד הנפגע רשאי לבטל את ההסכם לאחר שנתן לצד המפר שבעה ימים לתקן הפרה. רשאית לקזז מהפיקדון עלות ניקיון בסך 1,200 ש״ח.",
    locations: [],
  });
  assert.deepEqual(noise.facts, []);
});

test("Hebrew number words are read as numbers", () => {
  assert.equal(hebrewNumber("שנים עשר"), 12);
  assert.equal(hebrewNumber("ארבעים וחמישה"), 45);
  assert.equal(hebrewNumber("שלושה"), 3);
  assert.equal(hebrewNumber("תשעים"), 90);
  assert.equal(hebrewNumber("דחוף"), null);
});

test("section references distinguish overrides, subordination and statutes", () => {
  const profile = profileClause({
    id: "C010",
    text: "על אף האמור בסעיף 6 לעיל, ובכפוף לסעיף 9.2, ובהתאם לסעיף 25ז לחוק השכירות והשאילה, השוכר יישא בתיקונים כאמור בסעיפים 4 ו-5.",
    sectionLabel: "10",
    locations: [],
  });
  assert.deepEqual(profile.references.map(({ kind, sectionLabel }) => [kind, sectionLabel]), [
    ["NOTWITHSTANDING", "6"],
    ["SUBJECT_TO", "9.2"],
    ["REFERENCE", "4"],
    ["REFERENCE", "5"],
  ]);
});

test("a long section split into parts is always analyzed with its other parts", () => {
  const graph = linkClauses([
    { id: "C004-P1", text: "4. תיקונים\nהמשכיר יתקן כל ליקוי בדירה.", sectionLabel: "4", heading: "תיקונים", locations: [] },
    { id: "C004-P2", text: "על אף האמור, השוכר יישא בתיקון נזק שגרם.", sectionLabel: "4", heading: "תיקונים", locations: [] },
    { id: "C005", text: "5. בעלי חיים\nאין להחזיק בעלי חיים.", sectionLabel: "5", heading: "בעלי חיים", locations: [] },
  ]);
  assert.deepEqual(graph.links.get("C004-P1")!.map(({ clauseId, relation }) => [clauseId, relation]), [["C004-P2", "SAME_SECTION"]]);
  assert.deepEqual(graph.links.get("C005"), []);
});

test("clause linking can be switched off for evaluation runs, keeping the contract facts", () => {
  const clauses = [
    { id: "C001", text: "דמי השכירות החודשיים הם 6,000 ש״ח.", locations: [] },
    { id: "C002", text: "השוכר ימסור ערבות בנקאית בסך 30,000 ש״ח.", locations: [] },
  ];
  const graph = linkClauses(clauses, { enabled: false });
  assert.deepEqual(graph.links.get("C002"), []);
  assert.equal(graph.contractFacts.MONTHLY_RENT?.value, 6_000);
  assert.equal(linkClauses(clauses).links.get("C002")![0]?.clauseId, "C001");
});

test("a landlord-only early-termination right is PARTIAL, not COVERED, for the tenant protection checklist", () => {
  const clause = {
    id: "C012",
    text: "המשכיר רשאי לבטל את החוזה בכל עת בהודעה מוקדמת של 30 יום, מבלי שלשוכר תהיה זכות מקבילה לביטול מוקדם של החוזה.",
    locations: [],
  };
  const protections = evaluateProtectionChecklistDeterministically([clause]);
  const earlyTermination = protections.find((item) => item.protectionId === "RR-REC-EARLY-TERMINATION");
  assert.ok(earlyTermination);
  assert.equal(earlyTermination.status, "PARTIAL");
});

test("preferences saved before a field existed are read with its default, in one key order", () => {
  const read = normalizePreferences({
    maxMonthlyRentIls: 5_000,
    repairUrgencyHours: 48,
    leaseLengthMonths: 12,
    maxAnnualRentIncreasePercent: 3,
    petsRequired: true,
    furnishedRequired: false,
    acceptsGuarantorRequirement: false,
  });
  assert.deepEqual(Object.keys(read), Object.keys(defaultPreferences));
  assert.deepEqual(read.acceptedSecurityKinds, ["BANK_GUARANTEE", "CASH_DEPOSIT", "PROMISSORY_NOTE"]);
  assert.equal(read.maxMonthlyRentIls, 5_000);
  assert.equal(read.minEntryNoticeHours, null);
  assert.deepEqual(
    normalizePreferences({ acceptedSecurityKinds: ["GUARANTOR", "BANK_GUARANTEE", "GUARANTOR"] }).acceptedSecurityKinds,
    ["BANK_GUARANTEE", "GUARANTOR"],
  );
});

const preferenceContract = extractClausesFromPlainText([
  "[C001]",
  "תקופת השכירות היא 24 חודשים. דמי השכירות החודשיים הם 5,000 ש״ח.",
  "[C002]",
  "דמי השכירות צמודים למדד המחירים לצרכן ויעודכנו אחת לשנה.",
  "[C003]",
  "להבטחת התחייבויות השוכר ימסור השוכר למשכיר שטר חוב בסך 15,000 ש״ח.",
  "[C004]",
  "דמי התיווך בסך 5,000 ש״ח ישולמו על ידי השוכר במעמד החתימה.",
  "[C005]",
  "השוכר לא יהיה רשאי לסיים את השכירות לפני תום התקופה.",
  "[C006]",
  "אין לשוכר אופציה להאריך את השכירות.",
  "[C007]",
  "השוכר לא ישכיר את הדירה בשכירות משנה ולא יכניס לדירה דיירים נוספים.",
  "[C008]",
  "המשכיר רשאי להיכנס לדירה לאחר תיאום והודעה מראש של 12 שעות.",
  "[C009]",
  "המשכיר יתקן ליקוי דחוף המונע מגורים סבירים בדירה בתוך שלושה ימים ממועד קבלת הודעת השוכר.",
  "[C010]",
  "להבטחת התחייבויות השוכר ימסור השוכר ערבות בנקאית או שטר חוב, לבחירת השוכר.",
].join("\n"));

test("each preference flags the clause that conflicts with it, and only that clause", () => {
  const strict: TenantPreferences = {
    ...defaultPreferences,
    repairUrgencyHours: 48,
    acceptedSecurityKinds: ["BANK_GUARANTEE"],
    acceptsIndexation: false,
    earlyExitRequired: true,
    roommatesRequired: true,
    renewalOptionRequired: true,
    minEntryNoticeHours: 24,
    acceptsBrokerFee: false,
  };
  const expectedTopics: Record<string, FindingTopic> = {
    C001: "rent_and_term",
    C002: "rent_and_term",
    C003: "guarantee_security",
    C004: "charges_payments",
    C005: "termination_renewal",
    C006: "termination_renewal",
    C007: "pets_and_use",
    C008: "entry_privacy",
    C009: "repairs_maintenance",
  };
  for (const { clauseId, verdict } of analyzeOffline(preferenceContract, strict).verdicts) {
    const topic = expectedTopics[clauseId];
    assert.equal(categoryForAssessment(verdict.legalAssessment), topic ? "tenant_preference" : "informational", clauseId);
    if (topic) assert.equal(verdict.topic, topic, clauseId);
  }
});

test("permissive preferences leave the same clauses without a preference conflict", () => {
  const permissive = { ...defaultPreferences, leaseLengthMonths: 24 };
  for (const { clauseId, verdict } of analyzeOffline(preferenceContract, permissive).verdicts) {
    assert.equal(verdict.legalAssessment.preferenceConflict, false, clauseId);
  }
});
