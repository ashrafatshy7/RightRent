import { HttpError } from "../../shared/http/http-error.js";
import { CURRENT_RENTAL_LAW_SECTIONS } from "./rental-law.snapshot.js";
import type { RentalLawClause } from "./rental-law.types.js";

export type { RentalLawClause } from "./rental-law.types.js";

const ISRAEL_LAW_ID = 2_000_596;
const FUTURE_GUARANTEE_EFFECTIVE_DATE = "2026-09-30";
const LATEST_SUPPORTED_PUBLICATION_DATE = "2026-03-31";

const KNESSET_LAW_URL = `https://main.knesset.gov.il/apps/legislation/main/laws/${ISRAEL_LAW_ID}`;
const KNESSET_ODATA_BASE_URL = "https://knesset.gov.il/Odata/ParliamentInfo.svc";
const KNESSET_LAW_ODATA_URL = `${KNESSET_ODATA_BASE_URL}/KNS_IsraelLaw(${ISRAEL_LAW_ID})?$format=json`;
const KNESSET_BINDINGS_ODATA_URL = `${KNESSET_ODATA_BASE_URL}/KNS_LawBinding?$format=json&$filter=IsraelLawID%20eq%20${ISRAEL_LAW_ID}&$orderby=LawBindingID`;

const OFFICIAL_DOCUMENTS = [
  {
    lawId: 148_733,
    kind: "original",
    publicationDate: "1971-08-05",
    url: "https://fs.knesset.gov.il/7/law/7_lsr_209679.PDF",
  },
  {
    lawId: 2_006_776,
    kind: "amendment-1",
    publicationDate: "2017-07-19",
    url: "https://fs.knesset.gov.il/20/law/20_lsr_389390.pdf",
  },
  {
    lawId: 2_199_304,
    kind: "amendment-2",
    publicationDate: "2023-02-09",
    url: "https://fs.knesset.gov.il/25/law/25_lsr_1783627.pdf",
  },
  {
    lawId: 1_046_680,
    kind: "amendment-3",
    publicationDate: "2026-03-31",
    effectiveDate: FUTURE_GUARANTEE_EFFECTIVE_DATE,
    url: "https://fs.knesset.gov.il/25/law/25_lsr_12846788.pdf",
  },
] as const;

const SUPPORTED_BINDINGS = [
  { lawBindingId: 45_966, lawId: 148_733, bindingType: 6_012 },
  { lawBindingId: 56_263, lawId: 2_006_776, bindingType: 6_013 },
  { lawBindingId: 66_078, lawId: 2_199_304, bindingType: 6_013 },
  { lawBindingId: 67_580, lawId: 1_046_680, bindingType: 6_013 },
] as const;

type KnessetLaw = {
  IsraelLawID: number;
  Name: string;
  PublicationDate: string;
  LatestPublicationDate: string;
  LawValidityDesc: string;
};

export type KnessetLawBinding = {
  LawBindingID: number;
  LawID: number;
  IsraelLawID: number;
  BindingType: number;
};

type ODataCollection<T> = {
  value: T[];
};

function israelDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function cloneSections() {
  return structuredClone(CURRENT_RENTAL_LAW_SECTIONS);
}

function applyGuaranteeAmendment(sections: RentalLawClause[]) {
  const guarantee = sections.find((section) => section.number === "25י");
  const definitions = guarantee?.children.find((section) => section.number === "(א)");
  const limit = guarantee?.children.find((section) => section.number === "(ב)");
  if (!guarantee || !definitions || !limit) {
    throw new Error("The supported rental-law snapshot is missing section 25י.");
  }

  definitions.content = "בסעיף זה – ”נותן ערבות אחר“ – בעל רישיון למתן אשראי, בעל רישיון למתן שירותי פיקדון ואשראי, בעל רישיון נותן שירותי תשלום יציבותי או מבטח; לעניין הגדרה זו – ”בעל רישיון נותן שירותי תשלום יציבותי“ – מי שבידו רישיון נותן תשלום יציבותי כהגדרתו בסעיף 36ט לחוק הבנקאות (רישוי), התשמ״א–1981; ”מבטח“ – כהגדרתו בחוק הפיקוח על שירותים פיננסיים (ביטוח), התשמ״א–1981; ”רישיון למתן אשראי“ ו”רישיון למתן שירותי פיקדון ואשראי“ – כהגדרתם בחוק הפיקוח על שירותים פיננסיים (שירותים פיננסיים מוסדרים), התשע״ו–2016; ”ערובה“ – ערובה לשם הבטחת חיובי השוכר הנובעים מחוזה השכירות למגורים.";
  limit.content = limit.content.replace(
    "ערבות בנקאית או מזומן",
    "ערבות בנקאית, ערבות מנותן ערבות אחר או מזומן",
  );
}

export function buildRentalLawSections(asOf: string) {
  const sections = cloneSections();
  if (asOf >= FUTURE_GUARANTEE_EFFECTIVE_DATE) applyGuaranteeAmendment(sections);
  return sections;
}

export function assertSupportedKnessetVersion(law: KnessetLaw, bindings: KnessetLawBinding[]) {
  if (law.IsraelLawID !== ISRAEL_LAW_ID || law.LawValidityDesc !== "תקף") {
    throw new HttpError(
      503,
      "RENTAL_LAW_NOT_VALID",
      "The rental law is not currently marked as valid by the Knesset.",
    );
  }

  const latestPublicationDate = law.LatestPublicationDate.slice(0, 10);
  const actual = bindings
    .map(({ LawBindingID, LawID, IsraelLawID, BindingType }) => ({
      lawBindingId: LawBindingID,
      lawId: LawID,
      israelLawId: IsraelLawID,
      bindingType: BindingType,
    }))
    .sort((left, right) => left.lawBindingId - right.lawBindingId);
  const expected = SUPPORTED_BINDINGS.map(({ lawBindingId, lawId, bindingType }) => ({
    lawBindingId,
    lawId,
    israelLawId: ISRAEL_LAW_ID,
    bindingType,
  })).sort((left, right) => left.lawBindingId - right.lawBindingId);

  if (latestPublicationDate !== LATEST_SUPPORTED_PUBLICATION_DATE
    || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new HttpError(
      503,
      "RENTAL_LAW_REVIEW_REQUIRED",
      "The Knesset published a rental-law version that has not been consolidated by this service yet.",
      {
        latestPublicationDate,
        expectedLawBindingIds: expected.map(({ lawBindingId }) => lawBindingId),
        actualLawBindingIds: actual.map(({ lawBindingId }) => lawBindingId),
      },
    );
  }
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RightRent/0.1 law-reader" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function getCurrentRentalLaw() {
  const asOf = israelDate();

  try {
    const [law, bindingResponse] = await Promise.all([
      fetchJson<KnessetLaw>(KNESSET_LAW_ODATA_URL),
      fetchJson<ODataCollection<KnessetLawBinding>>(KNESSET_BINDINGS_ODATA_URL),
    ]);
    assertSupportedKnessetVersion(law, bindingResponse.value);

    const sections = buildRentalLawSections(asOf);
    return {
      israelLawId: ISRAEL_LAW_ID,
      name: law.Name,
      status: law.LawValidityDesc,
      asOf,
      publicationDate: law.PublicationDate,
      latestOfficialPublicationDate: law.LatestPublicationDate,
      mainSectionCount: sections.filter((section) => /^\d+[א-ת]{0,2}$/u.test(section.number)).length,
      appendixCount: sections.filter((section) => section.number.startsWith("תוספת ")).length,
      sources: {
        officialMetadata: KNESSET_LAW_URL,
        officialOData: {
          law: KNESSET_LAW_ODATA_URL,
          bindings: KNESSET_BINDINGS_ODATA_URL,
        },
        officialPublications: OFFICIAL_DOCUMENTS,
      },
      sections,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "RENTAL_LAW_SOURCE_FAILED", "The current rental law could not be retrieved.", {
      reason: error instanceof Error ? error.message : "Unknown upstream error",
    });
  }
}
