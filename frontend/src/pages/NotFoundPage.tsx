import { ArrowRight, FileQuestion } from "lucide-react";
import { Link } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { ROUTES } from "../config/app";

export function NotFoundPage() {
  return <main className="not-found"><BrandMark /><span><FileQuestion size={34} /></span><h1>העמוד הזה לא נמצא</h1><p>כנראה שהקישור השתנה או שהמסמך הועבר.</p><Link className="primary-button" to={ROUTES.landing}><ArrowRight size={18} /> חזרה להתחלה</Link></main>;
}
