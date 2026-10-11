import { describe, expect, test } from "vitest";
import { firstLocation, lineBoxesByPage, toScreenRect } from "../lib/highlight-geometry";
import { clauseLabel } from "../lib/format";

describe("contract highlight geometry", () => {
  test("word boxes on the same printed line merge into one stroke, other lines stay separate", () => {
    const boxes = lineBoxesByPage([
      { page: 1, bbox: [300, 700, 60, 11] },
      { page: 1, bbox: [200, 700.4, 90, 11] },
      { page: 1, bbox: [250, 686, 110, 11] },
      { page: 2, bbox: [100, 780, 40, 11] },
    ]);
    const [firstLine, secondLine] = boxes.get(1)!;
    expect(firstLine!.slice(0, 3)).toEqual([200, 700, 160]);
    expect(firstLine![3]).toBeCloseTo(11.4);
    expect(secondLine).toEqual([250, 686, 110, 11]);
    expect(boxes.get(1)).toHaveLength(2);
    expect(boxes.get(2)).toEqual([[100, 780, 40, 11]]);
  });

  test("PDF boxes map to top-left CSS pixels through the viewport transform", () => {
    // pdf.js transform for an unrotated 600x800 page at scale 1.5: y is flipped.
    const transform = [1.5, 0, 0, -1.5, 0, 1_200];
    const rect = toScreenRect([100, 700, 50, 10], transform, 0);
    expect(rect.left).toBeCloseTo(150);
    expect(rect.width).toBeCloseTo(75);
    // The top of the box (y = 710) is 1200 - 1065 = 135px from the top of the page, and the box
    // extends below the baseline to cover descenders.
    expect(rect.top).toBeCloseTo(135);
    expect(rect.height).toBeCloseTo(15 * 1.22);
  });

  test("a rotated page is handled by the same transform without special cases", () => {
    // 90-degree rotation: x' = y * s, y' = x * s.
    const rect = toScreenRect([100, 200, 50, 10], [0, 1, 1, 0, 0, 0], 0);
    expect(rect.left).toBeCloseTo(197.8);
    expect(rect.top).toBeCloseTo(100);
    expect(rect.width).toBeCloseTo(12.2);
    expect(rect.height).toBeCloseTo(50);
  });

  test("the scroll target is the clause's first page and its highest line", () => {
    expect(firstLocation([
      { page: 2, bbox: [0, 790, 10, 10] },
      { page: 1, bbox: [0, 300, 10, 10] },
      { page: 1, bbox: [0, 650, 10, 10] },
    ])).toEqual({ page: 1, bbox: [0, 650, 10, 10] });
    expect(firstLocation([])).toBeNull();
  });

  test("clauses are labelled with the contract's own numbering when it is known", () => {
    expect(clauseLabel({ clauseId: "C010", sectionLabel: "9", heading: "בטוחות" })).toBe("סעיף 9 · בטוחות");
    expect(clauseLabel({ clauseId: "C006", sectionLabel: "5" })).toBe("סעיף 5");
    expect(clauseLabel({ clauseId: "C001" })).toBe("C001");
  });
});
