import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { APP } from "../config/app";
import { api } from "../lib/api-client";
import type { PublicUser } from "../types/api";

type AuthContextValue = {
  token: string | null;
  user: PublicUser | null;
  isRestoring: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  updateUser: (user: PublicUser) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function storedToken() {
  try {
    return localStorage.getItem(APP.sessionStorageKey);
  } catch {
    return null;
  }
}

function persistToken(token: string | null) {
  try {
    if (token) localStorage.setItem(APP.sessionStorageKey, token);
    else localStorage.removeItem(APP.sessionStorageKey);
  } catch {
    // Private browsing can deny storage; the in-memory session remains usable.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(storedToken);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [isRestoring, setIsRestoring] = useState(Boolean(token));

  const logout = useCallback(() => {
    persistToken(null);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    if (!token) {
      setIsRestoring(false);
      return;
    }
    let active = true;
    api.me(token)
      .then(({ user: currentUser }) => {
        if (active) setUser(currentUser);
      })
      .catch(() => {
        if (active) logout();
      })
      .finally(() => {
        if (active) setIsRestoring(false);
      });
    return () => { active = false; };
  }, [logout, token]);

  const establishSession = useCallback((nextToken: string, nextUser: PublicUser) => {
    persistToken(nextToken);
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    establishSession(result.token, result.user);
  }, [establishSession]);

  const register = useCallback(async (email: string, password: string) => {
    const result = await api.register(email, password);
    establishSession(result.token, result.user);
  }, [establishSession]);

  const value = useMemo<AuthContextValue>(() => ({
    token,
    user,
    isRestoring,
    login,
    register,
    logout,
    updateUser: setUser,
  }), [isRestoring, login, logout, register, token, user]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const context = use(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
