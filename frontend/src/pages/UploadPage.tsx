import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, FileText, GitCompareArrows, LockKeyhole, ScanLine, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageHeader } from "../components/PageHeader";
import { APP, ROUTES } from "../config/app";
import { api, messageForError } from "../lib/api-client";
import { formatNumber } from "../lib/format";
import type { UploadedContract } from "../types/api";

const STEPS = ["העלאת החוזה", "אישור הפרטים", "בדיקה"] as const;

function validatePdf(file: File) {
  if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) return "אפשר להעלות רק קובץ PDF.";
  if (file.size > APP.maxPdfBytes) return "הקובץ גדול מדי. הגודל המרבי הוא 10MB.";
  return null;
}

export function UploadPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [contract, setContract] = useState<UploadedContract | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // A revised version of a contract analyzed before: it continues that contract's version history,
  // is analyzed with the same preferences as the version it replaces (so differences come from the
  // contract, not from changed preferences), and opens straight into the comparison.
  const [searchParams] = useSearchParams();
  const previousContractId = searchParams.get("previous") ?? undefined;
  const fromAnalysisId = searchParams.get("from") ?? undefined;
  const preferences = useQuery({ queryKey: ["preferences"], queryFn: () => api.getPreferences(token!) });
  const baseAnalysis = useQuery({
    queryKey: ["analysis", fromAnalysisId],
    queryFn: () => api.getAnalysis(token!, fromAnalysisId!),
    enabled: Boolean(fromAnalysisId),
  });
  const upload = useMutation({
    mutationFn: (selected: File) => api.uploadContract(token!, selected, previousContractId),
    onSuccess: ({ contract: uploaded }) => setContract(uploaded),
  });
  const analyze = useMutation({
    mutationFn: (contractId: string) => api.analyzeContract(
      token!,
      contractId,
      baseAnalysis.data?.analysis.preferencesSnapshot ?? preferences.data?.preferences,
    ),
    onSuccess: ({ analysis }) => navigate(fromAnalysisId && previousContractId
      ? ROUTES.compare(fromAnalysisId, analysis.analysisId)
      : ROUTES.analysis(analysis.analysisId)),
  });
  const isNewVersion = Boolean(previousContractId && fromAnalysisId);
  const step = analyze.isPending ? 2 : contract ? 1 : 0;

  function choose(selected?: File) {
    if (!selected) return;
    const validationError = validatePdf(selected);
    setLocalError(validationError);
    if (validationError) return;
    setFile(selected);
    setContract(null);
    upload.reset();
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  }

  const error = localError ?? (upload.error ? messageForError(upload.error) : analyze.error ? messageForError(analyze.error) : null);

  return (
    <div className="page-wrap narrow-page">
      {isNewVersion
        ? <PageHeader eyebrow="גרסה חדשה של החוזה" title="מה המשכיר שינה?" description="העלו את הגרסה המתוקנת שקיבלתם מהמשכיר. נבדוק אותה עם אותן העדפות ונשווה אותה לגרסה הקודמת, סעיף מול סעיף." />
        : <PageHeader title="בדיקת חוזה חדש" description="העלו את חוזה השכירות בקובץ PDF. נקרא את הסעיפים ונבדוק אותם מול החוק ומול ההעדפות שלכם." />}
      <ol className="upload-steps" aria-label="שלבי הבדיקה">
        {STEPS.map((label, index) => (
          <li key={label} className={index < step ? "done" : index === step ? "current" : ""} aria-current={index === step ? "step" : undefined}>
            <span>{index < step ? <CheckCircle2 size={15} /> : index + 1}</span>{label}
          </li>
        ))}
      </ol>
      {isNewVersion ? <div className="version-banner"><GitCompareArrows size={18} /><p>הקובץ יישמר כגרסה חדשה של החוזה שבדקתם, ובסוף הבדיקה תראו מה תוקן, מה נשאר כמו שהיה ומה השתנה בלי שביקשתם.</p></div> : null}
      {error ? <ErrorNotice message={error} /> : null}
      {!contract ? (
        <section className="upload-workspace">
          <div className={`drop-zone${file ? " has-file" : ""}${dragging ? " dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => choose(event.target.files?.[0])} />
            {file ? (
              <div className="selected-file"><span><FileText size={30} /></span><div><strong>{file.name}</strong><small>קובץ PDF בגודל <bdi>{formatNumber(Math.round(file.size / 1024))} KB</bdi></small></div><button type="button" onClick={() => { setFile(null); setLocalError(null); }} aria-label="הסרת הקובץ"><X size={18} /></button></div>
            ) : (
              <><span className="upload-icon"><UploadCloud size={34} /></span><h2>גררו את חוזה השכירות לכאן</h2><p>או בחרו קובץ מהמחשב</p><button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>בחירת PDF</button><small>קובץ אחד, עד 10MB</small></>
            )}
          </div>
          <div className="upload-assurance"><LockKeyhole size={20} /><div><strong>הקובץ נשמר רק בחשבון שלכם</strong><p>לפני הבדיקה אנחנו מסירים מהחוזה שמות, מספרי זהות ופרטים אישיים אחרים.</p></div></div>
          {file ? <button className="primary-button upload-action" type="button" disabled={upload.isPending} onClick={() => upload.mutate(file)}>{upload.isPending ? <><span className="button-spinner" /> קוראים את החוזה…</> : <>העלאת הקובץ <ArrowLeft size={18} /></>}</button> : null}
        </section>
      ) : (
        <section className="extraction-result">
          <div className="result-seal"><CheckCircle2 size={34} /></div>
          <span className="eyebrow">קראנו את החוזה</span><h2>{contract.originalFileName}</h2><p>החוזה מוכן לבדיקה מול החוק ומול ההעדפות שלכם.</p>
          <div className="extraction-metrics">
            <div><strong>{contract.pageCount}</strong><span>עמודים</span></div><div><strong>{contract.clauseCount}</strong><span>סעיפים שזיהינו</span></div><div><strong>{contract.isScanned ? "סרוק" : "טקסט"}</strong><span>סוג הקובץ</span></div>{contract.version > 1 ? <div><strong>{contract.version}</strong><span>גרסה</span></div> : null}
          </div>
          {contract.isScanned ? <div className="scan-note"><ScanLine size={18} /> {contract.scannedPages.length} עמודים היו סרוקים, ולכן זיהינו את הטקסט שלהם אוטומטית. כדאי לוודא שהממצאים תואמים לחוזה.</div> : null}
          {analyze.isPending ? (
            <div className="analyzing-note" role="status">
              <span className="button-spinner on-paper" aria-hidden="true" />
              <div><strong>בודקים את החוזה</strong><small>זה יכול לקחת עד דקה וחצי. השאירו את הדף פתוח, ונעביר אתכם לתוצאות בסיום.</small></div>
            </div>
          ) : (
            <div className="result-actions"><button className="ghost-button" type="button" onClick={() => { setContract(null); setFile(null); }}>בחירת קובץ אחר</button><button className="primary-button" type="button" disabled={preferences.isLoading || (Boolean(fromAnalysisId) && baseAnalysis.isLoading)} onClick={() => analyze.mutate(contract.id)}>התחלת הבדיקה <ArrowLeft size={18} /></button></div>
          )}
        </section>
      )}
    </div>
  );
}
