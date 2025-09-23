import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { ChakraProvider } from '@chakra-ui/react';
import { createThemeArtifacts, AccentPalette } from '../theme';

interface ThemeColorContextType {
  color: string;
  setColor: (c: string) => void;
  palette: AccentPalette;
}

const ThemeColorContext = createContext<ThemeColorContextType | undefined>(undefined);

export function ThemeColorProvider({ children }: { children: ReactNode }) {
  const [color, setColor] = useState('#1e88e5');

  const artifacts = useMemo(() => createThemeArtifacts(color), [color]);

  useEffect(() => {
    fetch('/system/theme-color')
      .then((r) => r.json())
      .then((d) => {
        if (d?.color) setColor(d.color);
      })
      .catch(() => {});
  }, []);

  const contextValue = useMemo(
    () => ({ color, setColor, palette: artifacts.accentPalette }),
    [color, artifacts.accentPalette]
  );

  return (
    <ThemeColorContext.Provider value={contextValue}>
      <ChakraProvider theme={artifacts.theme}>{children}</ChakraProvider>
    </ThemeColorContext.Provider>
  );
}

export function useThemeColor() {
  const ctx = useContext(ThemeColorContext);
  if (!ctx) throw new Error('useThemeColor must be used within ThemeColorProvider');
  return ctx;
}
