export type MonitoredLawSource = {
  israelLawId: number;
  wikisourceTitle: string;
};

// Source identifiers only. Statutory text is always fetched at runtime and is never kept here.
export const MONITORED_LAW_SOURCES: readonly MonitoredLawSource[] = [
  { israelLawId: 2_000_596, wikisourceTitle: "חוק השכירות והשאילה" },
  { israelLawId: 2_000_292, wikisourceTitle: "חוק החוזים (חלק כללי)" },
  { israelLawId: 2_000_293, wikisourceTitle: "חוק החוזים (תרופות בשל הפרת חוזה)" },
  { israelLawId: 2_000_390, wikisourceTitle: "חוק המכר" },
  { israelLawId: 2_000_416, wikisourceTitle: "חוק המקרקעין" },
  { israelLawId: 2_000_489, wikisourceTitle: "חוק הערבות" },
  { israelLawId: 2_000_295, wikisourceTitle: "חוק החוזים האחידים" },
  { israelLawId: 2_000_428, wikisourceTitle: "חוק המתווכים במקרקעין" },
  { israelLawId: 2_000_230, wikisourceTitle: "חוק הגנת הדייר" },
  { israelLawId: 2_001_155, wikisourceTitle: "חוק עשיית עושר ולא במשפט" },
  { israelLawId: 2_001_168, wikisourceTitle: "חוק פסיקת ריבית והצמדה" },
  { israelLawId: 2_000_237, wikisourceTitle: "חוק הגנת הצרכן" },
  { israelLawId: 2_000_633, wikisourceTitle: "חוק זכויות הדייר בדיור הציבורי" },
];
