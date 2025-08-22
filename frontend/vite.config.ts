import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発時にバックエンド(8001)へプロキシする設定
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/questionnaires': 'http://localhost:8001',
      '/sessions': 'http://localhost:8001',
      '/llm': 'http://localhost:8001',
      '/healthz': 'http://localhost:8001',
      '/readyz': 'http://localhost:8001',
      '/metrics': 'http://localhost:8001',
      '/admin': 'http://localhost:8001',
    },
  },
});
