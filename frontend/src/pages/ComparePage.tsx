import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, GitCompareArrows, Info, MoveVertical, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ROUTES } from "../config/app";
import { api, messageForError } from "../lib/api-client";
import { formatCurrency, formatDate } from "../lib/format";
import type { AlignmentChange, ComparisonItem, ComparisonSide, ComparisonStatus, DiffPart, ProtectionStatus, Severity } from "../types/api";

const STATUS_META: Record<ComparisonStatus, { label: string; tone: string; description: string }> = {
  NEW_ISSUE: { label: "בעיה חדשה", tone: "danger", description: "סעיף חדש או סעיף ששונה, ויש בו בעיה." },
  WORSENED: { label: "החמיר", tone: "danger", description: "הבעיה בסעיף חמורה יותר מאשר בגרסה הקודמת." },
  UNREQUESTED_CHANGE: { label: "שינוי שלא ביקשתם", tone: "warning", description: "המשכיר שינה סעיף שלא הייתה בו בעיה. כדאי לבדוק שהשינוי מקובל עליכם." },
  STILL_OPEN: { label: "לא תוקן", tone: "review", description: "הבעיה מהגרסה הקודמת עדיין קיימת." },
  IMPROVED: { label: "השתפר", tone: "pending", description: "הבעיה פחות חמורה מאשר בגרסה הקודמת." },
  FIXED: { label: "תוקן", tone: "success", description: "הבעיה נפתרה, או שהסעיף הבעייתי הוסר." },
  UNCHANGED: { label: "ללא שינוי", tone: "pending", description: "" },
};

const STATUS_ORDER: ComparisonStatus[] = ["NEW_ISSUE", "WORSENED", "UNREQUESTED_CHANGE", "STILL_OPEN", "IMPROVED", "FIXED"];

const CHANGE_LABELS: Record<AlignmentChange, string> = {
  UNCHANGED: "הנוסח לא השתנה",
  MODIFIED: "הנוסח השתנה",
  ADDED: "סעיף חדש",
  REMOVED: "הסעיף הוסר",
  SPLIT: "הסעיף חולק לכמה סעיפים",
  MERGED: "כמה סעיפים אוחדו לאחד",
};

const SEVERITY_META: Record<Severity, { label: string; tone: string }> = {
  RED: { label: "דורש טיפול", tone: "danger" },
  ORANGE: { label: "כדאי לבדוק", tone: "warning" },
  OK: { label: "תקין", tone: "success" },
};

const PROTECTION_LABELS: Record<ProtectionStatus, { label: string; tone: string }> = {
  COVERED: { label: "קיימת", tone: "success" },
  PARTIAL: { label: "חלקית", tone: "warning" },
  MISSING: { label: "חסרה", tone: "danger" },
};

export function ComparePage() {
  const { baseId = "", targetId = "" } = useParams();
  const { token } = useAuth();
  const [filter, setFilter] = useState<ComparisonStatus | "ALL">("ALL");
  const query = useQuery({
    queryKey: ["comparison", baseId, targetId],
    queryFn: () => api.getComparison(token!, baseId, targetId),
    enabled: Boolean(baseId && targetId),
  });
  const comparison = query.data?.comparison;
  const changed = useMemo(() => comparison?.items.filter((item) => item.status !== "UNCHANGED") ?? [], [comparison]);
  const unchanged = useMemo(() => comparison?.items.filter((item) => item.status === "UNCHANGED") ?? [], [comparison]);
  const visible = filter === "ALL" ? changed : changed.filter((item) => item.status === filter);

  if (query.isLoading) return <LoadingState label="משווים בין הגרסאות" />;
  if (query.error || !comparison) return <ErrorNotice message={messageForError(query.error, "לא הצלחנו להשוות בין הגרסאות.")} />;

  const { base, target, cost } = comparison;
  const costDifference = cost.before !== null && cost.after !== null ? cost.after - cost.before : null;
  const changedProtections = comparison.protections.filter((protection) => protection.before !== protection.after);

  return (
    <div className="page-wrap compare-page">
      <PageHeader
        eyebrow="השוואת גרסאות"
        title="מה השתנה בחוזה"
        description={`השוואה בין גרסה ${base.version} (${formatDate(base.createdAt)}) לגרסה ${target.version} (${formatDate(target.createdAt)}).`}
        actions={<Link className="secondary-button" to={ROUTES.analysis(target.analysisId)}>לתוצאות הגרסה החדשה <ArrowLeft size={17} /></Link>}
      />

      <section className="top-summary">
        <div className="top-summary-headline"><Sparkles size={20} /><p>{comparison.headline}</p></div>
        <div className="compare-versions">
          <VersionCard label="גרסה קודמת" version={base} />
          <GitCompareArrows size={22} aria-hidden="true" />
          <VersionCard label="גרסה חדשה" version={target} />
        </div>
      </section>

      {comparison.warnings.length ? <ul className="cost-notes compare-warnings">{comparison.warnings.map((warning) => <li key={warning}><Info size={14} /> {warning}</li>)}</ul> : null}

      <section className="compare-overview" aria-label="סיכום השינויים">
        {STATUS_ORDER.filter((status) => comparison.counts[status]).map((status) => (
          <button key={status} type="button" className={`compare-count status-${STATUS_META[status].tone}${filter === status ? " active" : ""}`} onClick={() => setFilter(filter === status ? "ALL" : status)} aria-pressed={filter === status}>
            <strong>{comparison.counts[status]}</strong><span>{STATUS_META[status].label}</span>
          </button>
        ))}
        {costDifference !== null ? (
          <article className={`compare-cost ${costDifference > 0 ? "cost-up" : costDifference < 0 ? "cost-down" : ""}`}>
            <span>שינוי בעלות החוזה</span>
            <strong>{costDifference === 0 ? "ללא שינוי" : `${costDifference > 0 ? "+" : "−"}${formatCurrency(Math.abs(costDifference))}`}</strong>
            <small>{formatCurrency(cost.before!)} ← {formatCurrency(cost.after!)}</small>
          </article>
        ) : null}
      </section>

      <div className="compare-layout">
        <section className="compare-items" aria-label="השינויים">
          <div className="section-heading">
            <div><span className="eyebrow">סעיף מול סעיף</span><h2>{filter === "ALL" ? "כל השינויים" : STATUS_META[filter].label}</h2></div>
            {filter !== "ALL" ? <button className="ghost-button compact-button" type="button" onClick={() => setFilter("ALL")}>הצגת הכול</button> : null}
          </div>
          {visible.length ? visible.map((item, index) => <ComparisonCard key={`${item.status}-${index}`} item={item} baseId={base.analysisId} targetId={target.analysisId} />) : <p className="compare-empty">אין שינויים מהסוג הזה.</p>}
          {unchanged.length ? (
            <details className="compare-unchanged">
              <summary>{unchanged.length} סעיפים שלא השתנו באופן מהותי</summary>
              <ul>{unchanged.map((item, index) => (
                <li key={index}>{item.after?.label ?? item.before?.label}{item.renumberedOnly ? ", השתנה רק מספור הסעיפים" : ""}{item.moved ? ", הסעיף עבר למקום אחר בחוזה" : ""}</li>
              ))}</ul>
            </details>
          ) : null}
        </section>

        <aside className="compare-protections protection-panel">
          <div className="section-heading"><div><span className="eyebrow">רשימת בדיקה</span><h2>הגנות בחוזה</h2></div></div>
          {changedProtections.length ? null : <p className="compare-empty">ההגנות זהות בשתי הגרסאות.</p>}
          <ul>
            {comparison.protections.map((protection) => (
              <li key={protection.protectionId} className={protection.before !== protection.after ? "changed" : ""}>
                <span>{protection.title}</span>
                <div>
                  {protection.before ? <StatusBadge tone={PROTECTION_LABELS[protection.before].tone}>{PROTECTION_LABELS[protection.before].label}</StatusBadge> : "אין"}
                  <ArrowLeft size={13} aria-label="השתנה ל" />
                  {protection.after ? <StatusBadge tone={PROTECTION_LABELS[protection.after].tone}>{PROTECTION_LABELS[protection.after].label}</StatusBadge> : "אין"}
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>
      <div className="legal-disclaimer"><Info size={18} /><span>ההשוואה נעשתה אוטומטית ואינה ייעוץ משפטי. כדאי לקרוא את הגרסה החדשה במלואה לפני החתימה.</span></div>
    </div>
  );
}

function VersionCard({ label, version }: { label: string; version: { version: number; fileName: string; summary: { critical: number; warnings: number } } }) {
  return (
    <div className="compare-version">
      <span>{label} · גרסה {version.version}</span>
      <strong title={version.fileName}>{version.fileName}</strong>
      <small><b className="summary-red">{version.summary.critical}</b> דורשים טיפול, <b className="summary-orange">{version.summary.warnings}</b> כדאי לבדוק</small>
    </div>
  );
}

// One column of the side-by-side text: the shared words, plus what this side has and the other
// lacks (deletions on the old side, insertions on the new one).
function DiffText({ parts, side }: { parts: DiffPart[]; side: "before" | "after" }) {
  const hidden = side === "before" ? "insert" : "delete";
  return (
    <p className="diff-text">
      {parts.filter((part) => part.op !== hidden).map((part, index) => (
        part.op === "equal" ? <span key={index}>{part.text}</span> : side === "before"
          ? <del key={index}>{part.text}</del>
          : <ins key={index}>{part.text}</ins>
      ))}
    </p>
  );
}

function SideColumn({ title, side, item, analysisId }: { title: string; side: ComparisonSide | null; item: ComparisonItem; analysisId: string }) {
  if (!side) return <div className="compare-side empty"><span className="eyebrow">{title}</span><p>{item.change === "ADDED" ? "הסעיף לא היה בגרסה הקודמת." : "הסעיף הוסר בגרסה החדשה."}</p></div>;
  return (
    <div className="compare-side">
      <div className="compare-side-head">
        <span className="eyebrow">{title}</span>
        <Link to={`${ROUTES.analysis(analysisId)}#finding-${side.clauseIds[0]}`}>{side.label}</Link>
      </div>
      {side.severity ? <div className="compare-side-severity"><StatusBadge tone={SEVERITY_META[side.severity].tone}>{SEVERITY_META[side.severity].label}</StatusBadge>{side.title ? <span>{side.title}</span> : null}</div> : null}
      {item.diff ? <DiffText parts={item.diff} side={title === "לפני" ? "before" : "after"} /> : <p className="diff-text">{side.text}</p>}
    </div>
  );
}

function ComparisonCard({ item, baseId, targetId }: { item: ComparisonItem; baseId: string; targetId: string }) {
  const meta = STATUS_META[item.status];
  return (
    <article className={`compare-item compare-${meta.tone}`}>
      <header>
        <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
        <span className="compare-change">{CHANGE_LABELS[item.change]}{item.moved ? <> · <MoveVertical size={12} /> הסעיף עבר מקום</> : null}</span>
        {item.numberChanges.length ? (
          <span className="number-changes">{item.numberChanges.map((change, index) => <b key={index}>{change.before} ← {change.after}</b>)}</span>
        ) : null}
      </header>
      <p className="compare-explainer">{meta.description}</p>
      <div className="compare-columns">
        <SideColumn title="לפני" side={item.before} item={item} analysisId={baseId} />
        <SideColumn title="אחרי" side={item.after} item={item} analysisId={targetId} />
      </div>
    </article>
  );
}
