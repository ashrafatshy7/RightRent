import { Link } from "react-router-dom";
import { APP, ROUTES } from "../config/app";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand-mark" to={ROUTES.landing} aria-label="RightRent — דף הבית">
      <span className="brand-symbol" aria-hidden="true">
        <svg viewBox="0 0 48 48" role="img">
          <path d="M8 18 24 7l16 11v21H8Z" />
          <path d="M17 39V24h14v15M14 19h20" />
          <path className="brand-check" d="m18 30 4 4 8-9" />
        </svg>
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>{APP.name}</strong>
          <small>{APP.tagline}</small>
        </span>
      )}
    </Link>
  );
}
