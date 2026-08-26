import { useQueries } from "@tanstack/react-query";
import { ArrowLeft, CircleCheck, FileSearch, History, ShieldAlert, SlidersHorizontal } from "lucide-react";
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

  if (history.isLoading || readiness.isLoading) return <LoadingState label="מכינים את תמונת המצב" />;
  const error = history.error ?? readiness.error;
  if (error) return <ErrorNotice message={messageForError(error)} />;
  const analyses = history.data?.analyses ?? [];
  const latest = analyses[0];
  const ready = readiness.data?.status === "ready";

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="מרכז הבקרה האישי" title={`שלום ${user?.email.split("@")[0]},`} description="החוזים, ההעדפות והדברים שכדאי לטפל בהם — במקום אחד." actions={<Link className="primary-button" to={ROUTES.upload}>בדיקת חוזה חדש <ArrowLeft size={18} /></Link>} />

      <section className="readiness-ribbon">
        <span className={ready ? "ready-icon" : "waiting-icon"}>{ready ? <CircleCheck size={22} /> : <ShieldAlert size={22} />}</span>
        <div><strong>{ready ? "מערכת הניתוח מוכנה" : "מאגר החקיקה עדיין בהכנה"}</strong><p>{ready ? "כל השירותים ומקורות החקיקה זמינים לניתוח." : `${readiness.data?.activeLaws ?? "0/13"} חוקים פעילים. מנהל המערכת משלים את האימות.`}</p></div>
        <StatusBadge tone={ready ? "success" : "review"}>{ready ? "מוכן" : "בבדיקה"}</StatusBadge>
      </section>

      <section className="dashboard-grid">
        <article className="feature-card start-card"><span className="card-index">01</span><FileSearch size={28} /><h2>יש חוזה לבדיקה?</h2><p>העלו PDF וקבלו מפה ברורה של סיכונים, העדפות והגנות חסרות.</p><Link to={ROUTES.upload}>מתחילים בדיקה <ArrowLeft size={17} /></Link></article>
        <article className="feature-card"><span className="card-index">02</span><SlidersHorizontal size={28} /><h2>העדפות השכירות</h2><p>תקציב, חיות מחמד, ריהוט ומשך חוזה משנים את תמונת הסיכון האישית.</p><Link to={ROUTES.preferences}>עדכון העדפות <ArrowLeft size={17} /></Link></article>
        <article className="metric-card"><History size={23} /><div><strong>{analyses.length}</strong><span>ניתוחים שנשמרו</span></div><Link to={ROUTES.history}>לכל ההיסטוריה</Link></article>
      </section>

      <section className="recent-section">
        <div className="section-heading"><div><span className="eyebrow">הבדיקה האחרונה</span><h2>{latest ? "החוזה האחרון שלך" : "עדיין אין ניתוחים"}</h2></div>{latest ? <Link to={ROUTES.analysis(latest.analysisId)}>פתיחת הניתוח <ArrowLeft size={16} /></Link> : null}</div>
        {latest ? (
          <article className="recent-analysis">
            <div className="analysis-date"><span>{new Date(latest.createdAt).getDate()}</span><small>{formatDate(latest.createdAt)}</small></div>
            <div className="recent-title"><strong>ניתוח חוזה</strong><small>מזהה {latest.analysisId.slice(0, 8)}</small></div>
            <div className="severity-count critical-count"><strong>{latest.summary.critical}</strong><span>קריטיים</span></div>
            <div className="severity-count warning-count"><strong>{latest.summary.warnings}</strong><span>אזהרות</span></div>
            <div className="severity-count ok-count"><strong>{latest.summary.compliant}</strong><span>תקינים</span></div>
          </article>
        ) : (
          <div className="first-analysis-prompt"><FileSearch size={30} /><div><strong>הבדיקה הראשונה שלך מחכה</strong><p>PDF אחד מספיק כדי להתחיל.</p></div><Link className="secondary-button" to={ROUTES.upload}>העלאת חוזה</Link></div>
        )}
      </section>
    </div>
  );
}
