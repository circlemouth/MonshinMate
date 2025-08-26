import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeColorProvider } from './contexts/ThemeColorContext';
import App from './App';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';

// グローバル fetch をラップし、LLM エラーをイベントとして通知する。
const originalFetch = window.fetch.bind(window);
window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
  const res = await originalFetch(...args);
  const err = res.headers.get('X-LLM-Error');
  if (err) {
    window.dispatchEvent(new CustomEvent('llmError', { detail: err }));
  }
  return res;
};

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
