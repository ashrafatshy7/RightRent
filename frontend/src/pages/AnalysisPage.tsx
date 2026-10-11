import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  GitMerge,
  Link2,
  FileCheck2,
  FileText,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api, messageForError } from "../lib/api-client";
import { clauseLabel, formatCurrency, formatDate, formatDuration, formatNumber } from "../lib/format";
import { useMediaQuery } from "../lib/use-media-query";
import type { Analysis, CrossClauseIssueKind, DeterministicCheck, Finding, FindingCategory, Severity } from "../types/api";
import type { FocusRequest, ViewerHighlight } from "../components/ContractViewer";

// pdf.js is large; it loads only when an analysis is actually opened.
const ContractViewer = lazy(() => import("../components/ContractViewer"));

const NARROW_LAYOUT_QUERY = "(max-width: 1080px)";

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Keeps the selected finding in the address bar for sharing and reloads, without adding a history
// entry per click and without firing hashchange (which would re-run the selection).
function replaceHash(clauseId: string) {
  window.history.replaceState(window.history.state, "", `#finding-${encodeURIComponent(clauseId)}`);
}

const severityMeta: Record<Severity, { label: string; tone: string; icon: typeof AlertOctagon }> = {
  RED: { label: "דורש טיפול", tone: "danger", icon: AlertOctagon },
  ORANGE: { label: "כדאי לבדוק", tone: "warning", icon: AlertTriangle },
  OK: { label: "תקין", tone: "success", icon: CheckCircle2 },
};

// The severity badge (RED/ORANGE/OK) stays the single top-level label. This is a secondary,
// smaller chip shown alongside it so a tenant can tell a genuine legal problem apart from a
// negotiable risk or a personal-preference mismatch, without introducing a second severity system.
const categoryMeta: Record<FindingCategory, string> = {
  legal_compliance: "בעיה משפטית",
  contractual_risk: "סיכון חוזי",
  tenant_preference: "התאמה להעדפות שלך",
  informational: "מידע כללי",
};

// Problems that exist only in the combination of clauses, named for the tenant.
const crossClauseKindLabel: Record<CrossClauseIssueKind, string> = {
  CONFLICT: "סתירה בין סעיפים",
  OVERRIDE: "סעיף שמבטל הגנה",
  COMBINED_EFFECT: "השפעה משולבת",
};

function formatCheckValue(value: number, unit: DeterministicCheck["unit"]) {
  return unit === "ILS" ? formatCurrency(value) : `${formatNumber(value)} ימים`;
}

export function AnalysisPage() {
  const { analysisId = "" } = useParams();
  const { token } = useAuth();
  const [filter, setFilter] = useState<Severity | "ALL">("ALL");
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [selectedClauseId, setSelectedClauseId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [cardRequest, setCardRequest] = useState<FocusRequest | null>(null);
  const [sideTab, setSideTab] = useState<"contract" | "protections">("contract");
  const [showCompliant, setShowCompliant] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isNarrow = useMediaQuery(NARROW_LAYOUT_QUERY);
  const query = useQuery({ queryKey: ["analysis", analysisId], queryFn: () => api.getAnalysis(token!, analysisId), enabled: Boolean(analysisId) });
  const analysis = query.data?.analysis;
  const contractFile = useQuery({
    queryKey: ["contract-file", analysis?.contractId],
    queryFn: () => api.getContractFile(token!, analysis!.contractId),
    enabled: Boolean(analysis),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const findingsByClauseId = useMemo(
    () => new Map((analysis?.findings ?? []).map((finding) => [finding.clauseId, finding])),
    [analysis],
  );
  const filtered = useMemo(() => analysis?.findings.filter((finding) => filter === "ALL" || finding.severity === filter) ?? [], [analysis, filter]);
  const keyFindings = useMemo(
    () => (analysis?.keyFindingIds ?? [])
      .map((clauseId) => findingsByClauseId.get(clauseId))
      .filter((finding): finding is Finding => Boolean(finding)),
    [analysis, findingsByClauseId],
  );
  // Compliant clauses stay unmarked by default so the problems stand out, but a clause the reader
  // explicitly asked to see is always drawn.
  const viewerHighlights = useMemo<ViewerHighlight[]>(
    () => (analysis?.findings ?? [])
      .filter((finding) => finding.locations?.length
        && (finding.severity !== "OK" || showCompliant || filter === "OK" || finding.clauseId === selectedClauseId))
      .map((finding) => ({
        clauseId: finding.clauseId,
        severity: finding.severity,
        severityLabel: severityMeta[finding.severity].label,
        label: clauseLabel(finding),
        title: finding.title,
        locations: finding.locations,
      })),
    [analysis, showCompliant, filter, selectedClauseId],
  );
  const dimmedClauseIds = useMemo(
    () => new Set(filter === "ALL" ? [] : (analysis?.findings ?? [])
      .filter((finding) => finding.severity !== filter)
      .map((finding) => finding.clauseId)),
    [analysis, filter],
  );
  // The clauses read together with the selected one, and other findings on its topic, are outlined.
  const linkedClauseIds = useMemo(() => {
    const selected = selectedClauseId ? findingsByClauseId.get(selectedClauseId) : undefined;
    return new Set([
      ...(selected?.relatedFindingIds ?? []),
      ...(selected?.contextClauses ?? []).map((link) => link.clauseId),
    ]);
  }, [selectedClauseId, findingsByClauseId]);

  // Every in-page link to a finding (the top summary, "related to", protections) is a #finding-ID
  // anchor, so following the hash keeps the document in step with all of them at once.
  useEffect(() => {
    function selectFromHash() {
      const match = /^#finding-(.+)$/u.exec(window.location.hash);
      if (!match?.[1]) return;
      const clauseId = decodeURIComponent(match[1]);
      setSelectedClauseId(clauseId);
      setFocusRequest({ clauseId, nonce: Date.now() });
      setCardRequest({ clauseId, nonce: Date.now() });
    }
    selectFromHash();
    window.addEventListener("hashchange", selectFromHash);
    return () => window.removeEventListener("hashchange", selectFromHash);
  }, []);

  useEffect(() => {
    if (!cardRequest || !analysis) return;
    const card = document.getElementById(`finding-${cardRequest.clauseId}`);
    card?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    card?.focus({ preventScroll: true });
  }, [cardRequest, analysis]);

  const showInContract = useCallback((clauseId: string) => {
    setSelectedClauseId(clauseId);
    setFocusRequest({ clauseId, nonce: Date.now() });
    setSideTab("contract");
    if (isNarrow) setSheetOpen(true);
    replaceHash(clauseId);
  }, [isNarrow]);

  const selectFromDocument = useCallback((clauseId: string) => {
    setSelectedClauseId(clauseId);
    const finding = findingsByClauseId.get(clauseId);
    if (finding && filter !== "ALL" && finding.severity !== filter) setFilter("ALL");
    setSheetOpen(false);
    replaceHash(clauseId);
    setCardRequest({ clauseId, nonce: Date.now() });
  }, [findingsByClauseId, filter]);

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

  const incompleteProtections = analysis.protectionReport.filter((protection) => protection.status !== "COVERED").length;
  const protectionPanel = <ProtectionPanel analysis={analysis} findingsByClauseId={findingsByClauseId} onShowClause={showInContract} />;

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

      {analysis.headline || keyFindings.length ? (
        <section className="top-summary">
          {analysis.headline ? <div className="top-summary-headline"><Sparkles size={20} /><p>{analysis.headline}</p></div> : null}
          {keyFindings.length ? (
            <div>
              <span className="eyebrow">החשוב ביותר</span>
              <ol className="top-summary-list">
                {keyFindings.map((finding) => (
                  <li key={finding.clauseId}>
                    <a href={`#finding-${finding.clauseId}`}>
                      <StatusBadge tone={severityMeta[finding.severity].tone}>{severityMeta[finding.severity].label}</StatusBadge>
                      <span>{finding.title}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>
      ) : null}

      {analysis.crossClauseIssues?.length ? (
        <section className="cross-clause-issues" aria-labelledby="cross-clause-title">
          <div className="section-heading"><div><span className="eyebrow">מעבר לסעיף הבודד</span><h2 id="cross-clause-title">בעיות שנובעות משילוב של סעיפים</h2></div><GitMerge size={22} /></div>
          <ul>
            {analysis.crossClauseIssues.map((issue) => (
              <li key={`${issue.kind}-${issue.clauseIds.join("-")}`} className={`cross-clause-issue severity-${issue.severity.toLowerCase()}`}>
                <div className="cross-clause-kind"><StatusBadge tone={severityMeta[issue.severity].tone}>{crossClauseKindLabel[issue.kind]}</StatusBadge></div>
                <p>{issue.explanation}</p>
                <div className="clause-chips">
                  {issue.clauseIds.map((clauseId) => {
                    const finding = findingsByClauseId.get(clauseId);
                    return <button key={clauseId} type="button" className="clause-chip" onClick={() => showInContract(clauseId)}>{finding ? clauseLabel(finding) : clauseId}</button>;
                  })}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="analysis-workspace">
        <section className="findings-section">
          <div className="section-heading">
            <div><span className="eyebrow">סעיף אחר סעיף</span><h2>הממצאים</h2></div>
            <div className="findings-tools">
              {isNarrow ? <button className="show-in-contract" type="button" onClick={() => setSheetOpen(true)}><FileText size={14} /> החוזה המלא</button> : null}
              <div className="filter-pills">{(["ALL", "RED", "ORANGE", "OK"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} type="button" onClick={() => setFilter(value)}>{value === "ALL" ? "הכול" : severityMeta[value].label}</button>)}</div>
            </div>
          </div>
          <div className="findings-list">{filtered.map((finding) => (
            <FindingCard
              key={finding.clauseId}
              finding={finding}
              findingsByClauseId={findingsByClauseId}
              selected={finding.clauseId === selectedClauseId}
              onShowInContract={finding.locations?.length ? () => showInContract(finding.clauseId) : undefined}
              onShowClause={showInContract}
            />
          ))}</div>
          {isNarrow ? <div className="protection-panel inline-protections">{protectionPanel}</div> : null}
        </section>

        <aside className={`analysis-side ${sheetOpen ? "sheet-open" : ""}`} aria-label="החוזה וההגנות">
          {isNarrow ? null : (
            <div className="side-tabs" role="tablist" aria-label="תצוגה">
              <button type="button" role="tab" aria-selected={sideTab === "contract"} className={sideTab === "contract" ? "active" : ""} onClick={() => setSideTab("contract")}><FileText size={16} /> החוזה</button>
              <button type="button" role="tab" aria-selected={sideTab === "protections"} className={sideTab === "protections" ? "active" : ""} onClick={() => setSideTab("protections")}><FileCheck2 size={16} /> הגנות{incompleteProtections ? <b>{incompleteProtections}</b> : null}</button>
            </div>
          )}
          <div className="side-body side-contract" hidden={!isNarrow && sideTab !== "contract"}>
            <label className="compliant-toggle"><input type="checkbox" checked={showCompliant} onChange={(event) => setShowCompliant(event.target.checked)} /> להציג גם סעיפים תקינים</label>
            {contractFile.data ? (
              <Suspense fallback={<div className="viewer-message"><LoadingState label="טוענים את מציג החוזה" /></div>}>
                <ContractViewer
                  data={contractFile.data}
                  highlights={viewerHighlights}
                  selectedClauseId={selectedClauseId}
                  focusRequest={focusRequest}
                  dimmedClauseIds={dimmedClauseIds}
                  linkedClauseIds={linkedClauseIds}
                  onSelect={selectFromDocument}
                  {...(isNarrow ? { onClose: () => setSheetOpen(false) } : {})}
                />
              </Suspense>
            ) : contractFile.error ? (
              <div className="viewer-message"><FileText size={22} /><p>{messageForError(contractFile.error)} הממצאים עדיין זמינים ברשימה.</p>{isNarrow ? <button className="ghost-button compact-button" type="button" onClick={() => setSheetOpen(false)}>סגירה</button> : null}</div>
            ) : (
              <div className="viewer-message"><LoadingState label="טוענים את החוזה" /></div>
            )}
          </div>
          {isNarrow ? null : <div className="side-body side-protections protection-panel" hidden={sideTab !== "protections"}>{protectionPanel}</div>}
        </aside>
      </div>
      <div className="legal-disclaimer"><ShieldCheck size={18} /><span>הניתוח הוא כלי תומך החלטה ואינו ייעוץ משפטי. בממצא קריטי מומלץ להתייעץ עם איש מקצוע.</span></div>
    </div>
  );
}

function ProtectionPanel({ analysis, findingsByClauseId, onShowClause }: { analysis: Analysis; findingsByClauseId: Map<string, Finding>; onShowClause: (clauseId: string) => void }) {
  return (
    <>
      <div className="section-heading"><div><span className="eyebrow">מעבר לסעיפים</span><h2>הגנות שכדאי לבדוק</h2></div><FileCheck2 size={24} /></div>
      <div className="protection-progress"><span style={{ width: `${coveragePercent(analysis)}%` }} /><small>{coveragePercent(analysis)}% מההגנות מכוסות</small></div>
      <div className="protection-list">
        {analysis.protectionReport.map((protection) => {
          const linkedFindings = protection.relevantClauseIds
            .map((clauseId) => findingsByClauseId.get(clauseId))
            .filter((finding): finding is Finding => Boolean(finding));
          return (
            <article key={protection.protectionId} className={`protection-item protection-${protection.status.toLowerCase()}`}>
              <div><strong>{protection.title}</strong><StatusBadge tone={protection.status === "COVERED" ? "success" : protection.status === "PARTIAL" ? "warning" : "danger"}>{protection.status === "COVERED" ? "מכוסה" : protection.status === "PARTIAL" ? "חלקי" : "חסר"}</StatusBadge></div>
              <p>{protection.explanation}</p>
              {linkedFindings.length ? (
                <p className="protection-cross-link">
                  קשור לממצא: {linkedFindings.map((finding, index) => (
                    <span key={finding.clauseId}>{index > 0 ? ", " : ""}<a href={`#finding-${finding.clauseId}`} onClick={() => onShowClause(finding.clauseId)}>{finding.title}</a></span>
                  ))}
                </p>
              ) : null}
              {protection.suggestedText ? <details><summary>ניסוח מוצע</summary><blockquote>{protection.suggestedText}</blockquote></details> : null}
            </article>
          );
        })}
      </div>
    </>
  );
}

function ScoreCard({ tone, value, label, icon: Icon }: { tone: string; value: number; label: string; icon: typeof AlertOctagon }) {
  return <article className={`score-card score-${tone}`}><span><Icon size={22} /></span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

function FindingCard({ finding, findingsByClauseId, selected, onShowInContract, onShowClause }: { finding: Finding; findingsByClauseId: Map<string, Finding>; selected: boolean; onShowInContract: (() => void) | undefined; onShowClause: (clauseId: string) => void }) {
  const meta = severityMeta[finding.severity];
  const Icon = meta.icon;
  const [copied, setCopied] = useState(false);
  // Analyses saved before this redesign lack the new fields entirely; these fall back gracefully
  // instead of crashing (e.g. .map on a missing relatedFindingIds) so older history stays viewable.
  const relatedFindings = (finding.relatedFindingIds ?? [])
    .map((clauseId) => findingsByClauseId.get(clauseId))
    .filter((related): related is Finding => Boolean(related));
  const plainLanguageExplanation = finding.plainLanguageExplanation ?? finding.explanation;
  const labelFor = (clauseId: string) => {
    const clause = findingsByClauseId.get(clauseId);
    return clause ? clauseLabel(clause) : clauseId;
  };

  async function copySuggestedText() {
    if (!finding.suggestedReplacementText) return;
    try {
      await navigator.clipboard.writeText(finding.suggestedReplacementText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be blocked by the browser; the text is still visible to copy by hand.
    }
  }

  return (
    <article id={`finding-${finding.clauseId}`} tabIndex={-1} className={`finding-card finding-${finding.severity.toLowerCase()}${selected ? " selected" : ""}`}>
      <div className="finding-marker"><Icon size={20} /></div>
      <div className="finding-body">
        <header>
          <div><span>{clauseLabel(finding)}</span><h3>{finding.title}</h3></div>
          <div className="finding-badges">
            <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            {finding.severity !== "OK" && finding.category ? <span className="finding-category-chip">{categoryMeta[finding.category]}</span> : null}
            {onShowInContract ? <button className="show-in-contract" type="button" onClick={onShowInContract} aria-pressed={selected}><ScanSearch size={14} /> הצג בחוזה</button> : null}
          </div>
        </header>

        {finding.clauseQuote ? <blockquote className="finding-quote"><span className="eyebrow">מה כתוב בחוזה</span>{finding.clauseQuote}</blockquote> : null}

        <div className="finding-section">
          <strong>מה זה אומר עבורכם</strong>
          <p>{plainLanguageExplanation}</p>
        </div>

        {finding.severity !== "OK" && finding.whyItMatters ? (
          <div className="finding-section">
            <strong>למה סימנו את זה</strong>
            <p>{finding.whyItMatters}</p>
          </div>
        ) : null}

        {finding.recommendedAction ? (
          <div className="finding-action">
            <strong>מה כדאי לעשות</strong>
            <p>{finding.recommendedAction}</p>
          </div>
        ) : null}

        {finding.crossClauseIssue ? (
          <div className="finding-cross-clause">
            <strong><GitMerge size={15} /> {crossClauseKindLabel[finding.crossClauseIssue.kind]} עם {finding.crossClauseIssue.clauseIds.map(labelFor).join(", ")}</strong>
            <p>{finding.crossClauseIssue.explanation}</p>
          </div>
        ) : null}

        {finding.contextClauses?.length ? (
          <div className="finding-context">
            <span><Link2 size={14} /> נבדק יחד עם</span>
            <ul>
              {finding.contextClauses.map((link) => (
                <li key={link.clauseId} className={link.usedInAnalysis ? "used" : ""}>
                  <button type="button" className="clause-chip" onClick={() => onShowClause(link.clauseId)} title={link.usedInAnalysis ? "שימש בניתוח הסעיף" : "סופק כהקשר"}>{labelFor(link.clauseId)}</button>
                  <small>{link.reason}</small>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {relatedFindings.length ? (
          <p className="finding-related">
            קשור גם ל: {relatedFindings.map((related, index) => (
              <span key={related.clauseId}>{index > 0 ? ", " : ""}<a href={`#finding-${related.clauseId}`}>{related.title}</a></span>
            ))}
          </p>
        ) : null}

        {finding.suggestedReplacementText ? (
          <details className="finding-suggestion">
            <summary>ניסוח מוצע לשיחה עם המשכיר</summary>
            <blockquote>{finding.suggestedReplacementText}</blockquote>
            <div className="finding-suggestion-actions">
              <button className="ghost-button compact-button" type="button" onClick={copySuggestedText}><Copy size={14} /> {copied ? "הועתק" : "העתקת הניסוח"}</button>
              <small>הצעת ניסוח למשא ומתן בלבד, לא ייעוץ משפטי מחייב.</small>
            </div>
          </details>
        ) : null}

        <details className="finding-legal-details">
          <summary>הסבר משפטי מורחב ומקורות</summary>
          <p>{finding.explanation}</p>
          {finding.deterministicChecks?.length ? (
            <ul className="deterministic-checks">
              {finding.deterministicChecks.map((check) => (
                <li key={check.ruleId}>
                  {check.label}: {formatCheckValue(check.contractValue, check.unit)} לעומת התקרה {formatCheckValue(check.calculatedLimit, check.unit)}
                  {check.passesRule ? " (בתוך התקרה)" : " (מעל התקרה)"}
                  {check.formula ? <span className="check-formula">איך חושב: {check.formula}</span> : null}
                  {check.sourceClauseIds?.length ? <span className="check-formula">הנתונים נלקחו מ{check.sourceClauseIds.map(labelFor).join(" ומ")}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {finding.legalReferences.length ? (
            <>
              <div className="legal-references">
                {finding.legalReferences.map((reference) => (
                  <a key={reference.lawReferenceId} href={reference.sourceUrl} target="_blank" rel="noreferrer"><ScaleReference />{reference.lawName}{reference.section ? ` · סעיף ${reference.section}` : ""}<ExternalLink size={13} /></a>
                ))}
              </div>
              {finding.legalReferences.filter((reference) => reference.excerpt).map((reference) => (
                <blockquote key={reference.lawReferenceId} className="legal-excerpt">
                  {reference.excerpt}
                  {reference.sourceAsOf ? <cite> — {reference.lawName}, מאוחזר {formatDate(reference.sourceAsOf)}</cite> : null}
                </blockquote>
              ))}
            </>
          ) : null}
        </details>
      </div>
    </article>
  );
}

function ScaleReference() { return <span aria-hidden="true">§</span>; }

function coveragePercent(analysis: Analysis) {
  if (!analysis.protectionReport.length) return 100;
  const score = analysis.protectionReport.reduce((total, protection) => total + (protection.status === "COVERED" ? 1 : protection.status === "PARTIAL" ? 0.5 : 0), 0);
  return Math.round(score / analysis.protectionReport.length * 100);
}
