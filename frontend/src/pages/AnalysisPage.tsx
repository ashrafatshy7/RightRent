import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Calculator,
  Download,
  FilePlus2,
  GitCompareArrows,
  ExternalLink,
  GitMerge,
  Link2,
  ListChecks,
  MessageCircle,
  FileCheck2,
  FileText,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { CostSimulator } from "../components/CostSimulator";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ROUTES } from "../config/app";
import { api, messageForError } from "../lib/api-client";
import { clauseLabel, formatCurrency, formatDate, formatNumber } from "../lib/format";
import { useMediaQuery } from "../lib/use-media-query";
import { previousVersionAnalysis } from "../lib/versions";
import type { Analysis, CrossClauseIssueKind, DeterministicCheck, Finding, FindingCategory, Protection, Severity } from "../types/api";
import type { FocusRequest, ViewerHighlight } from "../components/ContractViewer";

// pdf.js is large; it loads only when an analysis is actually opened.
const ContractViewer = lazy(() => import("../components/ContractViewer"));

const NARROW_LAYOUT_QUERY = "(max-width: 1080px)";

// Object URLs of opened marked PDFs, kept for the life of the app. Safari re-reads the blob when the
// opened PDF is clicked, so revoking it on a timer broke the tab ("WebKitBlobResource error 1").
const markedPdfUrls = new Map<string, string>();

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
  legal_compliance: "סותר את החוק",
  contractual_risk: "סיכון בחוזה",
  tenant_preference: "לא מתאים להעדפות שלכם",
  informational: "מידע כללי",
};

// Problems that exist only in the combination of clauses, named for the tenant.
const crossClauseKindLabel: Record<CrossClauseIssueKind, string> = {
  CONFLICT: "סתירה בין סעיפים",
  OVERRIDE: "סעיף שמבטל הגנה",
  COMBINED_EFFECT: "השפעה משולבת",
};

// "ISSUES" (the default) lists only what needs attention; compliant clauses are one click away.
type FindingFilter = Severity | "ISSUES" | "ALL";
type MainTab = "findings" | "protections" | "cost";

function matchesFilter(finding: Finding, filter: FindingFilter) {
  if (filter === "ALL") return true;
  if (filter === "ISSUES") return finding.severity !== "OK";
  return finding.severity === filter;
}

function countLabel(count: number, one: string, many: string) {
  return count === 1 ? one : `${count} ${many}`;
}

function verdictFor(summary: Analysis["summary"]) {
  if (summary.critical > 0) {
    return {
      tone: "critical",
      icon: AlertOctagon,
      title: `${countLabel(summary.critical, "סעיף אחד בחוזה דורש", "סעיפים בחוזה דורשים")} טיפול לפני החתימה`,
      text: "סעיפים כאלה סותרים את החוק או עלולים לפגוע בכם. כדאי לבקש מהמשכיר לתקן אותם לפני שחותמים.",
    };
  }
  if (summary.warnings > 0) {
    return {
      tone: "warning",
      icon: AlertTriangle,
      title: `לא מצאנו בעיות חמורות, אבל יש ${countLabel(summary.warnings, "סעיף אחד", "סעיפים")} שכדאי לבדוק`,
      text: "החוזה סביר ברובו. כדאי לעבור על הנקודות שסימנו ולנסות לשפר אותן מול המשכיר.",
    };
  }
  return {
    tone: "success",
    icon: CheckCircle2,
    title: "לא מצאנו בעיות בחוזה",
    text: "כל הסעיפים שבדקנו נראים תקינים. עדיין כדאי לקרוא את החוזה במלואו לפני החתימה.",
  };
}

function formatCheckValue(value: number, unit: DeterministicCheck["unit"]) {
  return unit === "ILS" ? formatCurrency(value) : `${formatNumber(value)} ימים`;
}

export function AnalysisPage() {
  const { analysisId = "" } = useParams();
  const { token } = useAuth();
  const [filter, setFilter] = useState<FindingFilter>("ISSUES");
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [selectedClauseId, setSelectedClauseId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [cardRequest, setCardRequest] = useState<FocusRequest | null>(null);
  const [showCompliant, setShowCompliant] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mainTab, setMainTab] = useState<MainTab>("findings");
  const handledCardRequest = useRef<number | null>(null);
  const isNarrow = useMediaQuery(NARROW_LAYOUT_QUERY);
  const query = useQuery({ queryKey: ["analysis", analysisId], queryFn: () => api.getAnalysis(token!, analysisId), enabled: Boolean(analysisId) });
  const analysis = query.data?.analysis;
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.getHistory(token!) });
  const historyEntry = history.data?.analyses.find((entry) => entry.analysisId === analysisId);
  const previousVersion = history.data ? previousVersionAnalysis(history.data.analyses, analysisId) : null;
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
  const filtered = useMemo(() => analysis?.findings.filter((finding) => matchesFilter(finding, filter)) ?? [], [analysis, filter]);
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
      .filter((finding) => !matchesFilter(finding, filter))
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

  // A #finding-ID in the address bar (a shared link or a reload) opens that finding.
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

  // Brings the requested finding card into view, first switching to the findings tab and widening
  // the filter when the card is not listed. Each request is handled once, so changing the filter
  // later does not pull the reader back to it.
  useEffect(() => {
    if (!cardRequest || !analysis || handledCardRequest.current === cardRequest.nonce) return;
    const finding = findingsByClauseId.get(cardRequest.clauseId);
    if (mainTab !== "findings") { setMainTab("findings"); return; }
    if (finding && !matchesFilter(finding, filter)) { setFilter("ALL"); return; }
    handledCardRequest.current = cardRequest.nonce;
    const card = document.getElementById(`finding-${cardRequest.clauseId}`);
    card?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    card?.focus({ preventScroll: true });
  }, [cardRequest, analysis, findingsByClauseId, filter, mainTab]);

  const showInContract = useCallback((clauseId: string) => {
    setSelectedClauseId(clauseId);
    setFocusRequest({ clauseId, nonce: Date.now() });
    if (isNarrow) setSheetOpen(true);
    replaceHash(clauseId);
  }, [isNarrow]);

  const openFinding = useCallback((clauseId: string) => {
    setSelectedClauseId(clauseId);
    setFocusRequest({ clauseId, nonce: Date.now() });
    setCardRequest({ clauseId, nonce: Date.now() });
    replaceHash(clauseId);
  }, []);

  const selectFromDocument = useCallback((clauseId: string) => {
    setSelectedClauseId(clauseId);
    setSheetOpen(false);
    replaceHash(clauseId);
    setCardRequest({ clauseId, nonce: Date.now() });
  }, []);

  if (query.isLoading) return <LoadingState label="טוענים את תוצאות הבדיקה" />;
  if (query.error || !analysis) return <ErrorNotice message={messageForError(query.error, "לא מצאנו את הבדיקה הזו.")} />;

  async function openMarkedPdf() {
    setPdfError(null);
    try {
      let url = markedPdfUrls.get(analysisId);
      if (!url) {
        url = URL.createObjectURL(await api.getMarkedPdf(token!, analysisId));
        markedPdfUrls.set(analysisId, url);
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setPdfError(messageForError(error));
    }
  }

  const incompleteProtections = analysis.protectionReport.filter((protection) => protection.status !== "COVERED").length;
  const labelFor = (clauseId: string) => {
    const finding = findingsByClauseId.get(clauseId);
    return finding ? clauseLabel(finding) : clauseId;
  };
  const filterCounts: Record<FindingFilter, number> = {
    ISSUES: analysis.summary.critical + analysis.summary.warnings,
    RED: analysis.summary.critical,
    ORANGE: analysis.summary.warnings,
    OK: analysis.summary.compliant,
    ALL: analysis.findings.length,
  };
  const filterLabels: Record<FindingFilter, string> = { ISSUES: "לטיפול", RED: "דורש טיפול", ORANGE: "כדאי לבדוק", OK: "תקינים", ALL: "הכול" };
  const verdict = verdictFor(analysis.summary);
  const VerdictIcon = verdict.icon;
  const scrollToWorkspace = () => document.getElementById("analysis-workspace")?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  const showFindings = (next: FindingFilter) => { setMainTab("findings"); setFilter(next); scrollToWorkspace(); };
  const showTab = (next: MainTab) => { setMainTab(next); scrollToWorkspace(); };
  const protectionPanel = <ProtectionPanel analysis={analysis} findingsByClauseId={findingsByClauseId} onOpenFinding={openFinding} />;

  return (
    <div className="page-wrap analysis-page">
      <PageHeader
        eyebrow={historyEntry?.contract?.originalFileName}
        title="תוצאות בדיקת החוזה"
        description={`${historyEntry?.contract && historyEntry.contract.version > 1 ? `גרסה ${historyEntry.contract.version}, ` : ""}נבדק ב־${formatDate(analysis.createdAt)}`}
        actions={(
          <div className="header-actions">
            {analysis.summary.critical + analysis.summary.warnings + incompleteProtections > 0 ? (
              <Link className="primary-button" to={ROUTES.negotiation(analysis.analysisId)}><MessageCircle size={17} /> הכנת הודעה למשכיר</Link>
            ) : null}
            {previousVersion ? <Link className="secondary-button" to={ROUTES.compare(previousVersion.analysisId, analysis.analysisId)}><GitCompareArrows size={17} /> מה השתנה מהגרסה הקודמת</Link> : null}
            {analysis.markedPdf ? <button className="secondary-button" type="button" onClick={openMarkedPdf}><Download size={17} /> הורדת PDF מסומן</button> : null}
          </div>
        )}
      />
      {pdfError ? <ErrorNotice message={pdfError} /> : null}
      <section className={`verdict-card verdict-${verdict.tone}`} aria-labelledby="verdict-title">
        <div className="verdict-summary">
          <div className="verdict-main">
            <span className="verdict-icon"><VerdictIcon size={24} /></span>
            <div>
              <h2 id="verdict-title">{verdict.title}</h2>
              <p>{verdict.text}</p>
            </div>
          </div>
          <div className="verdict-counts" role="group" aria-label="סינון הממצאים">
            <button type="button" className="verdict-count count-critical" onClick={() => showFindings("RED")}><strong>{analysis.summary.critical}</strong><span>דורשים טיפול</span></button>
            <button type="button" className="verdict-count count-warning" onClick={() => showFindings("ORANGE")}><strong>{analysis.summary.warnings}</strong><span>כדאי לבדוק</span></button>
            <button type="button" className="verdict-count count-success" onClick={() => showFindings("OK")}><strong>{analysis.summary.compliant}</strong><span>תקינים</span></button>
            {analysis.protectionReport.length ? (
              <button type="button" className="verdict-count count-protections" onClick={() => showTab("protections")}><strong>{incompleteProtections}</strong><span>הגנות שחסרות בחוזה</span></button>
            ) : null}
          </div>
        </div>
        {keyFindings.length ? (
          <div className="verdict-priorities">
            <h3>במה לטפל קודם</h3>
            <ol>
              {keyFindings.map((finding, index) => (
                <li key={finding.clauseId}>
                  <button type="button" onClick={() => openFinding(finding.clauseId)}>
                    <b className={`priority-${finding.severity.toLowerCase()}`}>{index + 1}</b>
                    <span><strong>{finding.title}</strong><small>{severityMeta[finding.severity].label}, {clauseLabel(finding)}</small></span>
                    <ArrowLeft size={16} />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <p className="verdict-privacy"><ShieldCheck size={16} /> לפני הבדיקה הסרנו מהחוזה {analysis.privacy.redactedEntityCount} פרטים אישיים, כמו שמות ומספרי זהות.</p>
      </section>

      {analysis.crossClauseIssues?.length ? (
        <section className="cross-clause-issues" aria-labelledby="cross-clause-title">
          <div className="section-heading"><div><span className="eyebrow">כמה סעיפים יחד</span><h2 id="cross-clause-title">בעיות שנוצרות משילוב של כמה סעיפים</h2></div><GitMerge size={22} /></div>
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

      <div className="analysis-workspace" id="analysis-workspace">
        <section className="findings-section">
          <div className="main-tabs" role="tablist" aria-label="תוצאות הבדיקה">
            <button type="button" role="tab" aria-selected={mainTab === "findings"} className={mainTab === "findings" ? "active" : ""} onClick={() => setMainTab("findings")}><FileText size={16} /> הממצאים</button>
            <button type="button" role="tab" aria-selected={mainTab === "protections"} className={mainTab === "protections" ? "active" : ""} onClick={() => setMainTab("protections")}><FileCheck2 size={16} /> הגנות בחוזה{incompleteProtections ? <b>{incompleteProtections}</b> : null}</button>
            <button type="button" role="tab" aria-selected={mainTab === "cost"} className={mainTab === "cost" ? "active" : ""} onClick={() => setMainTab("cost")}><Calculator size={16} /> עלות החוזה</button>
          </div>
          {mainTab === "cost" ? <CostSimulator analysis={analysis} token={token!} labelFor={labelFor} onShowClause={showInContract} /> : null}
          {mainTab === "protections" ? <div className="protection-panel">{protectionPanel}</div> : null}
          {mainTab === "findings" ? (<>
          <div className="section-heading">
            <div><span className="eyebrow">סעיף אחר סעיף</span><h2>הממצאים</h2></div>
            <div className="findings-tools">
              {isNarrow ? <button className="show-in-contract" type="button" onClick={() => setSheetOpen(true)}><FileText size={14} /> החוזה המלא</button> : null}
              <div className="filter-pills" role="group" aria-label="סינון הממצאים">
                {(["ISSUES", "RED", "ORANGE", "OK", "ALL"] as const).map((value) => (
                  <button key={value} className={filter === value ? "active" : ""} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                    {filterLabels[value]} <b>{filterCounts[value]}</b>
                  </button>
                ))}
              </div>
            </div>
          </div>
          {filtered.length ? (
            <div className="findings-list">{filtered.map((finding) => (
              <FindingCard
                key={finding.clauseId}
                finding={finding}
                findingsByClauseId={findingsByClauseId}
                selected={finding.clauseId === selectedClauseId}
                onShowInContract={finding.locations?.length ? () => showInContract(finding.clauseId) : undefined}
                onShowClause={showInContract}
                onOpenFinding={openFinding}
              />
            ))}</div>
          ) : (
            <div className="findings-empty">
              <CheckCircle2 size={22} />
              <p>{filter === "ISSUES" ? "לא מצאנו סעיפים שדורשים טיפול או בדיקה." : "אין סעיפים מהסוג הזה."}</p>
              <button className="ghost-button compact-button" type="button" onClick={() => setFilter("ALL")}>הצגת כל הסעיפים</button>
            </div>
          )}
          </>) : null}
        </section>

        <aside className={`analysis-side ${sheetOpen ? "sheet-open" : ""}`} aria-label="החוזה המקורי">
          <div className="side-heading">
            <div><strong>החוזה המקורי</strong><small>לחצו על סימון בחוזה כדי לראות את ההסבר</small></div>
            <label className="compliant-toggle"><input type="checkbox" checked={showCompliant} onChange={(event) => setShowCompliant(event.target.checked)} /> לסמן גם סעיפים תקינים</label>
          </div>
          <div className="side-body side-contract">
            {contractFile.data ? (
              <Suspense fallback={<div className="viewer-message"><LoadingState label="טוענים את החוזה" /></div>}>
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
              <div className="viewer-message"><FileText size={22} /><p>{messageForError(contractFile.error)} אפשר עדיין לקרוא את כל הממצאים ברשימה.</p>{isNarrow ? <button className="ghost-button compact-button" type="button" onClick={() => setSheetOpen(false)}>סגירה</button> : null}</div>
            ) : (
              <div className="viewer-message"><LoadingState label="טוענים את החוזה" /></div>
            )}
          </div>
        </aside>
      </div>
      <Link className="next-step" to={ROUTES.uploadVersion(analysis.contractId, analysis.analysisId)}>
        <span className="next-step-icon"><FilePlus2 size={20} /></span>
        <span className="next-step-copy"><strong>קיבלתם גרסה מתוקנת מהמשכיר?</strong><small>העלו אותה, ונראה לכם מה תוקן ומה השתנה בלי שביקשתם.</small></span>
        <ArrowLeft size={18} />
      </Link>
      <div className="legal-disclaimer"><ShieldCheck size={18} /><span>הבדיקה עוזרת לכם להחליט, אבל היא לא ייעוץ משפטי. אם יש סעיף שדורש טיפול, כדאי להתייעץ עם עורך דין.</span></div>
    </div>
  );
}

const PROTECTION_ORDER: Record<Protection["status"], number> = { MISSING: 0, PARTIAL: 1, COVERED: 2 };

function ProtectionPanel({ analysis, findingsByClauseId, onOpenFinding }: { analysis: Analysis; findingsByClauseId: Map<string, Finding>; onOpenFinding: (clauseId: string) => void }) {
  const protections = analysis.protectionReport.toSorted((left, right) => PROTECTION_ORDER[left.status] - PROTECTION_ORDER[right.status]);
  return (
    <>
      <div className="section-heading"><div><span className="eyebrow">מה חסר בחוזה</span><h2>הגנות שכדאי שיהיו בחוזה</h2></div><FileCheck2 size={24} /></div>
      <div className="protection-progress"><span style={{ width: `${coveragePercent(analysis)}%` }} /><small>{coveragePercent(analysis)}% מההגנות קיימות בחוזה</small></div>
      <div className="protection-list">
        {protections.map((protection) => {
          const linkedFindings = protection.relevantClauseIds
            .map((clauseId) => findingsByClauseId.get(clauseId))
            .filter((finding): finding is Finding => Boolean(finding));
          return (
            <article key={protection.protectionId} className={`protection-item protection-${protection.status.toLowerCase()}`}>
              <div><strong>{protection.title}</strong><StatusBadge tone={protection.status === "COVERED" ? "success" : protection.status === "PARTIAL" ? "warning" : "danger"}>{protection.status === "COVERED" ? "קיימת" : protection.status === "PARTIAL" ? "חלקית" : "חסרה"}</StatusBadge></div>
              <p>{protection.explanation}</p>
              {linkedFindings.length ? (
                <p className="protection-cross-link">
                  קשור לממצא: {linkedFindings.map((finding, index) => (
                    <span key={finding.clauseId}>{index > 0 ? ", " : ""}<button type="button" className="text-link-button" onClick={() => onOpenFinding(finding.clauseId)}>{finding.title}</button></span>
                  ))}
                </p>
              ) : null}
              {protection.suggestedText ? <details><summary>נוסח שאפשר לבקש להוסיף</summary><blockquote>{protection.suggestedText}</blockquote></details> : null}
            </article>
          );
        })}
      </div>
    </>
  );
}

function FindingCard({ finding, findingsByClauseId, selected, onShowInContract, onShowClause, onOpenFinding }: {
  finding: Finding;
  findingsByClauseId: Map<string, Finding>;
  selected: boolean;
  onShowInContract: (() => void) | undefined;
  onShowClause: (clauseId: string) => void;
  onOpenFinding: (clauseId: string) => void;
}) {
  const meta = severityMeta[finding.severity];
  const Icon = meta.icon;
  const isOk = finding.severity === "OK";
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
    <article id={`finding-${finding.clauseId}`} tabIndex={-1} className={`finding-card finding-${finding.severity.toLowerCase()}${selected ? " selected" : ""}${isOk ? " is-ok" : ""}`}>
      <div className="finding-marker"><Icon size={20} /></div>
      <div className="finding-body">
        <header>
          <div className="finding-heading">
            <div className="finding-tags">
              <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
              {!isOk && finding.category ? <span className="finding-category-chip">{categoryMeta[finding.category]}</span> : null}
              <span className="finding-clause">{clauseLabel(finding)}</span>
            </div>
            <h3>{finding.title}</h3>
          </div>
          {onShowInContract ? <button className="show-in-contract" type="button" onClick={onShowInContract} aria-pressed={selected}><ScanSearch size={14} /> הצגה בחוזה</button> : null}
        </header>

        <p className="finding-lead">{plainLanguageExplanation}</p>

        {!isOk && finding.clauseQuote ? <blockquote className="finding-quote"><span className="eyebrow">מה כתוב בחוזה</span>{finding.clauseQuote}</blockquote> : null}

        {!isOk && finding.whyItMatters ? (
          <div className="finding-section">
            <strong>למה סימנו את זה</strong>
            <p>{finding.whyItMatters}</p>
          </div>
        ) : null}

        {finding.recommendedAction ? (
          <div className="finding-action">
            <strong><ListChecks size={16} /> מה כדאי לעשות</strong>
            <p>{finding.recommendedAction}</p>
          </div>
        ) : null}

        {finding.crossClauseIssue ? (
          <div className="finding-cross-clause">
            <strong><GitMerge size={15} /> {crossClauseKindLabel[finding.crossClauseIssue.kind]} עם {finding.crossClauseIssue.clauseIds.map(labelFor).join(", ")}</strong>
            <p>{finding.crossClauseIssue.explanation}</p>
          </div>
        ) : null}

        {finding.contextClauses?.length || relatedFindings.length ? (
          <div className="finding-links">
            {finding.contextClauses?.length ? (
              <div className="clause-chips">
                <span><Link2 size={14} /> נבדק יחד עם</span>
                {finding.contextClauses.map((link) => (
                  <button key={link.clauseId} type="button" className="clause-chip" onClick={() => onShowClause(link.clauseId)} title={link.reason}>{labelFor(link.clauseId)}</button>
                ))}
              </div>
            ) : null}
            {relatedFindings.length ? (
              <div className="clause-chips">
                <span>ממצאים קשורים</span>
                {relatedFindings.map((related) => (
                  <button key={related.clauseId} type="button" className="clause-chip" onClick={() => onOpenFinding(related.clauseId)}>{related.title}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {finding.suggestedReplacementText ? (
          <details className="finding-suggestion">
            <summary>נוסח חלופי שאפשר להציע למשכיר</summary>
            <blockquote>{finding.suggestedReplacementText}</blockquote>
            <div className="finding-suggestion-actions">
              <button className="ghost-button compact-button" type="button" onClick={copySuggestedText}><Copy size={14} /> {copied ? "הועתק" : "העתקת הנוסח"}</button>
              <small>זו הצעה לנוסח בלבד, לא ייעוץ משפטי.</small>
            </div>
          </details>
        ) : null}

        <details className="finding-legal-details">
          <summary>ההסבר המשפטי והמקורות בחוק</summary>
          <p>{finding.explanation}</p>
          {finding.deterministicChecks?.length ? (
            <ul className="deterministic-checks">
              {finding.deterministicChecks.map((check) => (
                <li key={check.ruleId}>
                  {check.label}: בחוזה {formatCheckValue(check.contractValue, check.unit)}, המותר לפי החוק עד {formatCheckValue(check.calculatedLimit, check.unit)}
                  {check.passesRule ? " (בתוך המותר)" : " (חורג מהמותר)"}
                  {check.formula ? <span className="check-formula">איך חישבנו: {check.formula}</span> : null}
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
                  {reference.sourceAsOf ? <cite>{reference.lawName}, הנוסח נכון ל־{formatDate(reference.sourceAsOf)}</cite> : null}
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
