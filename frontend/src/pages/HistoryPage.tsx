import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileClock, FileSearch, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { EmptyState } from "../components/EmptyState";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { ROUTES } from "../config/app";
import { api, messageForError } from "../lib/api-client";
import { formatDate, formatDuration } from "../lib/format";

export function HistoryPage() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["history"], queryFn: () => api.getHistory(token!) });
  const remove = useMutation({
    mutationFn: (analysisId: string) => api.deleteHistory(token!, analysisId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["history"] }),
  });
  if (query.isLoading) return <LoadingState label="פותחים את הארכיון" />;
  if (query.error) return <ErrorNotice message={messageForError(query.error)} />;
  const analyses = query.data?.analyses ?? [];

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="הארכיון האישי" title="היסטוריית חוזים" description="כל בדיקה נשמרת עם ההעדפות והמקורות שהיו פעילים באותו רגע." actions={<Link className="secondary-button" to={ROUTES.upload}><FileSearch size={17} /> בדיקה חדשה</Link>} />
      {remove.error ? <ErrorNotice message={messageForError(remove.error)} /> : null}
      {analyses.length === 0 ? (
        <EmptyState icon={FileClock} title="הארכיון עדיין ריק" action={<Link className="primary-button" to={ROUTES.upload}>בדיקת חוזה ראשון</Link>}>הניתוח הראשון שתבצעו יופיע כאן עם המסמך המסומן.</EmptyState>
      ) : (
        <div className="history-list">
          {analyses.map((analysis, index) => (
            <article className="history-item" key={analysis.analysisId}>
              <div className="history-number">{String(analyses.length - index).padStart(2, "0")}</div>
              <div className="history-main"><span>{formatDate(analysis.createdAt)}</span><h2>בדיקת חוזה שכירות</h2><small>מזהה {analysis.analysisId.slice(0, 12)}</small></div>
              <div className="history-summary"><span className="summary-red"><b>{analysis.summary.critical}</b> קריטיים</span><span className="summary-orange"><b>{analysis.summary.warnings}</b> אזהרות</span><span className="summary-green"><b>{analysis.summary.compliant}</b> תקינים</span></div>
              <div className="history-meta"><span>{formatDuration(analysis.timingMs.total)}</span><small>{analysis.privacy.redactedEntityCount} פרטים הוסרו</small></div>
              <div className="history-actions"><Link to={ROUTES.analysis(analysis.analysisId)} aria-label="פתיחת הניתוח"><ArrowLeft size={19} /></Link><button type="button" disabled={remove.isPending} onClick={() => { if (window.confirm("למחוק לצמיתות את הניתוח והקבצים שלו?")) remove.mutate(analysis.analysisId); }} aria-label="מחיקת הניתוח"><Trash2 size={17} /></button></div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
