import { FileCheck2 } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import type { Analysis, Finding, Protection } from "../types/api";

const ORDER: Record<Protection["status"], number> = { MISSING: 0, PARTIAL: 1, UNKNOWN: 2, COVERED: 3 };
const STATUS: Record<Protection["status"], { label: string; tone: string }> = {
  MISSING: { label: "חסרה", tone: "danger" },
  PARTIAL: { label: "חלקית", tone: "warning" },
  UNKNOWN: { label: "דרוש בירור", tone: "review" },
  COVERED: { label: "קיימת", tone: "success" },
};
const BASIS = { LAW: "מבוסס על הוראת חוק", CONTRACT_RISK: "המלצה לצמצום סיכון", TENANT_PREFERENCE: "בהתאם להעדפות שלכם" };

export function ProtectionPanel({ analysis, findingsByClauseId, onOpenFinding }: {
  analysis: Analysis;
  findingsByClauseId: Map<string, Finding>;
  onOpenFinding: (clauseId: string) => void;
}) {
  const protections = analysis.protectionReport.toSorted((left, right) => ORDER[left.status] - ORDER[right.status]);
  const unavailable = analysis.protectionAnalysisMode === "UNAVAILABLE";
  return (
    <>
      <div className="section-heading"><div><span className="eyebrow">בדיקה לפי החוזה</span><h2>הגנות והסדרים שכדאי לבדוק</h2></div><FileCheck2 size={24} /></div>
      <p className="muted">הבדיקה מתמקדת בהסכם ובהעדפות שלכם. הממצאים אינם רשימה מלאה של כל ההגנות האפשריות.</p>
      {unavailable ? <p role="status">בדיקת הגנות חסרות אינה זמינה בניתוח הזה.</p> : null}
      {!unavailable && !protections.length ? <p>לא זוהו פערים נוספים בבדיקה זו.</p> : null}
      <div className="protection-list">
        {protections.map((protection) => {
          const linkedFindings = protection.relevantClauseIds.map((id) => findingsByClauseId.get(id))
            .filter((finding): finding is Finding => Boolean(finding));
          const status = STATUS[protection.status];
          const actionable = protection.status === "MISSING" || protection.status === "PARTIAL";
          return (
            <article key={protection.protectionId} className={`protection-item protection-${protection.status.toLowerCase()}`}>
              <div><strong>{protection.title}</strong><StatusBadge tone={status.tone}>{status.label}</StatusBadge></div>
              {protection.basis ? <p>{BASIS[protection.basis]}</p> : null}
              <p>{protection.explanation}</p>
              {protection.applicability ? <p><strong>למה זה רלוונטי:</strong> {protection.applicability}</p> : null}
              {protection.scenario ? <p><strong>מה עלול לקרות:</strong> {protection.scenario}</p> : null}
              {linkedFindings.length ? (
                <p className="protection-cross-link">קשור לממצא: {linkedFindings.map((finding, index) => (
                  <span key={finding.clauseId}>{index > 0 ? ", " : ""}<button type="button" className="text-link-button" onClick={() => onOpenFinding(finding.clauseId)}>{finding.title}</button></span>
                ))}</p>
              ) : null}
              {protection.evidence?.length || protection.legalReferences.length ? (
                <details><summary>מקורות הבדיקה</summary>
                  {protection.evidence?.map((evidence, index) => <blockquote key={`${evidence.clauseId}-${index}`}>{evidence.quote}</blockquote>)}
                  {protection.legalReferences.map((reference) => (
                    <p key={reference.lawReferenceId}><a href={reference.sourceUrl} target="_blank" rel="noreferrer">{reference.lawName}{reference.section ? `, סעיף ${reference.section}` : ""}</a></p>
                  ))}
                </details>
              ) : null}
              {actionable && protection.suggestedText ? <details><summary>נוסח שאפשר לבקש להוסיף</summary><blockquote>{protection.suggestedText}</blockquote></details> : null}
            </article>
          );
        })}
      </div>
    </>
  );
}
