import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { ChakraProvider } from '@chakra-ui/react';
import { createThemeArtifacts, AccentPalette } from '../theme';
import { loadSystemBootstrap, patchSystemBootstrap } from '../systemBootstrap';

interface ThemeColorContextType {
  color: string;
  setColor: (c: string) => void;
  palette: AccentPalette;
}

const ThemeColorContext = createContext<ThemeColorContextType | undefined>(undefined);

export function ThemeColorProvider({ children }: { children: ReactNode }) {
  const [color, setColorState] = useState('#1e88e5');

  const artifacts = useMemo(() => createThemeArtifacts(color), [color]);

  useEffect(() => {
    loadSystemBootstrap()
      .then((settings) => {
        setColorState(settings.theme_color);
      })
      .catch(() => {});
  }, []);

  const setColor = useCallback((nextColor: string) => {
    setColorState(nextColor);
    patchSystemBootstrap({ theme_color: nextColor });
  }, []);

  const contextValue = useMemo(
    () => ({ color, setColor, palette: artifacts.accentPalette }),
    [color, setColor, artifacts.accentPalette]
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
