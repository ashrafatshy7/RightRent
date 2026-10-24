import type { LawSourceStatus } from "../types/api";

export const LAW_STATUS_META: Record<LawSourceStatus, { label: string; description: string; tone: string }> = {
  ACTIVE: { label: "פעיל", description: "גרסה מאומתת שמשמשת לניתוח", tone: "success" },
  AWAITING_VERIFICATION: { label: "ממתין לאימות", description: "גרסה חדשה מוכנה לבדיקה ולאישור", tone: "review" },
  OFFICIAL_UPDATE_PENDING: { label: "עדכון רשמי ממתין", description: "פורסם תיקון בכנסת, והנוסח המאוחד עוד לא עודכן", tone: "pending" },
  WIKISOURCE_CHANGED: { label: "שינוי לא תואם", description: "הנוסח בוויקיטקסט השתנה בלי תיקון מקביל בכנסת", tone: "warning" },
  FAILED: { label: "נכשל", description: "בדיקת העדכונים או בדיקת השלמות נכשלה", tone: "danger" },
};

export const LAW_STATUS_ORDER: LawSourceStatus[] = [
  "FAILED",
  "AWAITING_VERIFICATION",
  "OFFICIAL_UPDATE_PENDING",
  "WIKISOURCE_CHANGED",
  "ACTIVE",
];
