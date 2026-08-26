import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, CheckCircle2, Download, ExternalLink, FileCheck2, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api, messageForError } from "../lib/api-client";
import { formatDate, formatDuration } from "../lib/format";
import type { Analysis, Finding, Severity } from "../types/api";

const severityMeta: Record<Severity, { label: string; tone: string; icon: typeof AlertOctagon }> = {
  RED: { label: "דורש טיפול", tone: "danger", icon: AlertOctagon },
  ORANGE: { label: "כדאי לבדוק", tone: "warning", icon: AlertTriangle },
  OK: { label: "תקין", tone: "success", icon: CheckCircle2 },
};

export function AnalysisPage() {
  const { analysisId = "" } = useParams();
  const { token } = useAuth();
  const [filter, setFilter] = useState<Severity | "ALL">("ALL");
  const [pdfError, setPdfError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["analysis", analysisId], queryFn: () => api.getAnalysis(token!, analysisId), enabled: Boolean(analysisId) });
  const analysis = query.data?.analysis;
  const filtered = useMemo(() => analysis?.findings.filter((finding) => filter === "ALL" || finding.severity === filter) ?? [], [analysis, filter]);

  if (query.isLoading) return <LoadingState label="פותחים את מפת החוזה" />;
  if (query.error || !analysis) return <ErrorNotice message={messageForError(query.error, "הניתוח לא נמצא.")} />;

  async function openMarkedPdf() {
    setPdfError(null);
    try {
      const blob = await api.getMarkedPdf(token!, analysisId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setPdfError(messageForError(error));
    }
  }

  return (
    <div className="page-wrap analysis-page">
      <PageHeader eyebrow={`ניתוח ${analysis.analysisId.slice(0, 8)}`} title="מפת החוזה שלך" description={`הושלם ${formatDate(analysis.createdAt)} · ${formatDuration(analysis.timingMs.total)}`} actions={analysis.markedPdf ? <button className="secondary-button" type="button" onClick={openMarkedPdf}><Download size={17} /> PDF מסומן</button> : undefined} />
      {pdfError ? <ErrorNotice message={pdfError} /> : null}
      <section className="analysis-overview">
        <ScoreCard tone="critical" value={analysis.summary.critical} label="סעיפים קריטיים" icon={AlertOctagon} />
        <ScoreCard tone="warning" value={analysis.summary.warnings} label="אזהרות והתאמות" icon={AlertTriangle} />
        <ScoreCard tone="success" value={analysis.summary.compliant} label="סעיפים תקינים" icon={CheckCircle2} />
        <article className="privacy-card"><ShieldCheck size={24} /><div><strong>הפרטיות נשמרה</strong><span>{analysis.privacy.redactedEntityCount} פרטים הוסרו · {analysis.privacy.mode === "REGEX_AND_DICTABERT" ? "DictaBERT מקומי" : "מצב בדיקה"}</span></div></article>
      </section>

      <div className="analysis-columns">
        <section className="findings-section">
          <div className="section-heading"><div><span className="eyebrow">סעיף אחר סעיף</span><h2>הממצאים</h2></div><div className="filter-pills">{(["ALL", "RED", "ORANGE", "OK"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} type="button" onClick={() => setFilter(value)}>{value === "ALL" ? "הכול" : severityMeta[value].label}</button>)}</div></div>
          <div className="findings-list">{filtered.map((finding) => <FindingCard key={finding.clauseId} finding={finding} />)}</div>
        </section>

        <aside className="protection-panel">
          <div className="section-heading"><div><span className="eyebrow">מעבר לסעיפים</span><h2>הגנות בחוזה</h2></div><FileCheck2 size={24} /></div>
          <div className="protection-progress"><span style={{ width: `${coveragePercent(analysis)}%` }} /><small>{coveragePercent(analysis)}% מההגנות מכוסות</small></div>
          <div className="protection-list">{analysis.protectionReport.map((protection) => <article key={protection.protectionId} className={`protection-item protection-${protection.status.toLowerCase()}`}><div><strong>{protection.title}</strong><StatusBadge tone={protection.status === "COVERED" ? "success" : protection.status === "PARTIAL" ? "warning" : "danger"}>{protection.status === "COVERED" ? "מכוסה" : protection.status === "PARTIAL" ? "חלקי" : "חסר"}</StatusBadge></div><p>{protection.explanation}</p>{protection.suggestedText ? <details><summary>ניסוח מוצע</summary><blockquote>{protection.suggestedText}</blockquote></details> : null}</article>)}</div>
        </aside>
      </div>
      <div className="legal-disclaimer"><ShieldCheck size={18} /><span>הניתוח הוא כלי תומך החלטה ואינו ייעוץ משפטי. בממצא קריטי מומלץ להתייעץ עם איש מקצוע.</span></div>
    </div>
  );
}

function ScoreCard({ tone, value, label, icon: Icon }: { tone: string; value: number; label: string; icon: typeof AlertOctagon }) {
  return <article className={`score-card score-${tone}`}><span><Icon size={22} /></span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

function FindingCard({ finding }: { finding: Finding }) {
  const meta = severityMeta[finding.severity];
  const Icon = meta.icon;
  return (
    <article className={`finding-card finding-${finding.severity.toLowerCase()}`}>
      <div className="finding-marker"><Icon size={20} /></div>
      <div className="finding-body"><header><div><span>{finding.clauseId}</span><h3>{finding.title}</h3></div><StatusBadge tone={meta.tone}>{meta.label}</StatusBadge></header><p>{finding.explanation}</p>{finding.legalReferences.length ? <div className="legal-references">{finding.legalReferences.map((reference) => <a key={reference.lawReferenceId} href={reference.sourceUrl} target="_blank" rel="noreferrer"><ScaleReference />{reference.lawName}{reference.section ? ` · סעיף ${reference.section}` : ""}<ExternalLink size={13} /></a>)}</div> : null}</div>
    </article>
  );
}

function ScaleReference() { return <span aria-hidden="true">§</span>; }

function coveragePercent(analysis: Analysis) {
  if (!analysis.protectionReport.length) return 100;
  const score = analysis.protectionReport.reduce((total, protection) => total + (protection.status === "COVERED" ? 1 : protection.status === "PARTIAL" ? 0.5 : 0), 0);
  return Math.round(score / analysis.protectionReport.length * 100);
}
