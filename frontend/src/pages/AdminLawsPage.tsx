import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpLeft,
  BookCheck,
  CheckCircle2,
  Database,
  ExternalLink,
  FileWarning,
  Fingerprint,
  RefreshCw,
  SearchCheck,
  ServerCog,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api, messageForError } from "../lib/api-client";
import { formatDate, formatNumber, shortHash } from "../lib/format";
import { LAW_STATUS_META, LAW_STATUS_ORDER } from "../lib/law-status";
import type { LawApproval, LawSourceState, LawSourceStatus, Readiness } from "../types/api";

type LawFilter = LawSourceStatus | "ALL";

export function AdminLawsPage() {
  const { token, user } = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<LawFilter>("ALL");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lawsQuery, readinessQuery] = useQueries({ queries: [
    { queryKey: ["admin", "laws"], queryFn: () => api.getLawStatus(token!), refetchInterval: 60_000 },
    { queryKey: ["readiness"], queryFn: api.getReadiness, refetchInterval: 60_000 },
  ] });
  const sync = useMutation({
    mutationFn: () => api.syncLaws(token!),
    onSuccess: ({ checks }) => {
      const failures = checks.filter((check) => check.status === "FAILED").length;
      setNotice(failures ? `הבדיקה הסתיימה עם ${failures} כשלים.` : "בדיקת המקורות הסתיימה בהצלחה.");
      queryClient.invalidateQueries({ queryKey: ["admin", "laws"] });
      queryClient.invalidateQueries({ queryKey: ["readiness"] });
    },
  });

  const laws = lawsQuery.data?.laws ?? [];
  const sorted = useMemo(() => laws.toSorted((left, right) => {
    const statusDifference = LAW_STATUS_ORDER.indexOf(left.status) - LAW_STATUS_ORDER.indexOf(right.status);
    return statusDifference || left.israelLawId - right.israelLawId;
  }), [laws]);
  const filtered = filter === "ALL" ? sorted : sorted.filter((law) => law.status === filter);
  const selected = laws.find((law) => law.israelLawId === selectedId) ?? null;

  if (lawsQuery.isLoading || readinessQuery.isLoading) return <LoadingState label="טוענים את מרכז החקיקה" />;
  const pageError = lawsQuery.error ?? readinessQuery.error;
  if (pageError) return <ErrorNotice message={messageForError(pageError)} />;

  return (
    <div className="page-wrap admin-page">
      <PageHeader eyebrow="בקרת מקורות והרשאות" title="מרכז החקיקה" description="13 חוקים, גרסה אחת פעילה לכל חוק, ותיעוד מלא של כל החלטת אימות." actions={<button className="secondary-button" type="button" disabled={sync.isPending} onClick={() => { setNotice(null); sync.mutate(); }}><RefreshCw className={sync.isPending ? "spinning" : ""} size={17} />{sync.isPending ? "בודקים מקורות…" : "בדיקה עכשיו"}</button>} />
      {sync.error ? <ErrorNotice message={messageForError(sync.error)} /> : null}
      {notice ? <div className="success-notice"><CheckCircle2 size={18} />{notice}</div> : null}

      <ReadinessBoard readiness={readinessQuery.data!} laws={laws} />

      <section className="law-console">
        <div className="law-toolbar">
          <div><span className="eyebrow">מצב נוכחי</span><h2>מאגר החוקים</h2></div>
          <div className="status-filters">
            <button className={filter === "ALL" ? "active" : ""} type="button" onClick={() => setFilter("ALL")}>הכול <b>{laws.length}</b></button>
            {LAW_STATUS_ORDER.map((status) => {
              const count = laws.filter((law) => law.status === status).length;
              return count ? <button key={status} className={filter === status ? "active" : ""} type="button" onClick={() => setFilter(status)}>{LAW_STATUS_META[status].label} <b>{count}</b></button> : null;
            })}
          </div>
        </div>

        <div className="law-table" role="table" aria-label="מצב החוקים">
          <div className="law-table-head" role="row"><span>חוק</span><span>סטטוס</span><span>גרסה</span><span>סעיפים</span><span>בדיקה אחרונה</span><span /></div>
          {filtered.map((law) => {
            const meta = LAW_STATUS_META[law.status];
            const revision = law.candidateRevisionId ?? law.activeRevisionId ?? law.observedRevisionId;
            const sectionCount = law.candidateSectionCount ?? law.activeSectionCount ?? law.observedSectionCount;
            return (
              <button className="law-row" type="button" role="row" key={law.israelLawId} onClick={() => setSelectedId(law.israelLawId)}>
                <span className="law-identity"><i>{String(law.israelLawId).slice(-3)}</i><span><strong>{law.lawName}</strong><small>IsraelLaw {law.israelLawId}</small></span></span>
                <span><StatusBadge tone={meta.tone}>{meta.label}</StatusBadge></span>
                <code>{revision || "—"}</code><span>{formatNumber(sectionCount)}</span><span>{formatDate(law.checkedAt)}</span><span className="row-arrow"><ArrowUpLeft size={17} /></span>
              </button>
            );
          })}
        </div>
      </section>

      {selected ? <LawReviewPanel key={`${selected.israelLawId}:${selected.candidateRevisionId ?? selected.activeRevisionId}`} law={selected} reviewer={user?.email ?? ""} token={token!} onClose={() => setSelectedId(null)} onApproved={() => { setSelectedId(null); queryClient.invalidateQueries({ queryKey: ["admin", "laws"] }); queryClient.invalidateQueries({ queryKey: ["readiness"] }); }} /> : null}
    </div>
  );
}

function ReadinessBoard({ readiness, laws }: { readiness: Readiness; laws: LawSourceState[] }) {
  const active = laws.filter((law) => law.status === "ACTIVE").length;
  const review = laws.filter((law) => law.status === "AWAITING_VERIFICATION").length;
  const failed = laws.filter((law) => law.status === "FAILED").length;
  const cards = [
    { icon: Database, label: "MongoDB", value: readiness.database ? "מחובר" : "מנותק", ready: readiness.database },
    { icon: ShieldCheck, label: "DictaBERT", value: readiness.piiNer?.ready ? "מוכן" : "לא זמין", ready: Boolean(readiness.piiNer?.ready) },
    { icon: Fingerprint, label: "Vector Search", value: readiness.vectorSearch ? "פעיל" : "ממתין", ready: Boolean(readiness.vectorSearch) },
    { icon: BookCheck, label: "חוקים פעילים", value: `${active}/13`, ready: active === 13 },
  ] as const;
  return (
    <section className="admin-readiness">
      <div className="readiness-title"><span className={readiness.status === "ready" ? "system-live" : "system-waiting"}><ServerCog size={22} /></span><div><strong>{readiness.status === "ready" ? "המערכת מוכנה לניתוח" : "המערכת עדיין אינה מוכנה"}</strong><small>{review} ממתינים לאימות · {failed} נכשלו</small></div></div>
      <div className="readiness-cards">{cards.map(({ icon: Icon, label, value, ready }) => <article key={label} className={ready ? "service-ready" : "service-waiting"}><Icon size={19} /><div><span>{label}</span><strong>{value}</strong></div><i /></article>)}</div>
    </section>
  );
}

function LawReviewPanel({ law, reviewer, token, onClose, onApproved }: { law: LawSourceState; reviewer: string; token: string; onClose: () => void; onApproved: () => void }) {
  const meta = LAW_STATUS_META[law.status];
  const [verifiedBy, setVerifiedBy] = useState(reviewer);
  const permanentWikiUrl = law.candidateRevisionId ? `${law.wikisourceUrl}?oldid=${law.candidateRevisionId}` : law.wikisourceUrl;
  const [verificationReference, setVerificationReference] = useState(`${law.knessetUrl} ; ${permanentWikiUrl} ; checked ${new Date().toISOString().slice(0, 10)}`);
  const [confirmed, setConfirmed] = useState(false);
  const approval = useMutation({ mutationFn: (payload: LawApproval) => api.approveLaw(token, law.israelLawId, payload), onSuccess: onApproved });
  const canApprove = law.status === "AWAITING_VERIFICATION"
    && law.candidateRevisionId !== null
    && law.candidateContentHash !== null
    && law.candidateSectionCount !== null
    && law.candidateSectionsHash !== null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canApprove || !confirmed) return;
    approval.mutate({
      revisionId: law.candidateRevisionId!,
      contentHash: law.candidateContentHash!,
      sectionCount: law.candidateSectionCount!,
      sectionsHash: law.candidateSectionsHash!,
      confirmedComplete: true,
      verifiedBy,
      verificationReference,
    });
  }

  return (
    <div className="review-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="review-panel" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <header className="review-header"><div><span className="eyebrow">IsraelLaw {law.israelLawId}</span><h2 id="review-title">{law.lawName}</h2><StatusBadge tone={meta.tone}>{meta.label}</StatusBadge></div><button type="button" onClick={onClose} aria-label="סגירה"><X size={20} /></button></header>
        <div className="review-content">
          <section className="source-links"><a href={law.knessetUrl} target="_blank" rel="noreferrer"><span><SearchCheck size={20} /></span><div><strong>מאגר החקיקה של הכנסת</strong><small>פרסומים, תיקונים וקשרי חקיקה</small></div><ExternalLink size={16} /></a><a href={permanentWikiUrl} target="_blank" rel="noreferrer"><span><BookCheck size={20} /></span><div><strong>הגרסה המאוחדת הקפואה</strong><small>revision {law.candidateRevisionId ?? law.observedRevisionId}</small></div><ExternalLink size={16} /></a></section>
          {law.error ? <div className="law-error"><FileWarning size={20} /><div><strong>הסנכרון נעצר</strong><p>{law.error}</p></div></div> : null}
          <section className="candidate-facts"><h3>טביעת האצבע של המועמד</h3><div className="fact-grid"><Fact label="Revision" value={String(law.candidateRevisionId ?? "—")} /><Fact label="מספר סעיפים" value={formatNumber(law.candidateSectionCount)} /><Fact label="Content hash" value={shortHash(law.candidateContentHash)} title={law.candidateContentHash ?? undefined} /><Fact label="Sections hash" value={shortHash(law.candidateSectionsHash)} title={law.candidateSectionsHash ?? undefined} /></div></section>
          <section className="section-manifest"><div><h3>Manifest הסעיפים</h3><span>{law.candidateSectionKeys.length} מזהים</span></div>{law.candidateSectionKeys.length ? <details><summary>פתיחת הרשימה המלאה</summary><ol>{law.candidateSectionKeys.map((key) => <li key={key}><code>{key}</code></li>)}</ol></details> : <p>אין רשימת סעיפים זמינה למועמד הזה.</p>}</section>
          {canApprove ? (
            <form className="approval-form" onSubmit={submit}>
              <div className="approval-heading"><span><Fingerprint size={20} /></span><div><h3>תיעוד האימות</h3><p>הערכים הטכניים נלקחים אוטומטית מהמועמד ואינם ניתנים לעריכה.</p></div></div>
              {approval.error ? <ErrorNotice message={messageForError(approval.error)} /> : null}
              <label className="field-label">שם הבודק<input required minLength={2} maxLength={200} value={verifiedBy} onChange={(event) => setVerifiedBy(event.target.value)} /></label>
              <label className="field-label">מקורות והערות אימות<textarea required minLength={5} maxLength={2000} rows={4} value={verificationReference} onChange={(event) => setVerificationReference(event.target.value)} /></label>
              <label className={`confirmation-check ${confirmed ? "checked" : ""}`}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><CheckCircle2 size={19} /></span><div><strong>בדקתי שהגרסה מלאה ועדכנית</strong><small>השוויתי את רשימת התיקונים, הסעיפים והגרסה הקפואה למקורות הרשומים.</small></div></label>
              <button className="primary-button approval-button" type="submit" disabled={!confirmed || !verifiedBy.trim() || !verificationReference.trim() || approval.isPending}>{approval.isPending ? "מפעילים את הגרסה…" : "אישור והפיכת החוק לפעיל"}<ShieldCheck size={18} /></button>
            </form>
          ) : <div className="approval-blocked"><AlertTriangle size={19} /><span>{law.status === "FAILED" ? "יש לתקן את שגיאת החילוץ ולסנכרן מחדש לפני אישור." : law.status === "ACTIVE" ? "הגרסה הזו כבר פעילה ומאומתת." : "אין כרגע מועמד שלם שניתן לאשר."}</span></div>}
        </div>
      </aside>
    </div>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div title={title}><span>{label}</span><code dir="ltr">{value}</code></div>;
}
