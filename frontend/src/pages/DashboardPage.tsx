import { useQueries } from "@tanstack/react-query";
import { ArrowLeft, FileSearch, History, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ROUTES } from "../config/app";
import { api, messageForError } from "../lib/api-client";
import { formatDate } from "../lib/format";

export function DashboardPage() {
  const { token, user } = useAuth();
  const [history, readiness] = useQueries({ queries: [
    { queryKey: ["history"], queryFn: () => api.getHistory(token!) },
    { queryKey: ["readiness"], queryFn: api.getReadiness, refetchInterval: 60_000 },
  ] });

  if (history.isLoading || readiness.isLoading) return <LoadingState label="טוענים" />;
  const error = history.error ?? readiness.error;
  if (error) return <ErrorNotice message={messageForError(error)} />;
  const analyses = history.data?.analyses ?? [];
  const latest = analyses[0];
  const ready = readiness.data?.status === "ready";
  const latestTone = !latest ? "" : latest.summary.critical ? "verdict-text-critical" : latest.summary.warnings ? "verdict-text-warning" : "verdict-text-success";
  const latestVerdict = !latest ? "" : latest.summary.critical
    ? "יש סעיפים שכדאי לתקן לפני החתימה"
    : latest.summary.warnings ? "אין בעיות חמורות, אבל יש נקודות לבדוק" : "לא מצאנו בעיות בחוזה";

  return (
    <div className="page-wrap">
      <PageHeader title={`שלום, ${user?.email.split("@")[0]}`} description="כאן תמצאו את החוזים שבדקתם, את ההעדפות שלכם ואת מה שכדאי לטפל בו." actions={<Link className="primary-button" to={ROUTES.upload}>בדיקת חוזה חדש <ArrowLeft size={18} /></Link>} />

      {/* Shown only when something needs attention; a working system needs no announcement. */}
      {ready ? null : (
        <section className="readiness-ribbon">
          <span className="waiting-icon"><ShieldAlert size={22} /></span>
          <div><strong>מאגר החוקים עדיין בהכנה</strong><p>{`${readiness.data?.activeLaws ?? "0/13"} חוקים פעילים במאגר. מנהל המערכת משלים את ההכנה, ועד אז ייתכן שהבדיקה תהיה חלקית.`}</p></div>
          <StatusBadge tone="review">בהכנה</StatusBadge>
        </section>
      )}

      <section className="dashboard-grid">
        <article className="feature-card start-card"><FileSearch size={28} /><h2>יש חוזה לבדיקה?</h2><p>העלו את החוזה בקובץ PDF, ונראה לכם אילו סעיפים בעייתיים ואילו הגנות חסרות.</p><Link to={ROUTES.upload}>מתחילים בדיקה <ArrowLeft size={17} /></Link></article>
        <article className="feature-card"><SlidersHorizontal size={28} /><h2>העדפות השכירות</h2><p>ספרו לנו מה חשוב לכם, כמו תקציב, חיות מחמד ומשך החוזה, ונבדוק את החוזה גם מול זה.</p><Link to={ROUTES.preferences}>עדכון העדפות <ArrowLeft size={17} /></Link></article>
        <article className="metric-card"><History size={23} /><div><strong>{analyses.length}</strong><span>{analyses.length === 1 ? "בדיקה שמורה" : "בדיקות שמורות"}</span></div><Link to={ROUTES.history}>לכל הבדיקות</Link></article>
      </section>

      <section className="recent-section">
        <div className="section-heading"><div><h2>{latest ? "הבדיקה האחרונה" : "עדיין לא בדקתם חוזה"}</h2></div>{latest ? <Link to={ROUTES.analysis(latest.analysisId)}>לתוצאות הבדיקה <ArrowLeft size={16} /></Link> : null}</div>
        {latest ? (
          <Link className="recent-analysis" to={ROUTES.analysis(latest.analysisId)}>
            <div className="analysis-date"><span>{new Date(latest.createdAt).getDate()}</span><small>{formatDate(latest.createdAt)}</small></div>
            <div className="recent-title"><strong>{latest.contract?.originalFileName ?? "בדיקת חוזה"}</strong><small className={latestTone}>{latestVerdict}</small></div>
            <div className="severity-count critical-count"><strong>{latest.summary.critical}</strong><span>דורשים טיפול</span></div>
            <div className="severity-count warning-count"><strong>{latest.summary.warnings}</strong><span>כדאי לבדוק</span></div>
            <div className="severity-count ok-count"><strong>{latest.summary.compliant}</strong><span>תקינים</span></div>
          </Link>
        ) : (
          <div className="first-analysis-prompt"><FileSearch size={30} /><div><strong>העלו את החוזה הראשון שלכם</strong><p>צריך רק קובץ PDF של החוזה.</p></div><Link className="secondary-button" to={ROUTES.upload}>העלאת חוזה</Link></div>
        )}
      </section>
    </div>
  );
}
