import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発時にバックエンド(8000)へプロキシする設定
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/questionnaires': 'http://localhost:8000',
      '/sessions': 'http://localhost:8000',
      '/llm': 'http://localhost:8000',
      '/healthz': 'http://localhost:8000',
      '/readyz': 'http://localhost:8000',
      '/metrics': 'http://localhost:8000',
    },
  },
});
