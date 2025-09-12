import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useMemo } from 'react';

// APIレスポンスの型定義
interface AuthStatus {
  is_initial_password: boolean;
  is_totp_enabled: boolean;
  emergency_reset_available?: boolean;
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
  login: (password: string, totpCode?: string) => Promise<boolean>;
  logout: () => void;
  // ローディング表示を抑制したまま認証状態を確認したい場合は
  // suppressLoading を true に指定する
  checkAuthStatus: (suppressLoading?: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitialPassword, setIsInitialPassword] = useState(false);
  const [isTotpEnabled, setIsTotpEnabled] = useState(false);
  const [emergencyResetAvailable, setEmergencyResetAvailable] = useState(false);
  const [showTotpSetup, setShowTotpSetup] = useState(false);

  // NOTE: checkAuthStatus が再生成されると依存コンポーネントの useEffect が連続発火し、
  // 画面がローディング↔入力の高速切替（フリッカー）を起こすため、useCallbackで安定化する。
  const checkAuthStatus = useCallback(async (suppressLoading = false) => {
    if (!suppressLoading) setIsLoading(true);
    try {
      const loggedIn = sessionStorage.getItem('adminLoggedIn') === '1';
      setIsAuthenticated(loggedIn);

      const response = await fetch('/admin/auth/status');
      if (response.ok) {
        const data: AuthStatus = await response.json();
        setIsInitialPassword(data.is_initial_password);
        setIsTotpEnabled(data.is_totp_enabled);
        setEmergencyResetAvailable(Boolean(data.emergency_reset_available));
      } else {
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Failed to fetch auth status:', error);
      setIsAuthenticated(false);
    } finally {
      if (!suppressLoading) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const login = async (password: string, totpCode?: string): Promise<boolean> => {
    // このlogin関数はApp.tsxからロジックを移行してくる予定
    console.log(password, totpCode);
    return false;
  };

  const logout = () => {
    sessionStorage.removeItem('adminLoggedIn');
    setIsAuthenticated(false);
  };

  // Context値もuseMemoで包んで不要な再レンダ/参照変化を抑制
  const value = useMemo(() => ({
    isLoading,
    isAuthenticated,
    isInitialPassword,
    isTotpEnabled,
    emergencyResetAvailable,
    showTotpSetup,
    setShowTotpSetup,
    login,
    logout,
    checkAuthStatus,
  }), [
    isLoading,
    isAuthenticated,
    isInitialPassword,
    isTotpEnabled,
    emergencyResetAvailable,
    showTotpSetup,
    login,
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
