import type { ClauseRelation, ContractClause } from "../../domain/models.js";
import {
  CONCEPT_NAMES,
  deriveContractFacts,
  FACT_NAMES,
  mentionsConcept,
  profileClause,
  type ClauseFact,
  type ClauseProfile,
  type ConceptId,
  type ContractFacts,
  type FactKind,
} from "./clause-facts.service.js";

// Before a clause is judged, the clauses it cannot be judged without are found and supplied with it:
// a guarantee clause needs the monthly rent and the lease term (often sections apart), a repair duty
// needs the clause that says "notwithstanding section 7...", a long section split in two needs its
// other half. Links are built from explicit, explainable signals - section references, a value the
// clause depends on, a subject it is tied to, similar wording - never from a model, so the same
// contract always gets the same links and each link can say why it exists.

export type ClauseLink = {
  clauseId: string;
  relation: ClauseRelation;
  reason: string;
  score: number;
  // The part of the linked clause supplied as context: the sentences that matter for this link.
  excerpt: string;
};

export type ClauseGraph = {
  profiles: Map<string, ClauseProfile>;
  contractFacts: ContractFacts;
  links: Map<string, ClauseLink[]>;
};

// A clause's own references and the relations that make one clause change another's meaning are
// always supplied (up to MAX_EXPLICIT_LINKS); weaker topical links only fill the remaining room.
const MAX_EXPLICIT_LINKS = 6;
const MAX_LINKS = 4;
const CONTEXT_CHAR_BUDGET = 2_500;
const EXCERPT_MAX_CHARS = 600;
const SAME_SECTION_MAX_CHARS = 900;
export const LEXICAL_SIMILARITY_MIN = 0.3;
export const EMBEDDING_SIMILARITY_MIN = 0.55;

const EXPLICIT: ReadonlySet<ClauseRelation> = new Set([
  "SAME_SECTION", "REFERENCES", "REFERENCED_BY", "OVERRIDES", "OVERRIDDEN_BY",
]);

const RELATION_SCORE: Record<ClauseRelation, number> = {
  SAME_SECTION: 1,
  OVERRIDDEN_BY: 0.97,
  OVERRIDES: 0.95,
  REFERENCES: 0.9,
  DEFINES_VALUE: 0.85,
  REFERENCED_BY: 0.7,
  RELATED_TOPIC: 0.6,
  SIMILAR_TEXT: 0.3,
};

// What a clause about each subject cannot be judged without: values defined elsewhere, and other
// subjects that change its effect. A guarantee is judged against the rent and term, and against the
// breaches that allow realizing it; an urgent-repair duty against the self-repair clause; and so on.
const NEEDS: Partial<Record<ConceptId, { facts?: FactKind[]; concepts?: ConceptId[] }>> = {
  SECURITY: { facts: ["MONTHLY_RENT", "LEASE_TERM_MONTHS"], concepts: ["BREACH", "VACATING"] },
  GUARANTOR: { facts: ["MONTHLY_RENT"], concepts: ["SECURITY"] },
  RENT: { concepts: ["INDEXATION", "RENT_INCREASE"] },
  INDEXATION: { facts: ["MONTHLY_RENT"], concepts: ["OPTION"] },
  RENT_INCREASE: { facts: ["MONTHLY_RENT"], concepts: ["OPTION", "INDEXATION"] },
  OPTION: { facts: ["MONTHLY_RENT", "LEASE_TERM_MONTHS"], concepts: ["RENT_INCREASE"] },
  PENALTY: { facts: ["MONTHLY_RENT"], concepts: ["BREACH", "VACATING"] },
  EARLY_TERMINATION: { facts: ["LEASE_TERM_MONTHS"], concepts: ["REPLACEMENT_TENANT", "OPTION", "PENALTY"] },
  REPLACEMENT_TENANT: { concepts: ["EARLY_TERMINATION", "SUBLET"] },
  URGENT_REPAIR: { concepts: ["SELF_REPAIR"] },
  REPAIRS: { concepts: ["SELF_REPAIR", "WAIVER", "HANDOVER"] },
  SELF_REPAIR: { concepts: ["URGENT_REPAIR", "REPAIRS"] },
  WAIVER: { concepts: ["HANDOVER", "REPAIRS"] },
  HANDOVER: { concepts: ["WAIVER", "VACATING"] },
  ENTRY: { concepts: ["SALE_TRANSFER", "REPAIRS"] },
  BREACH: { concepts: ["SECURITY", "VACATING", "PENALTY"] },
  VACATING: { concepts: ["SECURITY", "PENALTY", "HANDOVER"] },
  CHARGES: { concepts: ["INSURANCE"] },
  INSURANCE: { concepts: ["CHARGES"] },
  SUBLET: { concepts: ["REPLACEMENT_TENANT"] },
  SALE_TRANSFER: { concepts: ["ENTRY"] },
};

function formatFactValue(fact: ClauseFact) {
  const value = fact.value.toLocaleString("he-IL", { maximumFractionDigits: 1 });
  if (fact.unit === "ILS") return `${value} ש״ח`;
  if (fact.unit === "months") return `${value} חודשים`;
  if (fact.unit === "percent") return `${value}%`;
  return `${value} ימים`;
}

function truncate(text: string, maxChars: number) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

// The sentences of `profile` that `matches` selects, each with the sentence after it (a condition
// often continues there), in document order.
function sentencesAround(profile: ClauseProfile, matches: (sentence: string) => boolean, maxChars: number) {
  const picked = new Set<number>();
  profile.sentences.forEach((sentence, index) => {
    if (!matches(sentence)) return;
    picked.add(index);
    if (index + 1 < profile.sentences.length) picked.add(index + 1);
  });
  const text = [...picked].sort((left, right) => left - right).map((index) => profile.sentences[index]).join(" ");
  return truncate(text || profile.sentences.join(" "), maxChars);
}

// The strongest clause about a subject: the one whose heading names it, then the one mentioning it
// most.
function bestClauseFor(concept: ConceptId, profiles: ClauseProfile[], exclude: string) {
  const strength = (profile: ClauseProfile) =>
    (profile.headingConcepts.has(concept) ? 100 : 0) + (profile.concepts.get(concept) ?? 0);
  return profiles
    .filter((profile) => profile.clauseId !== exclude && profile.primaryConcepts.has(concept))
    .sort((left, right) => strength(right) - strength(left))[0];
}

function baseId(clauseId: string) {
  return clauseId.replace(/-P\d+$/u, "");
}

// Section labels resolve to every clause carrying them (a long section is split into parts); a
// reference to a subsection that was not split out ("9.2") resolves to its parent section ("9").
function clausesForLabel(label: string, profiles: ClauseProfile[]) {
  const exact = profiles.filter((profile) => profile.sectionLabel === label);
  if (exact.length) return exact;
  const parent = label.split(".")[0];
  return parent && parent !== label ? profiles.filter((profile) => profile.sectionLabel === parent) : [];
}

// Lexical similarity for the offline path: TF-IDF cosine over word stems, with Hebrew one-letter
// prefixes stripped, so words every clause shares ("השוכר", "הדירה") weigh nothing.
const STOPWORDS = new Set([
  "את", "על", "של", "או", "לא", "כל", "אם", "גם", "רק", "כי", "זה", "זו", "הוא", "היא", "יהיה", "תהיה",
  "משכיר", "משכירה", "שוכר", "שוכרת", "דירה", "חוזה", "הסכם", "סעיף", "בין", "לפי", "עד", "אשר", "ידי",
]);

function stems(text: string) {
  return (text.match(/[\p{L}]+/gu) ?? [])
    .map((word) => (word.length > 4 ? word.replace(/^[והבלמשכ]{1,2}/u, "") : word))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

export function lexicalSimilarity(texts: Map<string, string>) {
  const terms = new Map([...texts].map(([id, text]) => [id, stems(text)]));
  const documentFrequency = new Map<string, number>();
  for (const words of terms.values()) for (const word of new Set(words)) {
    documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  }
  const total = texts.size;
  const vectors = new Map([...terms].map(([id, words]) => {
    const vector = new Map<string, number>();
    for (const word of words) vector.set(word, (vector.get(word) ?? 0) + 1);
    for (const [word, count] of vector) vector.set(word, count * Math.log((1 + total) / (1 + documentFrequency.get(word)!)));
    return [id, vector] as const;
  }));
  const norm = (vector: Map<string, number>) => Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
  return (left: string, right: string) => {
    const a = vectors.get(left);
    const b = vectors.get(right);
    if (!a || !b) return 0;
    let dot = 0;
    for (const [word, value] of a) dot += value * (b.get(word) ?? 0);
    const denominator = norm(a) * norm(b);
    return denominator ? dot / denominator : 0;
  };
}

function cosine(left: number[], right: number[]) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * (right[index] ?? 0);
    leftNorm += left[index]! ** 2;
    rightNorm += (right[index] ?? 0) ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

type Candidate = Omit<ClauseLink, "score"> & { score: number };

function addCandidate(candidates: Map<string, Candidate>, candidate: Candidate) {
  const existing = candidates.get(candidate.clauseId);
  if (!existing) {
    candidates.set(candidate.clauseId, candidate);
    return;
  }
  // Several independent signals for the same clause make the link stronger; the strongest relation
  // names it.
  const [stronger, weaker] = existing.score >= candidate.score ? [existing, candidate] : [candidate, existing];
  candidates.set(candidate.clauseId, {
    ...stronger,
    score: Math.min(1, stronger.score + 0.05),
    excerpt: stronger.excerpt.length >= weaker.excerpt.length ? stronger.excerpt : weaker.excerpt,
  });
}

function selectLinks(candidates: Candidate[]) {
  const ranked = [...candidates].sort((left, right) => right.score - left.score);
  const explicit = ranked.filter((link) => EXPLICIT.has(link.relation)).slice(0, MAX_EXPLICIT_LINKS);
  const topical = ranked.filter((link) => !EXPLICIT.has(link.relation))
    .slice(0, Math.max(0, MAX_LINKS - explicit.length));
  const selected: ClauseLink[] = [];
  let budget = CONTEXT_CHAR_BUDGET;
  for (const link of [...explicit, ...topical]) {
    if (budget <= 0) break;
    const excerpt = truncate(link.excerpt, budget);
    budget -= excerpt.length;
    selected.push({ ...link, excerpt });
  }
  return selected;
}

export type LinkingOptions = {
  // Clause embeddings (redacted text) when available; lexical similarity is used otherwise.
  embeddings?: ReadonlyMap<string, number[]> | null;
  // Off for evaluation runs that measure the analysis without cross-clause context.
  enabled?: boolean;
};

export function linkClauses(clauses: ContractClause[], options: LinkingOptions = {}): ClauseGraph {
  const profileList = clauses.map(profileClause);
  const profiles = new Map(profileList.map((profile) => [profile.clauseId, profile]));
  const contractFacts = deriveContractFacts(profileList);
  const links = new Map<string, ClauseLink[]>(clauses.map((clause) => [clause.id, []]));
  if (options.enabled === false) return { profiles, contractFacts, links };

  const clauseById = new Map(clauses.map((clause) => [clause.id, clause]));
  const lexical = lexicalSimilarity(new Map(clauses.map((clause) => [clause.id, clause.text])));
  const similarity = (left: string, right: string) => {
    const leftVector = options.embeddings?.get(left);
    const rightVector = options.embeddings?.get(right);
    if (leftVector && rightVector) {
      const value = cosine(leftVector, rightVector);
      return value >= EMBEDDING_SIMILARITY_MIN ? (value - EMBEDDING_SIMILARITY_MIN) / (1 - EMBEDDING_SIMILARITY_MIN) : 0;
    }
    const value = lexical(left, right);
    return value >= LEXICAL_SIMILARITY_MIN ? (value - LEXICAL_SIMILARITY_MIN) / (1 - LEXICAL_SIMILARITY_MIN) : 0;
  };
  const label = (profile: ClauseProfile) => (profile.sectionLabel ? `סעיף ${profile.sectionLabel}` : "סעיף אחר");

  for (const focal of profileList) {
    const candidates = new Map<string, Candidate>();

    for (const other of profileList) {
      if (other.clauseId !== focal.clauseId && baseId(other.clauseId) === baseId(focal.clauseId)) {
        addCandidate(candidates, {
          clauseId: other.clauseId,
          relation: "SAME_SECTION",
          reason: "המשך של אותו סעיף בחוזה",
          score: RELATION_SCORE.SAME_SECTION,
          excerpt: truncate(clauseById.get(other.clauseId)!.text, SAME_SECTION_MAX_CHARS),
        });
      }
    }

    for (const reference of focal.references) {
      for (const target of clausesForLabel(reference.sectionLabel, profileList)) {
        if (target.clauseId === focal.clauseId) continue;
        const relation: ClauseRelation = reference.kind === "NOTWITHSTANDING" ? "OVERRIDES" : "REFERENCES";
        addCandidate(candidates, {
          clauseId: target.clauseId,
          relation,
          reason: reference.kind === "NOTWITHSTANDING"
            ? `הסעיף הזה גובר על ${label(target)}`
            : reference.kind === "SUBJECT_TO" ? `הסעיף הזה כפוף ל${label(target)}` : `הסעיף הזה מפנה ל${label(target)}`,
          score: RELATION_SCORE[relation],
          excerpt: truncate(clauseById.get(target.clauseId)!.text, EXCERPT_MAX_CHARS),
        });
      }
    }

    // Clauses that point at this one: the one that overrides it changes what it is worth.
    for (const other of profileList) {
      if (other.clauseId === focal.clauseId || !focal.sectionLabel) continue;
      const incoming = other.references.filter((reference) =>
        clausesForLabel(reference.sectionLabel, profileList).some((target) => target.clauseId === focal.clauseId));
      if (!incoming.length) continue;
      const overrides = incoming.some((reference) => reference.kind === "NOTWITHSTANDING");
      const relation: ClauseRelation = overrides ? "OVERRIDDEN_BY" : "REFERENCED_BY";
      addCandidate(candidates, {
        clauseId: other.clauseId,
        relation,
        reason: overrides ? `${label(other)} גובר על הסעיף הזה` : `${label(other)} מפנה לסעיף הזה`,
        score: RELATION_SCORE[relation],
        excerpt: sentencesAround(other, (sentence) => incoming.some((reference) => reference.sentence === sentence), EXCERPT_MAX_CHARS),
      });
    }

    for (const concept of focal.concepts.keys()) {
      const needs = NEEDS[concept];
      for (const kind of needs?.facts ?? []) {
        const fact = contractFacts[kind];
        if (!fact || fact.clauseId === focal.clauseId) continue;
        addCandidate(candidates, {
          clauseId: fact.clauseId,
          relation: "DEFINES_VALUE",
          reason: `מגדיר את ${FACT_NAMES[kind]}: ${formatFactValue(fact)}`,
          score: RELATION_SCORE.DEFINES_VALUE,
          excerpt: sentencesAround(profiles.get(fact.clauseId)!, (sentence) => sentence === fact.sentence, EXCERPT_MAX_CHARS),
        });
      }
      if (!focal.primaryConcepts.has(concept)) continue;
      for (const needed of needs?.concepts ?? []) {
        const target = bestClauseFor(needed, profileList, focal.clauseId);
        if (!target) continue;
        addCandidate(candidates, {
          clauseId: target.clauseId,
          relation: "RELATED_TOPIC",
          reason: `עוסק ב${CONCEPT_NAMES[needed]}, שמשפיע על הסעיף הזה`,
          score: RELATION_SCORE.RELATED_TOPIC,
          excerpt: sentencesAround(target, (sentence) => mentionsConcept(sentence, needed), EXCERPT_MAX_CHARS),
        });
      }
    }

    // Other clauses about the same main subject (two clauses on the guarantee, two on entry).
    for (const other of profileList) {
      if (other.clauseId === focal.clauseId) continue;
      const shared = [...focal.primaryConcepts].filter((concept) => other.primaryConcepts.has(concept) && concept !== "REPAIRS");
      if (!shared.length) continue;
      addCandidate(candidates, {
        clauseId: other.clauseId,
        relation: "RELATED_TOPIC",
        reason: `עוסק גם הוא ב${CONCEPT_NAMES[shared[0]!]}`,
        score: RELATION_SCORE.RELATED_TOPIC - 0.05,
        excerpt: truncate(clauseById.get(other.clauseId)!.text, EXCERPT_MAX_CHARS),
      });
    }

    for (const other of profileList) {
      if (other.clauseId === focal.clauseId) continue;
      const strength = similarity(focal.clauseId, other.clauseId);
      if (strength <= 0) continue;
      const existing = candidates.get(other.clauseId);
      if (existing) {
        existing.score = Math.min(1, existing.score + 0.1 * strength);
        continue;
      }
      candidates.set(other.clauseId, {
        clauseId: other.clauseId,
        relation: "SIMILAR_TEXT",
        reason: "עוסק בנושא דומה",
        score: RELATION_SCORE.SIMILAR_TEXT + 0.4 * strength,
        excerpt: truncate(clauseById.get(other.clauseId)!.text, EXCERPT_MAX_CHARS),
      });
    }

    links.set(focal.clauseId, selectLinks([...candidates.values()]));
  }
  return { profiles, contractFacts, links };
}
