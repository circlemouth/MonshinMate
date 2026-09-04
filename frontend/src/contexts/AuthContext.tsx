import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { adminFetch } from '../utils/adminApi';

// APIレスポンスの型定義
interface AuthStatus {
  is_initial_password: boolean;
  is_totp_enabled: boolean;
  emergency_reset_available?: boolean;
  is_authenticated?: boolean;
}

// Contextが提供する値の型定義
interface AuthContextType {
  isLoading: boolean;
  isAuthenticated: boolean;
  isInitialPassword: boolean;
  isTotpEnabled: boolean;
  emergencyResetAvailable: boolean;
  showTotpSetup: boolean;
  setShowTotpSetup: (show: boolean) => void;
  logout: () => void;
  // ローディング表示を抑制したまま認証状態を確認したい場合は
  // suppressLoading を true に指定する
  checkAuthStatus: (suppressLoading?: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const requiresInitialAuthCheck = (pathname: string) =>
  pathname === '/chat' || pathname.startsWith('/admin');

const hasStoredAdminSession = () => {
  try {
    return (
      sessionStorage.getItem('adminLoggedIn') === '1' &&
      Boolean(sessionStorage.getItem('adminAccessToken'))
    );
  } catch {
    return false;
  }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const [isLoading, setIsLoading] = useState(() => requiresInitialAuthCheck(location.pathname));
  const [isAuthenticated, setIsAuthenticated] = useState(hasStoredAdminSession);
  const [isInitialPassword, setIsInitialPassword] = useState(false);
  const [isTotpEnabled, setIsTotpEnabled] = useState(false);
  const [emergencyResetAvailable, setEmergencyResetAvailable] = useState(false);
  const [showTotpSetup, setShowTotpSetup] = useState(false);
  const lastCheckedTokenRef = useRef<string | null | undefined>(undefined);
  const authRequestRef = useRef<Promise<void> | null>(null);

  // NOTE: checkAuthStatus が再生成されると依存コンポーネントの useEffect が連続発火し、
  // 画面がローディング↔入力の高速切替（フリッカー）を起こすため、useCallbackで安定化する。
  const checkAuthStatus = useCallback(async (suppressLoading = false) => {
    const token = sessionStorage.getItem('adminAccessToken');
    if (lastCheckedTokenRef.current === token) {
      if (!suppressLoading) setIsLoading(false);
      return;
    }
    if (authRequestRef.current) {
      return authRequestRef.current;
    }
    if (!suppressLoading) setIsLoading(true);
    const request = (async () => {
      try {
        const loggedIn = sessionStorage.getItem('adminLoggedIn') === '1';
        const response = await adminFetch('/admin/auth/status');
        if (response.ok) {
          const data: AuthStatus = await response.json();
          const authenticated = loggedIn && Boolean(data.is_authenticated);
          setIsAuthenticated(authenticated);
          setIsInitialPassword(data.is_initial_password);
          setIsTotpEnabled(data.is_totp_enabled);
          setEmergencyResetAvailable(Boolean(data.emergency_reset_available));
          if (loggedIn && !authenticated) {
            sessionStorage.removeItem('adminLoggedIn');
            sessionStorage.removeItem('adminAccessToken');
          }
          lastCheckedTokenRef.current = authenticated ? token : null;
        } else {
          setIsAuthenticated(false);
          lastCheckedTokenRef.current = token;
        }
      } catch (error) {
        console.error('Failed to fetch auth status:', error);
        setIsAuthenticated(false);
      } finally {
        if (!suppressLoading) setIsLoading(false);
      }
    })();
    authRequestRef.current = request;
    try {
      await request;
    } finally {
      if (authRequestRef.current === request) {
        authRequestRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!requiresInitialAuthCheck(location.pathname)) {
      setIsLoading(false);
      return;
    }
    const token = sessionStorage.getItem('adminAccessToken');
    if (lastCheckedTokenRef.current === token) {
      setIsLoading(false);
      return;
    }
    void checkAuthStatus();
  }, [location.pathname, checkAuthStatus]);

  const logout = useCallback(() => {
    sessionStorage.removeItem('adminLoggedIn');
    sessionStorage.removeItem('adminAccessToken');
    lastCheckedTokenRef.current = undefined;
    setIsAuthenticated(false);
  }, []);

  // Context値もuseMemoで包んで不要な再レンダ/参照変化を抑制
  const value = useMemo(() => ({
    isLoading,
    isAuthenticated,
    isInitialPassword,
    isTotpEnabled,
    emergencyResetAvailable,
    showTotpSetup,
    setShowTotpSetup,
    logout,
    checkAuthStatus,
  }), [
    isLoading,
    isAuthenticated,
    isInitialPassword,
    isTotpEnabled,
    emergencyResetAvailable,
    showTotpSetup,
    logout,
    checkAuthStatus,
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
