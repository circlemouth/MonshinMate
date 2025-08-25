import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeColorProvider } from './contexts/ThemeColorContext';
import App from './App';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeColorProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeColorProvider>
  </React.StrictMode>,
);
