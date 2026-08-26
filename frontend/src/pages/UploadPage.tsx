import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, FileText, LockKeyhole, ScanLine, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageHeader } from "../components/PageHeader";
import { APP, ROUTES } from "../config/app";
import { api, messageForError } from "../lib/api-client";
import { formatDuration, formatNumber } from "../lib/format";
import type { UploadedContract } from "../types/api";

function validatePdf(file: File) {
  if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) return "יש לבחור קובץ PDF בלבד.";
  if (file.size > APP.maxPdfBytes) return "הקובץ גדול מ־10MB.";
  return null;
}

export function UploadPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [contract, setContract] = useState<UploadedContract | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const preferences = useQuery({ queryKey: ["preferences"], queryFn: () => api.getPreferences(token!) });
  const upload = useMutation({
    mutationFn: (selected: File) => api.uploadContract(token!, selected),
    onSuccess: ({ contract: uploaded }) => setContract(uploaded),
  });
  const analyze = useMutation({
    mutationFn: (contractId: string) => api.analyzeContract(token!, contractId, preferences.data?.preferences),
    onSuccess: ({ analysis }) => navigate(ROUTES.analysis(analysis.analysisId)),
  });

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
    choose(event.dataTransfer.files[0]);
  }

  const error = localError ?? (upload.error ? messageForError(upload.error) : analyze.error ? messageForError(analyze.error) : null);

  return (
    <div className="page-wrap narrow-page">
      <PageHeader eyebrow="בדיקה חדשה" title="החוזה נכנס. הבהירות יוצאת." description="מעלים PDF אחד, אנחנו מחלצים את הסעיפים ומכינים אותו לניתוח בטוח." />
      {error ? <ErrorNotice message={error} /> : null}
      {!contract ? (
        <section className="upload-workspace">
          <div className={`drop-zone ${file ? "has-file" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => choose(event.target.files?.[0])} />
            {file ? (
              <div className="selected-file"><span><FileText size={30} /></span><div><strong>{file.name}</strong><small>{formatNumber(file.size / 1024)} KB · PDF</small></div><button type="button" onClick={() => { setFile(null); setLocalError(null); }} aria-label="הסרת הקובץ"><X size={18} /></button></div>
            ) : (
              <><span className="upload-icon"><UploadCloud size={34} /></span><h2>גררו את חוזה השכירות לכאן</h2><p>או בחרו קובץ מהמחשב</p><button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>בחירת PDF</button><small>קובץ אחד, עד 10MB</small></>
            )}
          </div>
          <div className="upload-assurance"><LockKeyhole size={20} /><div><strong>הקובץ נשמר באופן פרטי</strong><p>שמות ומזהים מוסרים מקומית לפני שימוש במודל החיצוני.</p></div></div>
          {file ? <button className="primary-button upload-action" type="button" disabled={upload.isPending} onClick={() => upload.mutate(file)}>{upload.isPending ? <><span className="button-spinner" /> מחלצים את הסעיפים…</> : <>העלאה וחילוץ <ArrowLeft size={18} /></>}</button> : null}
        </section>
      ) : (
        <section className="extraction-result">
          <div className="result-seal"><CheckCircle2 size={34} /></div>
          <span className="eyebrow">החילוץ הושלם</span><h2>{contract.originalFileName}</h2><p>החוזה מוכן לניתוח מול ההעדפות ומאגר החקיקה המאומת.</p>
          <div className="extraction-metrics">
            <div><strong>{contract.pageCount}</strong><span>עמודים</span></div><div><strong>{contract.clauseCount}</strong><span>סעיפים</span></div><div><strong>{formatDuration(contract.extractionMs)}</strong><span>זמן חילוץ</span></div><div><strong>{contract.isScanned ? "OCR" : "טקסט"}</strong><span>סוג מסמך</span></div>
          </div>
          {contract.isScanned ? <div className="scan-note"><ScanLine size={18} /> זוהו {contract.scannedPages.length} עמודים סרוקים ועברו OCR.</div> : null}
          <div className="result-actions"><button className="ghost-button" type="button" onClick={() => { setContract(null); setFile(null); }}>בחירת קובץ אחר</button><button className="primary-button" type="button" disabled={analyze.isPending || preferences.isLoading} onClick={() => analyze.mutate(contract.id)}>{analyze.isPending ? "מנתחים — זה עשוי לקחת עד 90 שניות…" : "התחלת ניתוח החוזה"}<ArrowLeft size={18} /></button></div>
        </section>
      )}
    </div>
  );
}
