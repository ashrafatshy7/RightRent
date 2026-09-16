import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { LoadingState } from "../components/LoadingState";
import { ROUTES } from "../config/app";
import { AppShell } from "../layout/AppShell";
import { AdminLawsPage } from "../pages/AdminLawsPage";
import { AnalysisPage } from "../pages/AnalysisPage";
import { AuthPage } from "../pages/AuthPage";
import { DashboardPage } from "../pages/DashboardPage";
import { HistoryPage } from "../pages/HistoryPage";
import { LandingPage } from "../pages/LandingPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { PreferencesPage } from "../pages/PreferencesPage";
import { UploadPage } from "../pages/UploadPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

function ProtectedRoute() {
  const { token, user, isRestoring } = useAuth();
  if (isRestoring) return <div className="full-page-loader"><LoadingState label="משחזרים את החשבון" /></div>;
  if (!token || !user) return <Navigate replace to={ROUTES.login} />;
  return <AppShell />;
}

function AdminRoute() {
  const { user } = useAuth();
  return user?.role === "ADMIN" ? <AdminLawsPage /> : <Navigate replace to={ROUTES.app} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Routes>
          <Route path={ROUTES.landing} element={<LandingPage />} />
          <Route path={ROUTES.login} element={<AuthPage mode="login" />} />
          <Route path={ROUTES.register} element={<AuthPage mode="register" />} />
          <Route path={ROUTES.app} element={<ProtectedRoute />}>
            <Route index element={<DashboardPage />} />
            <Route path="upload" element={<UploadPage />} />
            <Route path="preferences" element={<PreferencesPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="analysis/:analysisId" element={<AnalysisPage />} />
            <Route path="admin/laws" element={<AdminRoute />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </QueryClientProvider>
  );
}
