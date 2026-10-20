import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  MessageCircle,
  RotateCcw,
  Save,
  Scale,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ErrorNotice";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ROUTES } from "../config/app";
import { api, ApiError } from "../lib/api-client";
import type {
  LikelyReply,
  Negotiation,
  NegotiationAction,
  NegotiationIssue,
  NegotiationState,
  NegotiationStrategyKind,
} from "../types/api";

const MAX_MESSAGE_LENGTH = 1_000;

const STEPS: Array<{ state: NegotiationState; label: string }> = [
  { state: "PRIORITIZE", label: "סדר עדיפויות" },
  { state: "STRATEGY", label: "דרך פעולה" },
  { state: "DRAFT", label: "ניסוח ההודעה" },
  { state: "COUNTER", label: "תגובות המשכיר" },
  { state: "DONE", label: "מוכן" },
];

const SEVERITY_META: Record<NegotiationIssue["severity"], { label: string; tone: string }> = {
  RED: { label: "דורש טיפול", tone: "danger" },
  ORANGE: { label: "כדאי לבדוק", tone: "warning" },
  SUGGESTION: { label: "הגנה חסרה", tone: "pending" },
  TENANT: { label: "בקשה שלכם", tone: "review" },
};

const STRATEGY_LABEL: Record<NegotiationStrategyKind, string> = {
  CITE_LAW: "הסתמכות על החוק",
  PROPOSE_ALTERNATIVE: "הצעת חלופה",
  CONCEDE: "ויתור",
};

// Backend errors carry English text for developers; the tenant sees these instead.
const ERROR_TEXT: Record<string, string> = {
  NEGOTIATION_BUSY: "הסוכן עדיין עונה על ההודעה הקודמת. נסו שוב בעוד רגע.",
  NEGOTIATION_DONE: "השיחה הסתיימה. אפשר להתחיל מחדש כדי להכין הודעה חדשה.",
  NEGOTIATION_TURN_LIMIT: "הגעתם למספר ההודעות המרבי בשיחה הזו. אפשר להתחיל מחדש.",
  NEGOTIATION_NO_DRAFT: "הסוכן עוד לא הכין טיוטה.",
  NO_NEGOTIABLE_FINDINGS: "לא נמצאו בחוזה נושאים שכדאי להעלות מול המשכיר.",
  PII_REDACTION_FAILED: "לא הצלחנו להסיר פרט מזהה מההודעה. נסו לנסח אותה בלי מספרי זהות או טלפון.",
  PII_NER_UNAVAILABLE: "שירות הסרת הפרטים האישיים לא זמין כרגע. נסו שוב בעוד כמה דקות.",
  AI_PROVIDER_ERROR: "הסוכן לא זמין כרגע. נסו שוב בעוד רגע.",
  NEGOTIATION_AGENT_STALLED: "הסוכן לא הצליח להשלים את התשובה. נסו לנסח את ההודעה אחרת.",
  NEGOTIATION_STREAM_ENDED: "התשובה נקטעה לפני שהסתיימה. נסו שוב.",
};

function errorText(error: unknown) {
  if (error instanceof ApiError && ERROR_TEXT[error.code]) return ERROR_TEXT[error.code]!;
  return "משהו השתבש. נסו שוב.";
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  return {
    copied,
    copy: async (key: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(key);
      } catch {
        setCopied(null);
      }
    },
  };
}

export function NegotiationPage() {
  const { analysisId = "" } = useParams();
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["negotiation", analysisId];
  const query = useQuery({
    queryKey,
    // A negotiation that was never started is a state of the page, not an error.
    queryFn: async () => {
      try {
        return (await api.getNegotiation(token!, analysisId)).negotiation;
      } catch (error) {
        if (error instanceof ApiError && error.code === "NEGOTIATION_NOT_FOUND") return null;
        throw error;
      }
    },
    enabled: Boolean(token && analysisId),
  });
  const negotiation = query.data ?? null;
  const setNegotiation = (next: Negotiation) => queryClient.setQueryData(queryKey, next);

  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: NegotiationAction) {
    setActionBusy(true);
    setError(null);
    try {
      const result = await api.negotiationAction(token!, analysisId, action);
      setNegotiation(result.negotiation);
      return result.negotiation;
    } catch (caught) {
      setError(errorText(caught));
      return null;
    } finally {
      setActionBusy(false);
    }
  }

  function restart() {
    if (window.confirm("להתחיל את השיחה מחדש? השיחה וההודעה הנוכחיות יימחקו.")) {
      void runAction({ action: "START", restart: true });
    }
  }

  if (query.isLoading) return <LoadingState label="טוענים את השיחה" />;
  if (query.error) return <ErrorNotice message={errorText(query.error)} />;

  return (
    <div className="page-wrap negotiation-page">
      <PageHeader
        eyebrow="סוכן משא ומתן"
        title="הכנת השיחה עם המשכיר"
        description="הסוכן עובר איתכם על הנושאים שנמצאו בחוזה, שואל מה חשוב לכם, ובסוף מנסח הודעת WhatsApp אחת. אתם בודקים, עורכים ושולחים אותה בעצמכם."
        actions={(
          <div className="header-actions">
            <Link className="secondary-button" to={ROUTES.analysis(analysisId)}><ArrowRight size={17} /> חזרה לניתוח</Link>
            {negotiation ? (
              <button className="ghost-button" type="button" onClick={restart} disabled={actionBusy}><RotateCcw size={16} /> להתחיל מחדש</button>
            ) : null}
          </div>
        )}
      />
      {error ? <ErrorNotice message={error} /> : null}
      {negotiation ? (
        <NegotiationWorkspace
          negotiation={negotiation}
          token={token!}
          analysisId={analysisId}
          actionBusy={actionBusy}
          onNegotiation={setNegotiation}
          onAction={runAction}
          onRefresh={() => queryClient.invalidateQueries({ queryKey })}
        />
      ) : (
        <section className="negotiation-intro">
          <span className="negotiation-intro-icon"><MessageCircle size={28} /></span>
          <div>
            <h2>שיחה קצרה, הודעה אחת מנומקת</h2>
            <ol>
              <li>נקבע יחד אילו נושאים הכי חשובים לכם. אפשר גם להוסיף נושאים משלכם.</li>
              <li>על כל נושא נדבר עד שברור מה אתם רוצים, במילים שלכם ובכמה הודעות שצריך. הסוכן בודק את הבקשות מול החוק ושואל על מה שחסר.</li>
              <li>הסוכן מנסח הודעה אחת למשכיר, ומכין תשובות לתגובות סבירות שלו.</li>
            </ol>
            <p className="negotiation-promise"><ShieldCheck size={16} /> פרטים מזהים מוסרים לפני כל פנייה למודל. הסוכן לא פונה למשכיר ולא שולח שום דבר.</p>
            <button className="primary-button" type="button" disabled={actionBusy} onClick={() => void runAction({ action: "START" })}>
              <Sparkles size={17} /> {actionBusy ? "מתחילים…" : "בואו נתחיל"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function NegotiationWorkspace({ negotiation, token, analysisId, actionBusy, onNegotiation, onAction, onRefresh }: {
  negotiation: Negotiation;
  token: string;
  analysisId: string;
  actionBusy: boolean;
  onNegotiation: (negotiation: Negotiation) => void;
  onAction: (action: NegotiationAction) => Promise<Negotiation | null>;
  onRefresh: () => void;
}) {
  return (
    <>
      {negotiation.agentMode === "SCRIPTED" ? (
        <p className="agent-demo-note" role="note">
          מצב הדגמה: השרת לא מחובר ל־Claude, ותסריט קבוע עונה במקום הסוכן. הוא מבין רק את הכפתורים, וכל טקסט אחר נרשם כפי שנכתב.
        </p>
      ) : null}
      <Stepper state={negotiation.state} />
      <div className="negotiation-layout">
        <ChatPanel negotiation={negotiation} token={token} analysisId={analysisId} disabled={actionBusy} onNegotiation={onNegotiation} onRefresh={onRefresh} />
        <aside className="negotiation-side">
          {negotiation.draft ? <DraftPanel negotiation={negotiation} busy={actionBusy} onAction={onAction} /> : null}
          {negotiation.likelyReplies.length ? <RepliesPanel negotiation={negotiation} /> : null}
          {negotiation.state === "COUNTER" ? (
            <button className="secondary-button negotiation-finish" type="button" disabled={actionBusy} onClick={() => void onAction({ action: "COMPLETE" })}>
              <CheckCircle2 size={17} /> סיימתי
            </button>
          ) : null}
          <PlanPanel negotiation={negotiation} />
        </aside>
      </div>
    </>
  );
}

function Stepper({ state }: { state: NegotiationState }) {
  const current = STEPS.findIndex((step) => step.state === state);
  return (
    <ol className="negotiation-steps" aria-label="שלבי המשא ומתן">
      {STEPS.map((step, index) => (
        <li key={step.state} className={index < current ? "done" : index === current ? "current" : ""} aria-current={index === current ? "step" : undefined}>
          <span>{index < current ? <Check size={13} /> : index + 1}</span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

function ChatPanel({ negotiation, token, analysisId, disabled, onNegotiation, onRefresh }: {
  negotiation: Negotiation;
  token: string;
  analysisId: string;
  disabled: boolean;
  onNegotiation: (negotiation: Negotiation) => void;
  onRefresh: () => void;
}) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingTenantText, setPendingTenantText] = useState<string | null>(null);
  const [streamed, setStreamed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const done = negotiation.state === "DONE";

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [negotiation.messages.length, streamed, pendingTenantText]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending || disabled || done) return;
    setError(null);
    setPending(true);
    setPendingTenantText(trimmed);
    setStreamed("");
    setInput("");
    try {
      const result = await api.sendNegotiationMessage(token, analysisId, trimmed, {
        onText: (delta) => setStreamed((current) => current + delta),
        // The negotiation sent mid-turn already holds the tenant's message.
        onNegotiation: (next) => {
          setPendingTenantText(null);
          onNegotiation(next);
        },
      });
      onNegotiation(result);
    } catch (caught) {
      // The server keeps nothing from a failed turn; show its saved state and give the text back.
      setError(errorText(caught));
      setInput(trimmed);
      onRefresh();
    } finally {
      setPending(false);
      setPendingTenantText(null);
      setStreamed("");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  }

  const last = negotiation.messages.at(-1);
  const quickReplies = !pending && !done && last?.role === "AGENT" ? last.quickReplies : [];

  return (
    <section className="negotiation-chat" aria-label="שיחה עם הסוכן">
      <div className="chat-log" ref={logRef} role="log" aria-live="polite">
        {negotiation.messages.map((message) => (
          <div key={message.id} className={`chat-bubble ${message.role === "AGENT" ? "from-agent" : "from-tenant"}`}>
            {message.text}
          </div>
        ))}
        {pendingTenantText ? <div className="chat-bubble from-tenant">{pendingTenantText}</div> : null}
        {pending ? (
          <div className="chat-bubble from-agent" aria-busy="true">
            {streamed || <span className="typing-dots" aria-label="הסוכן כותב"><i /><i /><i /></span>}
          </div>
        ) : null}
      </div>
      {quickReplies.length ? (
        <div className="quick-replies" aria-label="תשובות מהירות">
          {quickReplies.map((reply) => (
            <button key={reply} type="button" onClick={() => void send(reply)} disabled={disabled}>{reply}</button>
          ))}
        </div>
      ) : null}
      {error ? <ErrorNotice message={error} /> : null}
      {done ? (
        <p className="chat-closed"><CheckCircle2 size={16} /> השיחה הסתיימה. ההודעה מחכה לכם בחלונית.</p>
      ) : (
        <form className="chat-composer" onSubmit={submit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="כתבו לסוכן…"
            aria-label="הודעה לסוכן"
            maxLength={MAX_MESSAGE_LENGTH}
            rows={2}
            disabled={pending || disabled}
          />
          <button className="primary-button" type="submit" disabled={pending || disabled || !input.trim()} aria-label="שליחה לסוכן">
            <Send size={17} />
          </button>
        </form>
      )}
    </section>
  );
}

function DraftPanel({ negotiation, busy, onAction }: {
  negotiation: Negotiation;
  busy: boolean;
  onAction: (action: NegotiationAction) => Promise<Negotiation | null>;
}) {
  const draft = negotiation.draft!;
  const editable = negotiation.state === "DRAFT";
  const [text, setText] = useState(draft.text);
  const { copied, copy } = useCopy();
  const dirty = text.trim() !== draft.text;

  // A new draft from the agent replaces what is in the box.
  useEffect(() => setText(draft.text), [draft.text]);

  async function save() {
    return (await onAction({ action: "SAVE_DRAFT", draft: text.trim() })) !== null;
  }

  async function approve() {
    if (dirty && !(await save())) return;
    await onAction({ action: "FINALIZE_DRAFT" });
  }

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(draft.text)}`;

  return (
    <section className="draft-panel" aria-labelledby="draft-title">
      <div className="draft-heading">
        <div>
          <span className="eyebrow">ההודעה למשכיר</span>
          <h2 id="draft-title">{editable ? "טיוטה לבדיקה" : "ההודעה מוכנה"}</h2>
        </div>
        {draft.editedByTenant ? <StatusBadge tone="review">נערכה על ידכם</StatusBadge> : <StatusBadge tone="success">נבדקה מול המקורות</StatusBadge>}
      </div>
      <textarea
        className="draft-text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        readOnly={!editable}
        aria-label="נוסח ההודעה"
        maxLength={3_000}
        rows={11}
      />
      <div className="draft-meta">
        <span>{text.length.toLocaleString("he-IL")} תווים</span>
        {dirty ? <span>יש שינויים שלא נשמרו</span> : null}
      </div>
      {draft.warnings.length && !dirty ? (
        <ul className="draft-warnings" role="status">
          {draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      <div className="draft-actions">
        {editable ? (
          <>
            <button className="primary-button" type="button" disabled={busy || !text.trim()} onClick={() => void approve()}>
              <Check size={17} /> אישור ההודעה
            </button>
            {dirty ? (
              <button className="secondary-button" type="button" disabled={busy || !text.trim()} onClick={() => void save()}>
                <Save size={16} /> שמירת השינויים
              </button>
            ) : null}
          </>
        ) : (
          <a className="primary-button whatsapp-button" href={whatsappUrl} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={17} /> פתיחה ב־WhatsApp
          </a>
        )}
        <button className="secondary-button" type="button" onClick={() => void copy("draft", text)}>
          <Copy size={16} /> {copied === "draft" ? "הועתק" : "העתקה"}
        </button>
      </div>
      <p className="draft-note">
        {editable
          ? "אפשר לערוך כאן ישירות, או לבקש מהסוכן שינויים בצ'אט. אחרי האישור תוכלו לפתוח את ההודעה ב־WhatsApp."
          : "WhatsApp ייפתח עם ההודעה, ואתם בוחרים למי לשלוח. שום דבר לא נשלח בלי שתלחצו שליחה."}
      </p>
      {draft.sources.length ? (
        <details className="draft-sources">
          <summary><Scale size={15} /> המקורות המשפטיים בהודעה</summary>
          <ul>
            {draft.sources.map((source) => (
              <li key={source.issueId}>
                <strong>{source.title}</strong>
                {source.references.map((reference) => (
                  <div key={reference.lawReferenceId} className="draft-source">
                    <a href={reference.sourceUrl} target="_blank" rel="noopener noreferrer">
                      <BookOpen size={13} /> {reference.section ? `סעיף ${reference.section} ל` : ""}{reference.lawName}
                    </a>
                    {reference.excerpt ? <blockquote>{reference.excerpt}</blockquote> : null}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function RepliesPanel({ negotiation }: { negotiation: Negotiation }) {
  const { copied, copy } = useCopy();
  const titleOf = (reply: LikelyReply) => reply.issueId
    ? negotiation.issues.find((issue) => issue.issueId === reply.issueId)?.title ?? "נושא"
    : "על ההודעה כולה";
  return (
    <section className="replies-panel" aria-labelledby="replies-title">
      <span className="eyebrow">אם המשכיר עונה ש…</span>
      <h2 id="replies-title">תגובות אפשריות</h2>
      <ul>
        {negotiation.likelyReplies.map((reply, index) => (
          <li key={`${reply.issueId ?? "all"}-${index}`}>
            <small>{titleOf(reply)}</small>
            <p className="landlord-says">{reply.landlordReply}</p>
            <p className="tenant-answers">{reply.suggestedResponse}</p>
            <button className="ghost-button compact-button" type="button" onClick={() => void copy(`reply-${index}`, reply.suggestedResponse)}>
              <Copy size={14} /> {copied === `reply-${index}` ? "הועתק" : "העתקת התשובה"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanPanel({ negotiation }: { negotiation: Negotiation }) {
  const issueOf = (issueId: string) => negotiation.issues.find((issue) => issue.issueId === issueId);
  const chosen = negotiation.priorities.length > 0;
  const listed = chosen
    ? negotiation.priorities.map(issueOf).filter((issue): issue is NegotiationIssue => Boolean(issue))
    : negotiation.issues;
  return (
    <section className="plan-panel" aria-labelledby="plan-title">
      <span className="eyebrow">{chosen ? "לפי סדר החשיבות שלכם" : "מה נמצא בחוזה"}</span>
      <h2 id="plan-title">{chosen ? "התוכנית" : "הנושאים לשיחה"}</h2>
      <ol>
        {listed.map((issue) => {
          const strategy = negotiation.strategies[issue.issueId];
          const current = negotiation.currentIssueId === issue.issueId;
          return (
            <li key={issue.issueId} className={current ? "current" : ""} aria-current={current ? "true" : undefined}>
              <div className="plan-issue">
                <StatusBadge tone={SEVERITY_META[issue.severity].tone}>{SEVERITY_META[issue.severity].label}</StatusBadge>
                <strong>{issue.title}</strong>
              </div>
              {strategy ? (
                <div className={`plan-strategy strategy-${strategy.kind.toLowerCase()}`}>
                  <span>{STRATEGY_LABEL[strategy.kind]}</span>
                  {strategy.request ? <p>{strategy.request}</p> : null}
                  {strategy.fallback ? <p className="plan-fallback">המינימום שלכם (לא נכלל בהודעה): {strategy.fallback}</p> : null}
                </div>
              ) : current ? <span className="plan-now">מדברים על זה עכשיו</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
