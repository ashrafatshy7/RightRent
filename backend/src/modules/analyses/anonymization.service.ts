import type { ContractClause } from "../../domain/models.js";

type RedactionRule = {
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
};

const rules: RedactionRule[] = [
  {
    pattern: /(?:תעודת\s+זהות|ת["״']?ז)\s*[:#-]?\s*\d{9}\b/gu,
    replace: () => "תעודת זהות [ID_NUMBER]",
  },
  {
    pattern: /\b(?:\+972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}\b/gu,
    replace: () => "[PHONE_NUMBER]",
  },
  {
    pattern: /(?:ברחוב|רחוב)\s+[\p{Script=Hebrew}\d'"״\- ]+(?:,\s*[\p{Script=Hebrew}\- ]+)?(?=[.,\n]|$)/gu,
    replace: () => "בכתובת [ADDRESS]",
  },
  {
    pattern: /המשכיר\s+([\p{Script=Hebrew}'-]{2,}\s+[\p{Script=Hebrew}'-]{2,})(?=\s*[,،])/gu,
    replace: () => "המשכיר [LANDLORD_NAME]",
  },
  {
    pattern: /משכיר\s+ל([\p{Script=Hebrew}'-]{2,}\s+[\p{Script=Hebrew}'-]{2,})(?=\s*[,،])/gu,
    replace: () => "משכיר ל[TENANT_NAME]",
  },
  {
    pattern: /\b\d{9}\b/gu,
    replace: () => "[ID_NUMBER]",
  },
];

export function redactClauses(clauses: ContractClause[]) {
  let redactedEntityCount = 0;
  const redacted = clauses.map((clause) => {
    let text = clause.text;
    for (const rule of rules) {
      text = text.replace(rule.pattern, (...args) => {
        redactedEntityCount += 1;
        return rule.replace(args[0], ...args.slice(1, -2));
      });
    }
    return { ...clause, text };
  });

  return { clauses: redacted, redactedEntityCount };
}
