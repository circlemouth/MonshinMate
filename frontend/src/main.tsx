import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeColorProvider } from './contexts/ThemeColorContext';
import { TimezoneProvider } from './contexts/TimezoneContext';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';
import { NotificationProvider } from './contexts/NotificationContext';
import { DialogProvider } from './contexts/DialogContext';
import { setupApiFetch } from './config/api';

setupApiFetch();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeColorProvider>
      <TimezoneProvider>
        <BrowserRouter>
          <AuthProvider>
            <NotificationProvider>
              <DialogProvider>
                <App />
              </DialogProvider>
            </NotificationProvider>
          </AuthProvider>
        </BrowserRouter>
      </TimezoneProvider>
    </ThemeColorProvider>
  </React.StrictMode>,
);
