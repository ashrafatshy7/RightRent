import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, CalendarPlus, Cat, DoorOpen, Handshake, Home, MessageSquareText, Save, ShieldCheck, Sofa, TrendingUp, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { api, messageForError } from "../lib/api-client";
import { formatCurrency } from "../lib/format";
import type { AcceptedSecurityKind, TenantPreferences } from "../types/api";

const SECURITY_OPTIONS: Array<{ kind: AcceptedSecurityKind; label: string }> = [
  { kind: "BANK_GUARANTEE", label: "ערבות בנקאית" },
  { kind: "CASH_DEPOSIT", label: "פיקדון (מזומן או צ'ק)" },
  { kind: "PROMISSORY_NOTE", label: "שטר חוב" },
  { kind: "GUARANTOR", label: "ערב" },
];

const NOTES_MAX_LENGTH = 500;

export function PreferencesPage() {
  const { token, user, updateUser } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["preferences"], queryFn: () => api.getPreferences(token!) });
  const [form, setForm] = useState<TenantPreferences | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (query.data) setForm(query.data.preferences); }, [query.data]);
  const mutation = useMutation({
    mutationFn: (preferences: TenantPreferences) => api.updatePreferences(token!, preferences),
    onSuccess: ({ preferences }) => {
      setForm(preferences);
      if (user) updateUser({ ...user, preferences });
      queryClient.setQueryData(["preferences"], { preferences });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2_000);
    },
  });

  if (query.isLoading || !form) return <LoadingState label="טוענים את ההעדפות" />;
  if (query.error) return <ErrorNotice message={messageForError(query.error)} />;
  const set = <K extends keyof TenantPreferences>(key: K, value: TenantPreferences[K]) => setForm((current) => current ? { ...current, [key]: value } : current);
  const toggleSecurity = (kind: AcceptedSecurityKind, accepted: boolean) => set(
    "acceptedSecurityKinds",
    SECURITY_OPTIONS.map((option) => option.kind).filter((candidate) => candidate === kind ? accepted : form.acceptedSecurityKinds.includes(candidate)),
  );
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(form); };

  return (
    <div className="page-wrap narrow-page">
      <PageHeader eyebrow="ההתאמה האישית" title="מה חשוב לך בבית הבא?" description="אנחנו משווים את החוזה גם לחוק וגם לקווים האדומים האישיים שלך." />
      <form className="preferences-form" onSubmit={submit}>
        {mutation.error ? <ErrorNotice message={messageForError(mutation.error)} /> : null}
        <section className="preference-section">
          <div className="preference-title"><span><Banknote size={21} /></span><div><h2>תקציב ותנאים</h2><p>המספרים שנרצה לראות בחוזה</p></div></div>
          <div className="form-grid">
            <label className="field-label">שכר דירה חודשי מרבי <span className="input-with-suffix"><input type="number" min="0" max="1000000" value={form.maxMonthlyRentIls} onChange={(event) => set("maxMonthlyRentIls", Number(event.target.value))} /><b>₪</b></span><small>{formatCurrency(form.maxMonthlyRentIls)} לחודש</small></label>
            <label className="field-label">תקציב חודשי כולל <span className="input-with-suffix"><input type="number" min="0" max="1000000" placeholder="לא חובה" value={form.maxMonthlyTotalCostIls ?? ""} onChange={(event) => set("maxMonthlyTotalCostIls", event.target.value === "" ? null : Number(event.target.value))} /><b>₪</b></span><small>{form.maxMonthlyTotalCostIls === null ? "שכר דירה יחד עם ארנונה, ועד בית ושאר התשלומים השוטפים" : `${formatCurrency(form.maxMonthlyTotalCostIls)} לחודש, כולל תשלומים שוטפים`}</small></label>
            <label className="field-label">עלייה שנתית מרבית <span className="input-with-suffix"><input type="number" min="0" max="100" step="0.5" value={form.maxAnnualRentIncreasePercent} onChange={(event) => set("maxAnnualRentIncreasePercent", Number(event.target.value))} /><b>%</b></span></label>
            <label className="field-label">משך חוזה רצוי <span className="input-with-suffix"><input type="number" min="1" max="120" value={form.leaseLengthMonths} onChange={(event) => set("leaseLengthMonths", Number(event.target.value))} /><b>חודשים</b></span></label>
            <label className="field-label">זמן מרבי לתיקון תקלה דחופה<select value={form.repairUrgencyHours} onChange={(event) => set("repairUrgencyHours", Number(event.target.value) as TenantPreferences["repairUrgencyHours"])}><option value="24">24 שעות</option><option value="48">48 שעות</option><option value="72">72 שעות</option><option value="168">שבוע</option></select></label>
            <label className="field-label">הודעה מראש לפני כניסת המשכיר<select value={form.minEntryNoticeHours ?? ""} onChange={(event) => set("minEntryNoticeHours", event.target.value === "" ? null : Number(event.target.value) as 24 | 48)}><option value="">לא חשוב לי</option><option value="24">24 שעות לפחות</option><option value="48">48 שעות לפחות</option></select></label>
          </div>
        </section>

        <section className="preference-section">
          <div className="preference-title"><span><ShieldCheck size={21} /></span><div><h2>גמישות ותשלומים</h2><p>מה מקובל עליך ומה חייב להופיע בחוזה</p></div></div>
          <div className="choice-grid two">
            <PreferenceToggle icon={DoorOpen} title="יציאה מוקדמת" text="חשוב לי שאוכל לצאת לפני סוף החוזה" checked={form.earlyExitRequired} onChange={(value) => set("earlyExitRequired", value)} />
            <PreferenceToggle icon={CalendarPlus} title="אופציה להארכה" text="חשוב לי שתהיה אופציה להאריך את החוזה" checked={form.renewalOptionRequired} onChange={(value) => set("renewalOptionRequired", value)} />
            <PreferenceToggle icon={TrendingUp} title="הצמדה למדד" text="מקובל עליי ששכר הדירה יהיה צמוד למדד" checked={form.acceptsIndexation} onChange={(value) => set("acceptsIndexation", value)} />
            <PreferenceToggle icon={Handshake} title="דמי תיווך" text="מקובל עליי לשלם דמי תיווך" checked={form.acceptsBrokerFee} onChange={(value) => set("acceptsBrokerFee", value)} />
          </div>
          <fieldset className="chip-field">
            <legend>סוגי הבטוחה שמקובלים עליי</legend>
            <div className="chip-group">
              {SECURITY_OPTIONS.map(({ kind, label }) => {
                const checked = form.acceptedSecurityKinds.includes(kind);
                return <label key={kind} className={`preference-chip ${checked ? "selected" : ""}`}><input type="checkbox" checked={checked} onChange={(event) => toggleSecurity(kind, event.target.checked)} />{label}</label>;
              })}
            </div>
            <small>נסמן בחוזה כל דרישה לבטוחה שלא בחרת.</small>
          </fieldset>
        </section>

        <section className="preference-section">
          <div className="preference-title"><span><Home size={21} /></span><div><h2>אורח החיים שלך</h2><p>כדי לזהות סעיפים חוקיים שפשוט לא מתאימים לך</p></div></div>
          <div className="choice-grid">
            <PreferenceToggle icon={Cat} title="חיות מחמד" text="החוזה חייב לאפשר חיית מחמד" checked={form.petsRequired} onChange={(value) => set("petsRequired", value)} />
            <PreferenceToggle icon={Sofa} title="דירה מרוהטת" text="חשוב שהדירה תימסר עם ריהוט" checked={form.furnishedRequired} onChange={(value) => set("furnishedRequired", value)} />
            <PreferenceToggle icon={Users} title="שותפים" text="צריך אפשרות להכניס שותף או להשכיר בשכירות משנה" checked={form.roommatesRequired} onChange={(value) => set("roommatesRequired", value)} />
          </div>
        </section>

        <section className="preference-section">
          <div className="preference-title"><span><MessageSquareText size={21} /></span><div><h2>עוד משהו שחשוב לך?</h2><p>במילים שלך, כל דבר שלא מופיע למעלה</p></div></div>
          <label className="field-label notes-field">
            <textarea aria-label="העדפות נוספות" rows={4} maxLength={NOTES_MAX_LENGTH} placeholder="למשל: אפשרות לעבוד מהבית בלי הגבלות, או חניה צמודה לדירה" value={form.additionalNotes} onChange={(event) => set("additionalNotes", event.target.value)} />
            <small>{form.additionalNotes.length}/{NOTES_MAX_LENGTH} · נבדוק את החוזה גם מול מה שכתבת. אין צורך לכתוב פרטים מזהים כמו שם או מספר תעודת זהות.</small>
          </label>
        </section>
        <div className="sticky-form-action"><p>{saved ? "ההעדפות נשמרו בהצלחה" : "השינויים ישמשו בניתוח הבא"}</p><button className="primary-button" type="submit" disabled={mutation.isPending}><Save size={18} /> {mutation.isPending ? "שומרים…" : "שמירת העדפות"}</button></div>
      </form>
    </div>
  );
}

function PreferenceToggle({ icon: Icon, title, text, checked, onChange }: { icon: typeof Cat; title: string; text: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`preference-toggle ${checked ? "selected" : ""}`}><span className="toggle-icon"><Icon size={22} /></span><span><strong>{title}</strong><small>{text}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}
