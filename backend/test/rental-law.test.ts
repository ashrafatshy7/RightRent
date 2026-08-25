import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSupportedKnessetVersion,
  buildRentalLawSections,
  type KnessetLawBinding,
} from "../src/modules/law/rental-law.service.js";
import { HttpError } from "../src/shared/http/http-error.js";

const law = {
  IsraelLawID: 2_000_596,
  Name: "חוק השכירות והשאילה, התשל\"א-1971",
  PublicationDate: "1971-08-05T00:00:00",
  LatestPublicationDate: "2026-03-31T14:19:00",
  LawValidityDesc: "תקף",
};

const bindings: KnessetLawBinding[] = [
  { LawBindingID: 45_966, LawID: 148_733, IsraelLawID: 2_000_596, BindingType: 6_012 },
  { LawBindingID: 56_263, LawID: 2_006_776, IsraelLawID: 2_000_596, BindingType: 6_013 },
  { LawBindingID: 66_078, LawID: 2_199_304, IsraelLawID: 2_000_596, BindingType: 6_013 },
  { LawBindingID: 67_580, LawID: 1_046_680, IsraelLawID: 2_000_596, BindingType: 6_013 },
];

test("current rental law contains the complete supported Knesset consolidation", () => {
  const sections = buildRentalLawSections("2026-08-25");
  const serialized = JSON.stringify(sections);

  assert.equal(sections.filter((section) => /^\d+[א-ת]{0,2}$/u.test(section.number)).length, 51);
  assert.equal(sections.filter((section) => section.number.startsWith("תוספת ")).length, 2);
  assert.equal(sections.some((section) => section.number === "33"), false);
  assert.deepEqual(
    sections.find((section) => section.number === "19")?.children.map((child) => child.number),
    ["(א)"],
  );
  assert.match(serialized, /ועדת הפנים והגנת הסביבה/u);
  assert.equal(serialized.includes("נותן ערבות אחר"), false);
  assert.match(serialized, /ערבות בנקאית או מזומן/u);
});

test("the 2026 Knesset amendment activates only on its effective date", () => {
  const future = JSON.stringify(buildRentalLawSections("2026-09-30"));
  const current = JSON.stringify(buildRentalLawSections("2026-08-25"));

  assert.match(future, /נותן ערבות אחר/u);
  assert.match(future, /ערבות בנקאית, ערבות מנותן ערבות אחר או מזומן/u);
  assert.equal(current.includes("נותן ערבות אחר"), false);
});

test("known Knesset bindings are accepted", () => {
  assert.doesNotThrow(() => assertSupportedKnessetVersion(law, bindings));
});

test("an unknown Knesset amendment fails closed instead of serving stale law", () => {
  const changed = [
    ...bindings,
    { LawBindingID: 99_999, LawID: 9_999_999, IsraelLawID: 2_000_596, BindingType: 6_013 },
  ];

  assert.throws(
    () => assertSupportedKnessetVersion(
      { ...law, LatestPublicationDate: "2027-01-01T00:00:00" },
      changed,
    ),
    (error) => error instanceof HttpError
      && error.status === 503
      && error.code === "RENTAL_LAW_REVIEW_REQUIRED",
  );
});
