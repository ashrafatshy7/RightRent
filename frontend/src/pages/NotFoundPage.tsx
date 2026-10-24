import { ArrowRight, FileQuestion } from "lucide-react";
import { Link } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { ROUTES } from "../config/app";

export function NotFoundPage() {
  return <main className="not-found"><BrandMark /><span><FileQuestion size={34} /></span><h1>לא מצאנו את הדף הזה</h1><p>ייתכן שהקישור שגוי או שהדף הוסר.</p><Link className="primary-button" to={ROUTES.landing}><ArrowRight size={18} /> חזרה לדף הבית</Link></main>;
}
