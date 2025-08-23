import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

// APIレスポンスの型定義
interface AuthStatus {
  is_initial_password: boolean;
  is_totp_enabled: boolean;
}

// Contextが提供する値の型定義
interface AuthContextType {
  isLoading: boolean;
  isAuthenticated: boolean;
  isInitialPassword: boolean;
  isTotpEnabled: boolean;
  showTotpSetup: boolean;
  setShowTotpSetup: (show: boolean) => void;
  login: (password: string, totpCode?: string) => Promise<boolean>;
  logout: () => void;
  checkAuthStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitialPassword, setIsInitialPassword] = useState(false);
  const [isTotpEnabled, setIsTotpEnabled] = useState(false);
  const [showTotpSetup, setShowTotpSetup] = useState(false);

  const checkAuthStatus = async () => {
    // 状態チェック中はローディングを維持
    if (!isLoading) setIsLoading(true);
    try {
      const loggedIn = sessionStorage.getItem('adminLoggedIn') === '1';
      setIsAuthenticated(loggedIn);

      const response = await fetch('/admin/auth/status');
      if (response.ok) {
        const data: AuthStatus = await response.json();
        setIsInitialPassword(data.is_initial_password);
        setIsTotpEnabled(data.is_totp_enabled);
      } else {
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Failed to fetch auth status:', error);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

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

  const value = {
    isLoading,
    isAuthenticated,
    isInitialPassword,
    isTotpEnabled,
    showTotpSetup,
    setShowTotpSetup,
    login,
    logout,
    checkAuthStatus,
  };

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
