import {
  ClipboardCheck,
  FileSearch,
  History,
  Home,
  LogOut,
  Scale,
  Settings2,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { BrandMark } from "../components/BrandMark";
import { ROUTES } from "../config/app";

const tenantNavigation = [
  { to: ROUTES.app, label: "ראשי", icon: Home, end: true },
  { to: ROUTES.upload, label: "בדיקת חוזה", icon: FileSearch },
  { to: ROUTES.preferences, label: "העדפות שכירות", shortLabel: "העדפות", icon: Settings2 },
  { to: ROUTES.history, label: "החוזים שלי", icon: History },
] as const;

export function AppShell() {
  const { user, logout } = useAuth();
  const navigation = user?.role === "ADMIN"
    ? [...tenantNavigation, { to: ROUTES.adminLaws, label: "ניהול חוקים", icon: ClipboardCheck }]
    : tenantNavigation;

  return (
    <div className="app-frame">
      <aside className="side-rail">
        <BrandMark />
        <nav className="side-navigation" aria-label="ניווט ראשי">
          {navigation.map(({ to, label, icon: Icon, ...item }) => (
            <NavLink key={to} to={to} end={"end" in item ? item.end : false}>
              <Icon size={19} />
              {"shortLabel" in item ? <><span className="nav-label-full">{label}</span><span className="nav-label-short">{item.shortLabel}</span></> : <span>{label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <div className="user-chip">
            <span><Scale size={17} /></span>
            <div><strong>{user?.email.split("@")[0]}</strong><small>{user?.role === "ADMIN" ? "מנהל מערכת" : "חשבון שוכר"}</small></div>
          </div>
          <button className="ghost-button rail-logout" type="button" onClick={logout}>
            <LogOut size={17} /> יציאה
          </button>
        </div>
      </aside>
      <main className="app-main">
        <div className="mobile-bar"><BrandMark compact /><span>{user?.email}</span></div>
        <Outlet />
      </main>
    </div>
  );
}
