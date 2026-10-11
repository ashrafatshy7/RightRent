import type { ContractClause } from "../../domain/models.js";

// Matches the clauses of two versions of a contract. Clause IDs are positional (a clause inserted in
// the middle renumbers everything after it), so clauses are matched by content: identical text
// first, then the best overall assignment by similarity, then sections that were split or merged.
// Everything runs locally on the stored text; nothing is sent anywhere.

export type AlignmentChange = "UNCHANGED" | "MODIFIED" | "ADDED" | "REMOVED" | "SPLIT" | "MERGED";

export type ClauseAlignment = {
  change: AlignmentChange;
  before: string[];
  after: string[];
  // The clause sits elsewhere relative to the clauses around it.
  moved: boolean;
  // The only difference is section references renumbered by an inserted or removed clause
  // ("בכפוף לסעיף 8" -> "בכפוף לסעיף 9" when old section 8 is now section 9).
  renumberedOnly?: boolean;
  similarity: number;
};

const SECTION_REFERENCE = /(סעי(?:ף|פים|פי)\s+)((?:\d{1,3}(?:\.\d{1,3})*)(?:\s*(?:,|ו-?|-|עד)\s*\d{1,3}(?:\.\d{1,3})*)*)/gu;

// Rewrites the section numbers a clause refers to with `labels` (new number -> old number).
function remapReferences(text: string, labels: ReadonlyMap<string, string>) {
  return text.replace(SECTION_REFERENCE, (_match, prefix: string, list: string) =>
    prefix + list.replace(/\d{1,3}(?:\.\d{1,3})*/gu, (label) => {
      const [main, ...rest] = label.split(".");
      const mapped = labels.get(label) ?? (main && labels.has(main) ? [labels.get(main), ...rest].join(".") : undefined);
      return mapped ?? label;
    }));
}

// A pair is the same clause, revised, at or above this similarity; part of a split or merge when
// this share of its text is contained in the other side.
export const MATCH_THRESHOLD = 0.45;
export const CONTAINMENT_THRESHOLD = 0.7;

// The clause number at the start is dropped (it changes when clauses are inserted), and Hebrew
// gershayim/geresh and quote variants are unified.
export function normalizeClauseText(text: string) {
  return text
    .replace(/^\s*(?:סעיף\s+)?\d{1,3}(?:\.\d{1,3})*\s*[.)\-:]?\s*/u, "")
    .replace(/[״”“]/gu, "\"")
    .replace(/[׳’‘]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function trigrams(text: string) {
  const compact = text.replace(/\s+/gu, "");
  const grams = new Map<string, number>();
  for (let index = 0; index + 3 <= compact.length; index += 1) {
    const gram = compact.slice(index, index + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function overlap(left: Map<string, number>, right: Map<string, number>) {
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return shared;
}

function size(grams: Map<string, number>) {
  let total = 0;
  for (const count of grams.values()) total += count;
  return total;
}

function words(text: string) {
  return new Set(text.split(/\s+/u).map((word) => word.replace(/[^\p{L}\p{N}]/gu, "")).filter((word) => word.length > 1));
}

type Prepared = { id: string; text: string; grams: Map<string, number>; words: Set<string>; heading: string | undefined; position: number };

function prepare(clauses: ContractClause[]): Prepared[] {
  return clauses.map((clause, index) => {
    const text = normalizeClauseText(clause.text);
    return {
      id: clause.id,
      text,
      grams: trigrams(text),
      words: words(text),
      heading: clause.heading,
      position: clauses.length > 1 ? index / (clauses.length - 1) : 0,
    };
  });
}

// Character-trigram Dice (robust to small edits and to Hebrew prefixes), word overlap, an equal
// heading, and a small preference for the same relative position.
function similarity(left: Prepared, right: Prepared) {
  const dice = (2 * overlap(left.grams, right.grams)) / Math.max(1, size(left.grams) + size(right.grams));
  const sharedWords = [...left.words].filter((word) => right.words.has(word)).length;
  const jaccard = sharedWords / Math.max(1, new Set([...left.words, ...right.words]).size);
  const heading = left.heading && right.heading && left.heading === right.heading ? 1 : 0;
  return 0.6 * dice + 0.25 * jaccard + 0.1 * heading + 0.05 * (1 - Math.abs(left.position - right.position));
}

// How much of `part` appears in `whole`.
function containment(part: Prepared, whole: Prepared) {
  return overlap(part.grams, whole.grams) / Math.max(1, size(part.grams));
}

// Minimum-cost assignment (Hungarian algorithm, O(n³)); contracts have at most a few hundred clauses.
export function assign(cost: number[][]): number[] {
  const rows = cost.length;
  const columns = rows ? cost[0]!.length : 0;
  const n = Math.max(rows, columns);
  const at = (row: number, column: number) => (row < rows && column < columns ? cost[row]![column]! : 1);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const match = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let row = 1; row <= n; row += 1) {
    match[0] = row;
    let column0 = 0;
    const minimum = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = match[column0]!;
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= n; column += 1) {
        if (used[column]) continue;
        const current = at(row0 - 1, column - 1) - u[row0]! - v[column]!;
        if (current < minimum[column]!) {
          minimum[column] = current;
          way[column] = column0;
        }
        if (minimum[column]! < delta) {
          delta = minimum[column]!;
          column1 = column;
        }
      }
      for (let column = 0; column <= n; column += 1) {
        if (used[column]) {
          u[match[column]!] = u[match[column]!]! + delta;
          v[column] = v[column]! - delta;
        } else {
          minimum[column] = minimum[column]! - delta;
        }
      }
      column0 = column1;
    } while (match[column0] !== 0);
    do {
      const column1 = way[column0]!;
      match[column0] = match[column1]!;
      column0 = column1;
    } while (column0);
  }
  const result = new Array<number>(rows).fill(-1);
  for (let column = 1; column <= n; column += 1) {
    const row = match[column]! - 1;
    if (row >= 0 && row < rows && column - 1 < columns) result[row] = column - 1;
  }
  return result;
}

// Indexes (into `sequence`) of a longest strictly increasing subsequence.
function longestIncreasing(sequence: number[]) {
  const tails: number[] = [];
  const previous = new Array<number>(sequence.length).fill(-1);
  for (let index = 0; index < sequence.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sequence[tails[middle]!]! < sequence[index]!) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const kept = new Set<number>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) kept.add(index);
  return kept;
}

export function alignClauses(beforeClauses: ContractClause[], afterClauses: ContractClause[]): ClauseAlignment[] {
  const before = prepare(beforeClauses);
  const after = prepare(afterClauses);
  const pairOf = new Map<number, { after: number; similarity: number; exact: boolean }>();
  const usedAfter = new Set<number>();

  // 1. Identical text (after normalization), first come first served for repeated text.
  const byText = new Map<string, number[]>();
  after.forEach((clause, index) => byText.set(clause.text, [...(byText.get(clause.text) ?? []), index]));
  before.forEach((clause, index) => {
    const candidates = byText.get(clause.text);
    const match = candidates?.find((candidate) => !usedAfter.has(candidate));
    if (match === undefined) return;
    pairOf.set(index, { after: match, similarity: 1, exact: true });
    usedAfter.add(match);
  });

  // 2. The best overall assignment of the remaining clauses by similarity.
  const restBefore = before.map((_, index) => index).filter((index) => !pairOf.has(index));
  const restAfter = after.map((_, index) => index).filter((index) => !usedAfter.has(index));
  if (restBefore.length && restAfter.length) {
    const scores = restBefore.map((left) => restAfter.map((right) => similarity(before[left]!, after[right]!)));
    assign(scores.map((row) => row.map((score) => 1 - score))).forEach((column, row) => {
      if (column < 0) return;
      const score = scores[row]![column]!;
      const left = restBefore[row]!;
      const right = restAfter[column]!;
      // A short clause that is wholly contained in its counterpart is still the same clause.
      const contained = Math.max(containment(before[left]!, after[right]!), containment(after[right]!, before[left]!));
      if (score >= MATCH_THRESHOLD || contained >= CONTAINMENT_THRESHOLD + 0.15) {
        pairOf.set(left, { after: right, similarity: score, exact: false });
        usedAfter.add(right);
      }
    });
  }

  // 3. A section split in two (one old clause, two new) or two merged into one: an unmatched clause
  // whose text is largely contained in a neighbour's counterpart joins that pair.
  const splits = new Map<number, number[]>();
  const merges = new Map<number, number[]>();
  const afterToBefore = new Map([...pairOf].map(([left, pair]) => [pair.after, left]));
  for (const right of after.map((_, index) => index).filter((index) => !usedAfter.has(index))) {
    const owner = [...pairOf].find(([left, pair]) => Math.abs(pair.after - right) === 1
      && containment(after[right]!, before[left]!) >= CONTAINMENT_THRESHOLD);
    if (!owner) continue;
    splits.set(owner[0], [...(splits.get(owner[0]) ?? []), right]);
    usedAfter.add(right);
  }
  const mergedBefore = new Set<number>();
  for (const left of before.map((_, index) => index).filter((index) => !pairOf.has(index))) {
    const owner = [...afterToBefore].find(([right, otherLeft]) => Math.abs(otherLeft - left) === 1
      && containment(before[left]!, after[right]!) >= CONTAINMENT_THRESHOLD);
    if (!owner) continue;
    merges.set(owner[1], [...(merges.get(owner[1]) ?? []), left]);
    mergedBefore.add(left);
  }

  // 4. Clauses whose order relative to the others changed: matched pairs outside the longest run
  // that keeps the old order.
  const matchedBefore = [...pairOf.keys()].sort((left, right) => left - right);
  const inOrder = longestIncreasing(matchedBefore.map((left) => pairOf.get(left)!.after));
  const moved = new Set(matchedBefore.filter((_, index) => !inOrder.has(index)));

  // How the contract's own section numbers moved, for telling a renumbered reference from a real edit.
  const newToOldLabel = new Map<string, string>();
  for (const [left, pair] of pairOf) {
    const oldLabel = beforeClauses[left]!.sectionLabel;
    const newLabel = afterClauses[pair.after]!.sectionLabel;
    if (oldLabel && newLabel) newToOldLabel.set(newLabel, oldLabel);
  }
  const alignments: Array<ClauseAlignment & { order: number }> = [];
  for (const [left, pair] of pairOf) {
    const splitInto = splits.get(left) ?? [];
    const mergedFrom = merges.get(left) ?? [];
    const afterIds = [pair.after, ...splitInto].sort((a, b) => a - b).map((index) => after[index]!.id);
    const beforeIds = [left, ...mergedFrom].sort((a, b) => a - b).map((index) => before[index]!.id);
    const renumberedOnly = !pair.exact && !splitInto.length && !mergedFrom.length
      && normalizeClauseText(remapReferences(afterClauses[pair.after]!.text, newToOldLabel)) === before[left]!.text;
    alignments.push({
      change: splitInto.length ? "SPLIT" : mergedFrom.length ? "MERGED" : pair.exact || renumberedOnly ? "UNCHANGED" : "MODIFIED",
      before: beforeIds,
      after: afterIds,
      moved: moved.has(left),
      ...(renumberedOnly ? { renumberedOnly: true } : {}),
      similarity: Math.round(pair.similarity * 1000) / 1000,
      order: pair.after,
    });
  }
  for (const left of before.map((_, index) => index)) {
    if (pairOf.has(left) || mergedBefore.has(left)) continue;
    // A removed clause is listed where it used to be, just before the next surviving clause.
    const nextSurvivor = [...pairOf].filter(([other]) => other > left).sort(([a], [b]) => a - b)[0];
    alignments.push({ change: "REMOVED", before: [before[left]!.id], after: [], moved: false, similarity: 0, order: (nextSurvivor?.[1].after ?? after.length) - 0.5 });
  }
  for (const right of after.map((_, index) => index)) {
    if (usedAfter.has(right)) continue;
    alignments.push({ change: "ADDED", before: [], after: [after[right]!.id], moved: false, similarity: 0, order: right });
  }
  return alignments
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...alignment }) => alignment);
}

export type DiffPart = { op: "equal" | "insert" | "delete"; text: string };

// Word-level diff (longest common subsequence over words and punctuation), merged into runs.
export function wordDiff(beforeText: string, afterText: string): DiffPart[] {
  const tokenize = (text: string) => normalizeClauseText(text).match(/\s+|[\p{L}\p{N}"'״׳,.%₪/-]+|[^\s]/gu) ?? [];
  const left = tokenize(beforeText);
  const right = tokenize(afterText);
  const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    const last = parts.at(-1);
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push("equal", left[i]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push("delete", left[i]!);
      i += 1;
    } else {
      push("insert", right[j]!);
      j += 1;
    }
  }
  while (i < left.length) push("delete", left[i++]!);
  while (j < right.length) push("insert", right[j++]!);
  return parts;
}

// Numbers whose value changed between the versions ("30,000" -> "21,000", "24 שעות" -> "שעה").
export function numberChanges(parts: DiffPart[]) {
  const numbers = (text: string) => text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/gu) ?? [];
  const changes: Array<{ before: string; after: string }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.op !== "delete") continue;
    const next = parts[index + 1];
    const removed = numbers(part.text);
    const added = next?.op === "insert" ? numbers(next.text) : [];
    removed.forEach((value, position) => {
      const replacement = added[position];
      if (replacement !== undefined && replacement !== value) changes.push({ before: value, after: replacement });
    });
  }
  return changes;
}
