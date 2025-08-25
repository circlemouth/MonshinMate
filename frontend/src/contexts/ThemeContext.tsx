import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { ChakraProvider } from '@chakra-ui/react';
import createTheme, { ThemeName, themeNames } from '../theme';

type ThemeContextValue = {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  themes: ThemeName[];
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'blue',
  setTheme: () => {},
  themes: themeNames,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>('blue');

  // サーバーから現在のテーマを取得
  useEffect(() => {
    fetch('/system/theme-color')
      .then((r) => r.json())
      .then((d) => {
        if (d?.theme && themeNames.includes(d.theme)) {
          setTheme(d.theme);
        }
      })
      .catch(() => {});
  }, []);

  const chakraTheme = useMemo(() => createTheme(theme), [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: themeNames }}>
      <ChakraProvider theme={chakraTheme}>{children}</ChakraProvider>
    </ThemeContext.Provider>
  );
}

export function useThemeColor() {
  return useContext(ThemeContext);
}
