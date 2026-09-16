const dateFormatter = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" });
const numberFormatter = new Intl.NumberFormat("he-IL");
const currencyFormatter = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 });

export function formatDate(value: string | null | undefined) {
  if (!value) return "לא זמין";
  return dateFormatter.format(new Date(value));
}

export function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : numberFormatter.format(value);
}

export function formatCurrency(value: number) {
  return currencyFormatter.format(value);
}

export function formatDuration(milliseconds: number) {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} מ״ש` : `${(milliseconds / 1_000).toFixed(1)} שנ׳`;
}

export function shortHash(value: string | null | undefined) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
}
