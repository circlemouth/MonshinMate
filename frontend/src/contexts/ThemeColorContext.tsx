import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { ChakraProvider } from '@chakra-ui/react';
import { createTheme } from '../theme';

interface ThemeColorContextType {
  color: string;
  setColor: (c: string) => void;
}

const ThemeColorContext = createContext<ThemeColorContextType | undefined>(undefined);

export function ThemeColorProvider({ children }: { children: ReactNode }) {
  const [color, setColor] = useState('#1e88e5');
  const [theme, setTheme] = useState(createTheme('#1e88e5'));

  useEffect(() => {
    setTheme(createTheme(color));
  }, [color]);

  useEffect(() => {
    fetch('/system/theme-color')
      .then((r) => r.json())
      .then((d) => {
        if (d?.color) setColor(d.color);
      })
      .catch(() => {});
  }, []);

  return (
    <ThemeColorContext.Provider value={{ color, setColor }}>
      <ChakraProvider theme={theme}>{children}</ChakraProvider>
    </ThemeColorContext.Provider>
  );
}

export function useThemeColor() {
  const ctx = useContext(ThemeColorContext);
  if (!ctx) throw new Error('useThemeColor must be used within ThemeColorProvider');
  return ctx;
}
