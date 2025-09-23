import React from 'react';
import { renderToString } from 'react-dom/server';
import App from '../src/App';
import { ThemeColorProvider } from '../src/contexts/ThemeColorContext';
import { TimezoneProvider } from '../src/contexts/TimezoneContext';
import { AuthProvider } from '../src/contexts/AuthContext';
import { MemoryRouter } from 'react-router-dom';

global.sessionStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};

const html = renderToString(
  <ThemeColorProvider>
    <TimezoneProvider>
      <MemoryRouter initialEntries={["/admin/timezone"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </TimezoneProvider>
  </ThemeColorProvider>
);

console.log(html);
