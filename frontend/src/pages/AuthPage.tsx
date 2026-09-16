import { ArrowLeft, Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { BrandMark } from "../components/BrandMark";
import { ErrorNotice } from "../components/ErrorNotice";
import { ROUTES } from "../config/app";
import { messageForError } from "../lib/api-client";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLogin = mode === "login";

  if (user) return <Navigate replace to={ROUTES.app} />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await (isLogin ? login(email, password) : register(email, password));
      navigate(ROUTES.app, { replace: true });
    } catch (submissionError) {
      setError(messageForError(submissionError));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-story">
        <BrandMark />
        <div>
          <span className="hero-kicker"><ShieldCheck size={17} /> מרחב פרטי לחוזה שלך</span>
          <h1>{isLogin ? "טוב לראות אותך שוב." : "הדרך לחוזה ברור מתחילה כאן."}</h1>
          <p>נשמור את ההעדפות, הניתוחים והמסמכים המסומנים במקום אחד — ונראה רק לך את מה ששייך לך.</p>
        </div>
        <blockquote>״חוזה טוב הוא חוזה שמבינים לפני שחותמים.״</blockquote>
      </section>
      <main className="auth-panel">
        <Link className="back-link" to={ROUTES.landing}>חזרה לדף הבית</Link>
        <form onSubmit={submit}>
          <div className="form-heading"><span><LockKeyhole size={21} /></span><div><h2>{isLogin ? "כניסה לחשבון" : "פתיחת חשבון"}</h2><p>{isLogin ? "ממשיכים מהמקום שבו עצרתם" : "פחות מדקה ואתם בפנים"}</p></div></div>
          {error ? <ErrorNotice message={error} /> : null}
          <label className="field-label">כתובת אימייל<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="name@example.com" /></label>
          <label className="field-label">סיסמה<span className="password-field"><input type={showPassword ? "text" : "password"} autoComplete={isLogin ? "current-password" : "new-password"} minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="לפחות 10 תווים" /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "הסתרת סיסמה" : "הצגת סיסמה"}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
          <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>{isSubmitting ? "מתחברים…" : isLogin ? "כניסה מאובטחת" : "יצירת חשבון"}<ArrowLeft size={18} /></button>
          <p className="auth-switch">{isLogin ? "עדיין אין לך חשבון?" : "כבר יש לך חשבון?"} <Link to={isLogin ? ROUTES.register : ROUTES.login}>{isLogin ? "פתיחת חשבון" : "כניסה"}</Link></p>
        </form>
      </main>
    </div>
  );
}
