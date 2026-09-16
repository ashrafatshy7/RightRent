import type { LawSourceStatus } from "../types/api";

export const LAW_STATUS_META: Record<LawSourceStatus, { label: string; description: string; tone: string }> = {
  ACTIVE: { label: "פעיל", description: "גרסה מאומתת שמשמשת לניתוח", tone: "success" },
  AWAITING_VERIFICATION: { label: "ממתין לאימות", description: "המועמד מוכן לבדיקה ולאישור", tone: "review" },
  OFFICIAL_UPDATE_PENDING: { label: "עדכון רשמי ממתין", description: "הכנסת השתנתה והנוסח המאוחד טרם הותאם", tone: "pending" },
  WIKISOURCE_CHANGED: { label: "שינוי לא תואם", description: "וויקיטקסט השתנה ללא שינוי מקביל בכנסת", tone: "warning" },
  FAILED: { label: "נכשל", description: "הסנכרון או בדיקת השלמות נכשלו", tone: "danger" },
};

export const LAW_STATUS_ORDER: LawSourceStatus[] = [
  "FAILED",
  "AWAITING_VERIFICATION",
  "OFFICIAL_UPDATE_PENDING",
  "WIKISOURCE_CHANGED",
  "ACTIVE",
];
