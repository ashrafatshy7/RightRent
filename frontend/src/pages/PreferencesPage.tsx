import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Cat, Clock3, Home, Save, Sofa } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { api, messageForError } from "../lib/api-client";
import { formatCurrency } from "../lib/format";
import type { TenantPreferences } from "../types/api";

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
            <label className="field-label">עלייה שנתית מרבית <span className="input-with-suffix"><input type="number" min="0" max="100" step="0.5" value={form.maxAnnualRentIncreasePercent} onChange={(event) => set("maxAnnualRentIncreasePercent", Number(event.target.value))} /><b>%</b></span></label>
            <label className="field-label">משך חוזה רצוי <span className="input-with-suffix"><input type="number" min="1" max="120" value={form.leaseLengthMonths} onChange={(event) => set("leaseLengthMonths", Number(event.target.value))} /><b>חודשים</b></span></label>
            <label className="field-label">זמן מרבי לתיקון תקלה<select value={form.repairUrgencyHours} onChange={(event) => set("repairUrgencyHours", Number(event.target.value) as TenantPreferences["repairUrgencyHours"])}><option value="24">24 שעות</option><option value="48">48 שעות</option><option value="72">72 שעות</option><option value="168">שבוע</option></select></label>
          </div>
        </section>

        <section className="preference-section">
          <div className="preference-title"><span><Home size={21} /></span><div><h2>אורח החיים שלך</h2><p>כדי לזהות סעיפים חוקיים שפשוט לא מתאימים לך</p></div></div>
          <div className="choice-grid">
            <PreferenceToggle icon={Cat} title="חיות מחמד" text="החוזה חייב לאפשר חיית מחמד" checked={form.petsRequired} onChange={(value) => set("petsRequired", value)} />
            <PreferenceToggle icon={Sofa} title="דירה מרוהטת" text="חשוב שהדירה תימסר עם ריהוט" checked={form.furnishedRequired} onChange={(value) => set("furnishedRequired", value)} />
            <PreferenceToggle icon={Clock3} title="דרישת ערב" text="מקובל עליי להעמיד ערב לחוזה" checked={form.acceptsGuarantorRequirement} onChange={(value) => set("acceptsGuarantorRequirement", value)} />
          </div>
        </section>
        <div className="sticky-form-action"><p>{saved ? "ההעדפות נשמרו בהצלחה" : "השינויים ישמשו בניתוח הבא"}</p><button className="primary-button" type="submit" disabled={mutation.isPending}><Save size={18} /> {mutation.isPending ? "שומרים…" : "שמירת העדפות"}</button></div>
      </form>
    </div>
  );
}

function PreferenceToggle({ icon: Icon, title, text, checked, onChange }: { icon: typeof Cat; title: string; text: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`preference-toggle ${checked ? "selected" : ""}`}><span className="toggle-icon"><Icon size={22} /></span><span><strong>{title}</strong><small>{text}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}
