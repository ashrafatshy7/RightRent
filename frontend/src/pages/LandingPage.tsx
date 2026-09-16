import { ArrowLeft, CheckCircle2, FileCheck2, Fingerprint, Scale, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { BrandMark } from "../components/BrandMark";
import { ROUTES } from "../config/app";

const trustPoints = [
  { icon: Scale, title: "חוק לפני ניחוש", text: "כל קביעה משפטית מחוברת למקור ולסעיף שנבדק." },
  { icon: Fingerprint, title: "הפרטים נשארים פרטיים", text: "זיהוי פרטים אישיים מתבצע מקומית לפני כל שימוש בענן." },
  { icon: FileCheck2, title: "גם מה שלא כתוב חשוב", text: "המערכת מזהה הגנות שחסרות בחוזה ומציעה ניסוח ברור." },
] as const;

export function LandingPage() {
  const { user } = useAuth();
  return (
    <div className="landing-page">
      <header className="landing-nav">
        <BrandMark />
        <nav>
          <a href="#how-it-works">איך זה עובד</a>
          <a href="#privacy">פרטיות</a>
          <Link className="text-link" to={user ? ROUTES.app : ROUTES.login}>{user ? "לחשבון שלי" : "כניסה"}</Link>
          <Link className="primary-button compact-button" to={user ? ROUTES.upload : ROUTES.register}>
            {user ? "בדיקת חוזה" : "מתחילים כאן"}<ArrowLeft size={17} />
          </Link>
        </nav>
      </header>

      <main>
        <section className="hero-section">
          <div className="hero-copy">
            <span className="hero-kicker"><ShieldCheck size={17} /> בדיקת חוזה שמתחילה בזכויות שלך</span>
            <h1>לא חותמים<br />לפני ש<span>מבינים.</span></h1>
            <p>RightRent קוראת את חוזה השכירות, מסמנת סעיפים מסוכנים, משווה אותם להעדפות שלך ומראה בדיוק על מה כדאי להתעכב.</p>
            <div className="hero-actions">
              <Link className="primary-button" to={user ? ROUTES.upload : ROUTES.register}>בדקו את החוזה <ArrowLeft size={19} /></Link>
              <span><CheckCircle2 size={17} /> PDF אחד. תמונה ברורה. לפני החתימה.</span>
            </div>
          </div>

          <div className="contract-art" aria-label="המחשה של חוזה מסומן">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <article className="paper-card">
              <header><span>חוזה שכירות</span><small>עמוד 4 מתוך 9</small></header>
              <div className="paper-rule wide" /><div className="paper-rule" /><div className="paper-rule short" />
              <div className="clause-mark critical"><b>סעיף 12</b><span>ערבות גבוהה מהמותר</span><i>דורש שינוי</i></div>
              <div className="paper-rule wide" /><div className="paper-rule medium" />
              <div className="clause-mark warning"><b>סעיף 18</b><span>מועד תיקון אינו מוגדר</span><i>כדאי לדייק</i></div>
              <footer><span className="paper-seal"><Scale size={20} /></span><span>נבדק מול 13 מקורות חקיקה</span></footer>
            </article>
            <div className="floating-note note-red"><strong>1</strong><span>סעיף קריטי</span></div>
            <div className="floating-note note-green"><strong>8</strong><span>הגנות נבדקו</span></div>
          </div>
        </section>

        <section className="trust-strip" id="how-it-works">
          {trustPoints.map(({ icon: Icon, title, text }, index) => (
            <article key={title}><span>0{index + 1}</span><Icon size={23} /><div><h2>{title}</h2><p>{text}</p></div></article>
          ))}
        </section>

        <section className="privacy-callout" id="privacy">
          <div className="privacy-stamp"><Fingerprint size={34} /></div>
          <div><span className="eyebrow">פרטיות לפי תכנון</span><h2>החוזה שלך אינו חומר גלם.</h2></div>
          <p>שמות, כתובות, טלפונים ומזהים מוסרים מקומית. רק הטקסט הנחוץ לניתוח ממשיך הלאה, עם בדיקה שחוסמת דליפה לפני שליחה.</p>
        </section>
      </main>

      <footer className="landing-footer"><BrandMark /><p>כלי תומך החלטה — אינו תחליף לייעוץ משפטי.</p></footer>
    </div>
  );
}
