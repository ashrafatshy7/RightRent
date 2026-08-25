import { createHash } from "node:crypto";
import type { MonitoredLawSource } from "./law-source.catalog.js";

const KNESSET_ODATA_BASE_URL = "https://knesset.gov.il/Odata/ParliamentInfo.svc/";

export type KnessetLaw = {
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

type ODataCollection<T> = { value: T[] };

export type OfficialLawState = {
  law: KnessetLaw;
  bindings: KnessetLawBinding[];
  fingerprint: string;
  bindingIds: number[];
  amendingLawIds: number[];
  knessetUrl: string;
};

async function fetchJson<T>(url: URL) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RightRent/0.1 law-monitor" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Knesset OData returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

export function createOfficialFingerprint(law: KnessetLaw, bindings: KnessetLawBinding[]) {
  const normalizedBindings = bindings
    .map(({ LawBindingID, LawID, IsraelLawID, BindingType }) => ({
      LawBindingID,
      LawID,
      IsraelLawID,
      BindingType,
    }))
    .sort((left, right) => left.LawBindingID - right.LawBindingID);
  return createHash("sha256").update(JSON.stringify({
    IsraelLawID: law.IsraelLawID,
    Name: law.Name,
    PublicationDate: law.PublicationDate,
    LatestPublicationDate: law.LatestPublicationDate,
    LawValidityDesc: law.LawValidityDesc,
    bindings: normalizedBindings,
  })).digest("hex");
}

export async function fetchOfficialLawState(source: MonitoredLawSource): Promise<OfficialLawState> {
  const lawUrl = new URL(`KNS_IsraelLaw(${source.israelLawId})`, KNESSET_ODATA_BASE_URL);
  lawUrl.searchParams.set("$format", "json");
  const bindingsUrl = new URL("KNS_LawBinding", KNESSET_ODATA_BASE_URL);
  bindingsUrl.searchParams.set("$format", "json");
  bindingsUrl.searchParams.set("$filter", `IsraelLawID eq ${source.israelLawId}`);
  bindingsUrl.searchParams.set("$orderby", "LawBindingID");

  const [law, response] = await Promise.all([
    fetchJson<KnessetLaw>(lawUrl),
    fetchJson<ODataCollection<KnessetLawBinding>>(bindingsUrl),
  ]);
  if (law.IsraelLawID !== source.israelLawId) {
    throw new Error(`Knesset returned IsraelLawID ${law.IsraelLawID} for ${source.israelLawId}.`);
  }
  if (law.LawValidityDesc !== "תקף") {
    throw new Error(`${law.Name} is not marked as valid by the Knesset.`);
  }

  const bindings = response.value
    .filter((binding) => binding.IsraelLawID === source.israelLawId)
    .sort((left, right) => left.LawBindingID - right.LawBindingID);
  return {
    law,
    bindings,
    fingerprint: createOfficialFingerprint(law, bindings),
    bindingIds: bindings.map((binding) => binding.LawBindingID),
    amendingLawIds: bindings
      .filter((binding) => binding.BindingType === 6_013)
      .map((binding) => binding.LawID),
    knessetUrl: `https://main.knesset.gov.il/apps/legislation/main/laws/${source.israelLawId}`,
  };
}
