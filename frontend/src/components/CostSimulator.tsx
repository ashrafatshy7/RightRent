import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Calculator, Check, Info, Lock, Pencil, TrendingUp, Wallet, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, messageForError } from "../lib/api-client";
import { formatCurrency, formatNumber } from "../lib/format";
import { useDebouncedValue } from "../lib/use-debounced-value";
import type {
  Analysis,
  ChargeKind,
  CostMonth,
  CostScenario,
  EarlyExitKind,
  FinancialOverrides,
  OneTimeCostKind,
  TermSource,
} from "../types/api";
import { ErrorNotice } from "./ErrorNotice";
import { LoadingState } from "./LoadingState";
import { StatusBadge } from "./StatusBadge";

const CHARGE_LABELS: Record<ChargeKind, string> = {
  ARNONA: "ארנונה",
  WATER: "מים",
  ELECTRICITY: "חשמל",
  GAS: "גז",
  VAAD_BAYIT: "ועד בית",
  BUILDING_INSURANCE: "ביטוח מבנה",
  SPECIAL_BUILDING_EXPENSES: "הוצאות מיוחדות של הבניין",
  CONTENTS_INSURANCE: "ביטוח תכולה",
  OTHER: "תשלום שוטף אחר",
};

const ONE_TIME_LABELS: Record<OneTimeCostKind, string> = {
  BROKER_FEE: "דמי תיווך",
  LEGAL_FEE: "שכר טרחת עורך דין",
  CLEANING: "ניקיון בסיום",
  OTHER: "תשלום חד־פעמי",
};

const EXIT_LABELS: Record<EarlyExitKind, string> = {
  UNTIL_END: "משלמים עד סוף התקופה",
  UNTIL_REPLACEMENT: "משלמים עד שנמצא שוכר חלופי",
  FIXED_MONTHS: "פיצוי של מספר חודשי שכירות",
  FIXED_AMOUNT: "פיצוי בסכום קבוע",
  ALLOWED_WITH_NOTICE: "אפשר לעזוב בהודעה מוקדמת",
  NOT_ALLOWED: "אין זכות לעזוב לפני הסוף",
};

const SECURITY_LABELS = {
  BANK_GUARANTEE: "ערבות בנקאית",
  CASH_DEPOSIT: "פיקדון במזומן",
  PROMISSORY_NOTE: "שטר חוב",
  GUARANTOR: "ערב",
  OTHER: "בטוחה",
} as const;

const FREQUENCY_LABELS = { MONTHLY: "עדכון חודשי", ANNUAL: "עדכון שנתי", AT_RENEWAL: "עדכון בחידוש", UNKNOWN: "תדירות לא צוינה" } as const;

type CostSimulatorProps = {
  analysis: Analysis;
  token: string;
  labelFor: (clauseId: string) => string;
  onShowClause: (clauseId: string) => void;
};

// Which correction a row of "what we found" edits.
type EditTarget =
  | { kind: "scalar"; key: "monthlyRent" | "leaseTermMonths" | "annualIncreasePercent" | "optionMonths" | "optionRent" | "optionIncreasePercent" | "securityAmount" | "lateVacatingPerDay" | "latePaymentPerDay" | "earlyExitNoticeDays" }
  | { kind: "charge"; charge: ChargeKind }
  | { kind: "oneTime"; cost: OneTimeCostKind };

type TermRow = {
  id: string;
  label: string;
  value: string | null;
  source: TermSource | null;
  overridden: boolean;
  edit?: { target: EditTarget; current: number | null; unit: string };
};

function withOverride(overrides: FinancialOverrides, target: EditTarget, value: number | undefined): FinancialOverrides {
  if (target.kind === "scalar") {
    const { [target.key]: _removed, ...rest } = overrides;
    return value === undefined ? rest : { ...rest, [target.key]: value };
  }
  if (target.kind === "charge") {
    const { [target.charge]: _removed, ...charges } = overrides.chargeAmounts ?? {};
    return { ...overrides, chargeAmounts: value === undefined ? charges : { ...charges, [target.charge]: value } };
  }
  const { [target.cost]: _removed, ...costs } = overrides.oneTimeAmounts ?? {};
  return { ...overrides, oneTimeAmounts: value === undefined ? costs : { ...costs, [target.cost]: value } };
}

function money(value: number | null | undefined) {
  return value === null || value === undefined ? null : formatCurrency(value);
}

export function CostSimulator({ analysis, token, labelFor, onShowClause }: CostSimulatorProps) {
  const queryClient = useQueryClient();
  const terms = analysis.financialTerms;
  const overrides = analysis.financialOverrides ?? {};
  const [scenario, setScenario] = useState<Partial<CostScenario>>({});
  const settledScenario = useDebouncedValue(scenario, 250);
  const query = useQuery({
    queryKey: ["cost", analysis.analysisId, settledScenario, overrides],
    queryFn: () => api.simulateCost(token, analysis.analysisId, settledScenario),
    enabled: Boolean(terms),
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: (next: FinancialOverrides) => api.saveFinancialOverrides(token, analysis.analysisId, next),
    onSuccess: ({ financialOverrides }) => {
      queryClient.setQueryData<{ analysis: Analysis }>(["analysis", analysis.analysisId], (previous) =>
        previous ? { analysis: { ...previous.analysis, financialOverrides } } : previous);
    },
  });

  if (!terms) {
    return <div className="cost-empty"><Info size={20} /><p>הניתוח הזה נוצר לפני שנוסף מחשבון העלויות. כדי לראות את עלות החוזה, נתחו את החוזה מחדש.</p></div>;
  }
  if (query.isLoading) return <LoadingState label="מחשבים את עלות החוזה" />;
  if (query.error || !query.data) return <ErrorNotice message={messageForError(query.error, "לא הצלחנו לחשב את העלות.")} />;

  const { simulation, inputs, cpi } = query.data;
  const effective = { ...simulation.scenario, ...scenario };
  const update = (patch: Partial<CostScenario>) => setScenario((current) => ({ ...current, ...patch }));
  const term = inputs.leaseTermMonths ?? 0;
  const rows = termRows(analysis, inputs.indexation.linked);
  // Charges without an amount are listed by the simulation's own note, which also reflects the
  // estimates the tenant entered; the analysis-time notes about them would repeat or contradict it.
  const notes = [...new Set([...terms.unknowns.filter((note) => !note.startsWith("החוזה מטיל עליכם")), ...simulation.notes])];
  const cpiLabel = cpi.source === "CBS" && cpi.latestPeriod
    ? `לפי הלמ"ס: ${formatNumber(cpi.last12MonthsPercent)}% ב־12 החודשים שהסתיימו ב־${cpi.latestPeriod.split("-").reverse().join("/")}`
    : `הנחה של ${formatNumber(cpi.last12MonthsPercent)}% (נתוני הלמ"ס לא היו זמינים)`;
  const difference = simulation.totals.total - simulation.baselineTotal;

  return (
    <div className="cost-simulator">
      {simulation.ready ? (
        <section className="cost-summary" aria-label="סיכום העלות">
          <article><Wallet size={20} /><div><span>עלות כוללת</span><strong>{formatCurrency(simulation.totals.total)}</strong><small>{simulation.months.filter((month) => month.phase === "TERM" || month.phase === "OPTION").length} חודשי מגורים</small></div></article>
          <article><Calculator size={20} /><div><span>ממוצע לכל חודש מגורים</span><strong>{formatCurrency(simulation.totals.averageMonthly)}</strong><small>כולל תשלומים וקנסות בתרחיש</small></div></article>
          <article><Lock size={20} /><div><span>מופקד בבטוחות</span><strong>{formatCurrency(simulation.security.total)}</strong><small>{simulation.security.cashLocked ? `${formatCurrency(simulation.security.cashLocked)} במזומן` : "לא במזומן"}{simulation.security.returnDays ? ` · יוחזר תוך ${simulation.security.returnDays} ימים` : ""}</small></div></article>
          {Math.abs(difference) >= 1 ? (
            <article className={difference > 0 ? "cost-up" : "cost-down"}><TrendingUp size={20} /><div><span>לעומת מגורים עד סוף התקופה</span><strong>{difference > 0 ? "+" : "−"}{formatCurrency(Math.abs(difference))}</strong><small>בגלל האירועים שבחרתם בתרחיש</small></div></article>
          ) : null}
        </section>
      ) : (
        <div className="cost-empty"><Info size={20} /><p>כדי לחשב את העלות חסרים {simulation.missing.map((field) => (field === "monthlyRent" ? "דמי השכירות החודשיים" : "משך תקופת השכירות")).join(" ו")}. אפשר להזין אותם בטבלה למטה.</p></div>
      )}

      {simulation.budget.firstMonthOverBudget !== null || simulation.budget.firstMonthOverTotalBudget !== null || simulation.increase.exceedsPreference ? (
        <div className="cost-alerts">
          {simulation.budget.firstMonthOverBudget !== null ? <p><AlertTriangle size={16} /> בחודש {simulation.budget.firstMonthOverBudget} דמי השכירות יגיעו ל־{formatCurrency(simulation.budget.peakMonthlyRent)} ויעברו את התקציב שהגדרתם ({formatCurrency(simulation.budget.maxMonthlyRentIls)}).</p> : null}
          {simulation.budget.firstMonthOverTotalBudget !== null && simulation.budget.maxMonthlyTotalCostIls !== null ? <p><AlertTriangle size={16} /> בחודש {simulation.budget.firstMonthOverTotalBudget} שכר הדירה והתשלומים השוטפים יגיעו ל־{formatCurrency(simulation.budget.peakMonthlyTotal)} ויעברו את התקציב החודשי הכולל שהגדרתם ({formatCurrency(simulation.budget.maxMonthlyTotalCostIls)}).</p> : null}
          {simulation.increase.exceedsPreference ? <p><AlertTriangle size={16} /> העלייה השנתית בפועל היא {formatNumber(simulation.increase.effectiveAnnualPercent)}%, יותר מ־{formatNumber(simulation.increase.preferenceMax)}% שהגדרתם בהעדפות.</p> : null}
        </div>
      ) : null}

      <section className="cost-scenario" aria-label="תרחיש">
        <h3>מה אם…</h3>
        {inputs.indexation.linked ? (
          <label className="scenario-control"><span>אינפלציה שנתית <b>{formatNumber(effective.annualInflationPercent)}%</b></span><input type="range" min="-2" max="8" step="0.1" value={effective.annualInflationPercent} onChange={(event) => update({ annualInflationPercent: Number(event.target.value) })} /><small>{cpiLabel}</small></label>
        ) : <p className="scenario-note">החוזה אינו צמוד למדד, ולכן האינפלציה לא משנה את דמי השכירות.</p>}
        {inputs.option.months ? (
          <label className="scenario-toggle"><input type="checkbox" checked={effective.includeOption} disabled={effective.exitAfterMonth !== null} onChange={(event) => update({ includeOption: event.target.checked })} /> לכלול את תקופת האופציה ({inputs.option.months} חודשים)</label>
        ) : null}
        {term > 1 ? (
          <label className="scenario-control"><span>יציאה מוקדמת <b>{effective.exitAfterMonth ? `אחרי ${effective.exitAfterMonth} חודשים` : "בלי"}</b></span><input type="range" min="0" max={term - 1} step="1" value={effective.exitAfterMonth ?? 0} onChange={(event) => update({ exitAfterMonth: Number(event.target.value) || null })} /><small>{inputs.earlyExit.kind ? EXIT_LABELS[inputs.earlyExit.kind] : "החוזה לא קובע מה קורה ביציאה מוקדמת"}</small></label>
        ) : null}
        {effective.exitAfterMonth && inputs.earlyExit.kind === "UNTIL_REPLACEMENT" ? (
          <label className="scenario-control"><span>שוכר חלופי נמצא אחרי <b>{effective.replacementAfterMonths} חודשים</b></span><input type="range" min="0" max="6" step="1" value={effective.replacementAfterMonths} onChange={(event) => update({ replacementAfterMonths: Number(event.target.value) })} /></label>
        ) : null}
        <div className="scenario-pair">
          <label className="scenario-number">איחור בפינוי<span><input type="number" min="0" max="60" value={effective.lateVacatingDays} onChange={(event) => update({ lateVacatingDays: Math.max(0, Number(event.target.value) || 0) })} /> ימים</span></label>
          <label className="scenario-number">איחור בתשלום אחד<span><input type="number" min="0" max="60" value={effective.latePaymentDays} onChange={(event) => update({ latePaymentDays: Math.max(0, Number(event.target.value) || 0) })} /> ימים</span></label>
        </div>
      </section>

      {simulation.ready ? <CostChart months={simulation.months} /> : null}

      {simulation.ready ? (
        <section className="cost-lines" aria-label="איך חישבנו">
          <h3>איך חישבנו</h3>
          <ul>
            {simulation.lines.map((line) => (
              <li key={line.id}>
                <div><strong>{line.label}</strong><span>{formatCurrency(line.amount)}</span></div>
                <p>{line.formula}</p>
                {line.sourceClauseIds.length ? <div className="clause-chips">{line.sourceClauseIds.map((clauseId) => <button key={clauseId} type="button" className="clause-chip" onClick={() => onShowClause(clauseId)}>{labelFor(clauseId)}</button>)}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {notes.length ? <ul className="cost-notes">{notes.map((note) => <li key={note}><Info size={14} /> {note}</li>)}</ul> : null}

      <section className="cost-terms" aria-label="מה זיהינו בחוזה">
        <h3>מה זיהינו בחוזה</h3>
        <p className="cost-terms-intro">כל ערך מקושר לסעיף שממנו נלקח. ערך שלא אומת לא נכנס לחישוב עד שתאשרו אותו, ואפשר לתקן כל ערך.</p>
        {save.error ? <ErrorNotice message={messageForError(save.error)} /> : null}
        <div className="terms-table">
          {rows.map((row) => (
            <TermRowView
              key={row.id}
              row={row}
              labelFor={labelFor}
              onShowClause={onShowClause}
              saving={save.isPending}
              onSave={(target, value) => save.mutate(withOverride(overrides, target, value))}
            />
          ))}
          <div className="term-row">
            <div className="term-label">הצמדה למדד</div>
            <div className="term-value">
              <label className="scenario-toggle"><input type="checkbox" checked={inputs.indexation.linked} onChange={(event) => save.mutate({ ...overrides, indexationLinked: event.target.checked })} /> צמוד למדד</label>
              {inputs.indexation.linked ? (
                <select value={inputs.indexation.frequency} onChange={(event) => save.mutate({ ...overrides, indexationFrequency: event.target.value as "MONTHLY" | "ANNUAL" | "AT_RENEWAL" })}>
                  <option value="MONTHLY">עדכון חודשי</option><option value="ANNUAL">עדכון שנתי</option><option value="AT_RENEWAL">עדכון בחידוש</option>
                </select>
              ) : null}
            </div>
            <div className="term-source">{terms.indexation ? <SourceChip source={terms.indexation} labelFor={labelFor} onShowClause={onShowClause} /> : <small>לא צוין בחוזה</small>}</div>
            <div className="term-status">{overrides.indexationLinked !== undefined || overrides.indexationFrequency ? <StatusBadge tone="review">עודכן על ידכם</StatusBadge> : <SourceStatus source={terms.indexation} />}</div>
          </div>
          <div className="term-row">
            <div className="term-label">יציאה מוקדמת</div>
            <div className="term-value">
              <select value={inputs.earlyExit.kind ?? ""} onChange={(event) => save.mutate(event.target.value ? { ...overrides, earlyExitKind: event.target.value as EarlyExitKind } : (({ earlyExitKind: _removed, ...rest }) => rest)(overrides))}>
                <option value="">לא צוין בחוזה</option>
                {(Object.keys(EXIT_LABELS) as EarlyExitKind[]).map((kind) => <option key={kind} value={kind}>{EXIT_LABELS[kind]}</option>)}
              </select>
            </div>
            <div className="term-source">{terms.earlyExit ? <SourceChip source={terms.earlyExit} labelFor={labelFor} onShowClause={onShowClause} /> : <small>לא צוין בחוזה</small>}</div>
            <div className="term-status">{overrides.earlyExitKind ? <StatusBadge tone="review">עודכן על ידכם</StatusBadge> : <SourceStatus source={terms.earlyExit} />}</div>
          </div>
        </div>
      </section>
      <p className="cost-disclaimer">הערכה בלבד ואינה ייעוץ פיננסי. האינפלציה העתידית אינה ידועה, וסכומים שהחוזה לא מציין אינם כלולים אלא אם הזנתם אותם.</p>
    </div>
  );
}

function termRows(analysis: Analysis, indexed: boolean): TermRow[] {
  const terms = analysis.financialTerms!;
  const overrides = analysis.financialOverrides ?? {};
  const rows: TermRow[] = [];
  const scalar = (
    id: string,
    label: string,
    key: Extract<EditTarget, { kind: "scalar" }>["key"],
    source: (TermSource & { value: number }) | null,
    unit: string,
    format: (value: number) => string,
  ) => {
    const current = overrides[key] ?? source?.value ?? null;
    rows.push({
      id,
      label,
      value: current === null ? null : format(current),
      source,
      overridden: overrides[key] !== undefined,
      edit: { target: { kind: "scalar", key }, current, unit },
    });
  };
  scalar("rent", "דמי שכירות חודשיים", "monthlyRent", terms.monthlyRent, "₪", formatCurrency);
  scalar("term", "תקופת השכירות", "leaseTermMonths", terms.leaseTermMonths, "חודשים", (value) => `${formatNumber(value)} חודשים`);
  if (terms.leaseStart) {
    rows.push({ id: "start", label: "תחילת השכירות", value: terms.leaseStart.value.split("-").reverse().join("/"), source: terms.leaseStart, overridden: false });
  }
  if (indexed && terms.indexation) {
    rows.push({
      id: "index-detail",
      label: "פרטי ההצמדה",
      value: `${terms.indexation.index === "USD" ? "דולר" : "מדד המחירים לצרכן"} · ${FREQUENCY_LABELS[terms.indexation.frequency]}${terms.indexation.floorAtBase ? " · לא יורד מהבסיס" : ""}`,
      source: terms.indexation,
      overridden: false,
    });
  }
  scalar("increase", "העלאה שנתית קבועה", "annualIncreasePercent", terms.annualIncreasePercent, "%", (value) => `${formatNumber(value)}%`);
  if (terms.option.months || terms.option.rent || terms.option.increasePercent || overrides.optionMonths !== undefined) {
    scalar("option-months", "תקופת אופציה", "optionMonths", terms.option.months, "חודשים", (value) => `${formatNumber(value)} חודשים`);
    if (terms.option.rent || overrides.optionRent !== undefined) scalar("option-rent", "דמי שכירות באופציה", "optionRent", terms.option.rent, "₪", formatCurrency);
    else scalar("option-increase", "העלאה באופציה", "optionIncreasePercent", terms.option.increasePercent, "%", (value) => `${formatNumber(value)}%`);
  }
  for (const charge of terms.charges) {
    const current = overrides.chargeAmounts?.[charge.kind] ?? charge.monthlyAmount;
    rows.push({
      id: `charge-${charge.kind}`,
      label: `${CHARGE_LABELS[charge.kind]}${charge.payer === "LANDLORD" ? " (על המשכיר)" : ""}`,
      value: current === null ? null : `${formatCurrency(current)} לחודש`,
      source: charge,
      overridden: overrides.chargeAmounts?.[charge.kind] !== undefined,
      ...(charge.payer === "TENANT" ? { edit: { target: { kind: "charge" as const, charge: charge.kind }, current, unit: "₪ לחודש" } } : {}),
    });
  }
  for (const cost of terms.oneTimeCosts) {
    const current = overrides.oneTimeAmounts?.[cost.kind] ?? cost.amount;
    rows.push({
      id: `one-time-${cost.kind}`,
      label: ONE_TIME_LABELS[cost.kind],
      value: money(current),
      source: cost,
      overridden: overrides.oneTimeAmounts?.[cost.kind] !== undefined,
      edit: { target: { kind: "oneTime", cost: cost.kind }, current, unit: "₪" },
    });
  }
  terms.securities.forEach((security, index) => {
    const current = index === 0 ? overrides.securityAmount ?? security.amount : security.amount;
    rows.push({
      id: `security-${index}`,
      label: SECURITY_LABELS[security.kind],
      value: [money(current), security.returnDays ? `תוחזר תוך ${security.returnDays} ימים` : null].filter(Boolean).join(" · ") || null,
      source: security,
      overridden: index === 0 && overrides.securityAmount !== undefined,
      ...(index === 0 ? { edit: { target: { kind: "scalar" as const, key: "securityAmount" as const }, current, unit: "₪" } } : {}),
    });
  });
  if (terms.lateVacating || overrides.lateVacatingPerDay !== undefined) {
    const current = overrides.lateVacatingPerDay ?? terms.lateVacating?.perDay ?? null;
    rows.push({
      id: "late-vacating",
      label: "פיצוי על איחור בפינוי",
      value: current !== null ? `${formatCurrency(current)} ליום` : terms.lateVacating?.dailyRentMultiple ? `פי ${terms.lateVacating.dailyRentMultiple} מהשכירות היומית` : null,
      source: terms.lateVacating,
      overridden: overrides.lateVacatingPerDay !== undefined,
      edit: { target: { kind: "scalar", key: "lateVacatingPerDay" }, current, unit: "₪ ליום" },
    });
  }
  if (terms.latePayment) {
    rows.push({
      id: "late-payment",
      label: "קנס על איחור בתשלום",
      value: terms.latePayment.perDay !== null ? `${formatCurrency(terms.latePayment.perDay)} ליום` : terms.latePayment.monthlyInterestPercent !== null ? `${formatNumber(terms.latePayment.monthlyInterestPercent)}% לחודש` : null,
      source: terms.latePayment,
      overridden: false,
    });
  }
  if (terms.earlyExit?.noticeDays || overrides.earlyExitNoticeDays !== undefined) {
    const current = overrides.earlyExitNoticeDays ?? terms.earlyExit?.noticeDays ?? null;
    rows.push({
      id: "notice",
      label: "הודעה מוקדמת ליציאה",
      value: current === null ? null : `${formatNumber(current)} ימים`,
      source: terms.earlyExit,
      overridden: overrides.earlyExitNoticeDays !== undefined,
      edit: { target: { kind: "scalar", key: "earlyExitNoticeDays" }, current, unit: "ימים" },
    });
  }
  return rows;
}

function SourceStatus({ source }: { source: TermSource | null }) {
  if (!source) return <StatusBadge tone="pending">לא צוין</StatusBadge>;
  if (source.conflict) return <StatusBadge tone="warning">שני ערכים שונים · אשרו</StatusBadge>;
  if (!source.verified) return <StatusBadge tone="warning">לא אומת · אשרו</StatusBadge>;
  return <StatusBadge tone="success">מהחוזה</StatusBadge>;
}

function SourceChip({ source, labelFor, onShowClause }: { source: TermSource; labelFor: (clauseId: string) => string; onShowClause: (clauseId: string) => void }) {
  return <button type="button" className="clause-chip" title={source.quote} onClick={() => onShowClause(source.clauseId)}>{labelFor(source.clauseId)}</button>;
}

function TermRowView({ row, labelFor, onShowClause, saving, onSave }: {
  row: TermRow;
  labelFor: (clauseId: string) => string;
  onShowClause: (clauseId: string) => void;
  saving: boolean;
  onSave: (target: EditTarget, value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!row.edit || draft === null) return;
    const value = draft.trim() === "" ? undefined : Number(draft);
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return;
    onSave(row.edit.target, value);
    setDraft(null);
  }
  return (
    <div className="term-row">
      <div className="term-label">{row.label}</div>
      <div className="term-value">
        {draft !== null && row.edit ? (
          <form className="term-edit" onSubmit={submit}>
            <input type="number" min="0" step="any" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={row.label} autoFocus />
            <small>{row.edit.unit}</small>
            <button type="submit" disabled={saving} aria-label="שמירה"><Check size={14} /></button>
            <button type="button" onClick={() => setDraft(null)} aria-label="ביטול"><X size={14} /></button>
          </form>
        ) : (
          <>
            <span>{row.value ?? "—"}</span>
            {row.edit ? <button type="button" className="term-edit-button" onClick={() => setDraft(row.edit!.current === null ? "" : String(row.edit!.current))} aria-label={`עריכת ${row.label}`}><Pencil size={13} /></button> : null}
          </>
        )}
      </div>
      <div className="term-source">{row.source ? <SourceChip source={row.source} labelFor={labelFor} onShowClause={onShowClause} /> : <small>לא צוין בחוזה</small>}</div>
      <div className="term-status">{row.overridden
        ? <StatusBadge tone="review">עודכן על ידכם</StatusBadge>
        : row.source && row.value === null ? <StatusBadge tone="pending">סכום לא צוין</StatusBadge> : <SourceStatus source={row.source} />}</div>
    </div>
  );
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const SEGMENTS = [
  { key: "rent", label: "דמי שכירות", value: (month: CostMonth) => month.baseRent },
  { key: "growth", label: "הצמדה והעלאות", value: (month: CostMonth) => month.increase + month.indexation },
  { key: "charges", label: "תשלומים שוטפים", value: (month: CostMonth) => month.charges },
  { key: "one-time", label: "חד־פעמי", value: (month: CostMonth) => month.oneTime },
  { key: "penalties", label: "קנסות ופיצויים", value: (month: CostMonth) => month.penalties },
] as const;

const PHASE_LABELS = { TERM: "תקופת השכירות", OPTION: "אופציה", EXIT: "תשלום אחרי יציאה", LATE: "איחור בפינוי" } as const;

// Monthly cost as stacked bars, months left to right as on a calendar. Each bar has a text
// alternative, and the same numbers are available as a table below the chart.
function CostChart({ months }: { months: CostMonth[] }) {
  const peak = Math.max(1, ...months.map((month) => month.total));
  const slot = CHART_WIDTH / months.length;
  const barWidth = Math.max(2, slot * 0.7);
  const labelEvery = Math.ceil(months.length / 12);
  return (
    <section className="cost-chart" aria-label="עלות לפי חודש">
      <h3>עלות לפי חודש</h3>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT + 22}`} role="img" aria-label="תרשים עמודות של העלות החודשית">
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line key={fraction} x1="0" x2={CHART_WIDTH} y1={CHART_HEIGHT * (1 - fraction)} y2={CHART_HEIGHT * (1 - fraction)} className="chart-grid" />
        ))}
        {months.map((month, index) => {
          let top = CHART_HEIGHT;
          const x = index * slot + (slot - barWidth) / 2;
          return (
            <g key={month.month} className={`chart-bar phase-${month.phase.toLowerCase()}`}>
              <title>{`חודש ${month.month}${month.period ? ` (${month.period.split("-").reverse().join("/")})` : ""} · ${PHASE_LABELS[month.phase]}: ${formatCurrency(month.total)}`}</title>
              {SEGMENTS.map((segment) => {
                const value = segment.value(month);
                if (value <= 0) return null;
                const height = (value / peak) * CHART_HEIGHT;
                top -= height;
                return <rect key={segment.key} className={`segment-${segment.key}`} x={x} y={top} width={barWidth} height={height} />;
              })}
              {(index % labelEvery === 0 || index === months.length - 1) ? <text x={x + barWidth / 2} y={CHART_HEIGHT + 15} textAnchor="middle">{month.month}</text> : null}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">{SEGMENTS.map((segment) => <span key={segment.key}><i className={`segment-${segment.key}`} />{segment.label}</span>)}</div>
      <details className="chart-table">
        <summary>הצגת הטבלה החודשית</summary>
        <table>
          <thead><tr><th>חודש</th><th>שלב</th><th>שכירות</th><th>הצמדה והעלאות</th><th>תשלומים</th><th>חד־פעמי וקנסות</th><th>סה״כ</th><th>מצטבר</th></tr></thead>
          <tbody>{months.map((month) => (
            <tr key={month.month}><td>{month.month}</td><td>{PHASE_LABELS[month.phase]}</td><td>{formatCurrency(month.baseRent)}</td><td>{formatCurrency(month.increase + month.indexation)}</td><td>{formatCurrency(month.charges)}</td><td>{formatCurrency(month.oneTime + month.penalties)}</td><td>{formatCurrency(month.total)}</td><td>{formatCurrency(month.cumulative)}</td></tr>
          ))}</tbody>
        </table>
      </details>
    </section>
  );
}
