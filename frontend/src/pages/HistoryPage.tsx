import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileClock, FileSearch, GitCompareArrows, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { EmptyState } from "../components/EmptyState";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { ROUTES } from "../config/app";
import { api, messageForError } from "../lib/api-client";
import { formatDate } from "../lib/format";
import { groupByContract, previousVersionAnalysis } from "../lib/versions";

function verdictLine(summary: { critical: number; warnings: number }) {
  if (summary.critical) return { tone: "verdict-text-critical", text: "יש סעיפים שכדאי לתקן לפני החתימה" };
  if (summary.warnings) return { tone: "verdict-text-warning", text: "אין בעיות חמורות, אבל יש נקודות לבדוק" };
  return { tone: "verdict-text-success", text: "לא מצאנו בעיות בחוזה" };
}

export function HistoryPage() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["history"], queryFn: () => api.getHistory(token!) });
  const remove = useMutation({
    mutationFn: (analysisId: string) => api.deleteHistory(token!, analysisId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["history"] }),
  });
  if (query.isLoading) return <LoadingState label="טוענים את החוזים שלכם" />;
  if (query.error) return <ErrorNotice message={messageForError(query.error)} />;
  const analyses = query.data?.analyses ?? [];

  return (
    <div className="page-wrap">
      <PageHeader title="החוזים שלי" description="כל בדיקה שעשיתם נשמרת כאן. אפשר לפתוח אותה שוב, להשוות בין גרסאות או למחוק." actions={<Link className="secondary-button" to={ROUTES.upload}><FileSearch size={17} /> בדיקה חדשה</Link>} />
      {remove.error ? <ErrorNotice message={messageForError(remove.error)} /> : null}
      {analyses.length === 0 ? (
        <EmptyState icon={FileClock} title="עוד אין כאן חוזים" action={<Link className="primary-button" to={ROUTES.upload}>לבדיקת החוזה הראשון</Link>}>אחרי שתבדקו חוזה, הוא יופיע כאן יחד עם התוצאות.</EmptyState>
      ) : (
        <div className="history-groups">
          {groupByContract(analyses).map((group) => (
            <section key={group.rootContractId} className="history-group" aria-label={group.fileName}>
              <header><h2>{group.fileName}</h2>{group.versionCount > 1 ? <span>{group.versionCount} גרסאות</span> : null}</header>
              <div className="history-list">
                {group.entries.map((analysis) => {
                  const previous = previousVersionAnalysis(analyses, analysis.analysisId);
                  const version = analysis.contract?.version ?? 1;
                  const verdict = verdictLine(analysis.summary);
                  return (
                    <article className="history-item" key={analysis.analysisId}>
                      <div className="history-number">{String(version).padStart(2, "0")}</div>
                      <div className="history-main"><span>{formatDate(analysis.createdAt)}</span><h2><Link className="history-open" to={ROUTES.analysis(analysis.analysisId)}>{group.versionCount > 1 ? `גרסה ${version}` : "בדיקת חוזה שכירות"}</Link></h2><small className={verdict.tone}>{verdict.text}</small></div>
                      <div className="history-summary"><span className="summary-red"><b>{analysis.summary.critical}</b> דורשים טיפול</span><span className="summary-orange"><b>{analysis.summary.warnings}</b> כדאי לבדוק</span><span className="summary-green"><b>{analysis.summary.compliant}</b> תקינים</span></div>
                      <div className="history-meta">{previous ? <Link className="history-compare" to={ROUTES.compare(previous.analysisId, analysis.analysisId)}><GitCompareArrows size={15} /> מה השתנה מהגרסה הקודמת</Link> : null}</div>
                      <div className="history-actions"><Link to={ROUTES.analysis(analysis.analysisId)} aria-label="פתיחת התוצאות"><ArrowLeft size={19} /></Link><button type="button" disabled={remove.isPending} onClick={() => { if (window.confirm("למחוק את הבדיקה הזו ואת הקובץ שלה? אי אפשר לבטל את המחיקה.")) remove.mutate(analysis.analysisId); }} aria-label="מחיקת הבדיקה"><Trash2 size={17} /></button></div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
