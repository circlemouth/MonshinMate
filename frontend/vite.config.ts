import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// 開発時にバックエンド(8001)へプロキシする設定
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'spa-admin-fallback',
      configureServer(server) {
        const apiPrefixes = ['/admin/auth', '/admin/password', '/admin/login', '/admin/totp', '/admin/sessions'];
        server.middlewares.use(async (req, res, next) => {
          const url = req.url || '';
          if (url.startsWith('/admin') && !apiPrefixes.some((p) => url.startsWith(p))) {
            try {
              const indexPath = path.resolve(process.cwd(), 'frontend', 'index.html');
              const htmlRaw = fs.readFileSync(indexPath, 'utf-8');
              const html = await server.transformIndexHtml(url, htmlRaw);
              res.setHeader('Content-Type', 'text/html');
              res.end(html);
              return;
            } catch (e) {
              // フォールバック失敗時は通常のハンドラへ
            }
          }
          next();
        });
      },
    },
  ],
  server: {
    proxy: {
      '/questionnaires': 'http://localhost:8001',
      '/sessions': 'http://localhost:8001',
      '/llm': 'http://localhost:8001',
      '/system': 'http://localhost:8001',
      '/healthz': 'http://localhost:8001',
      '/readyz': 'http://localhost:8001',
      '/metrics': 'http://localhost:8001',
      '/admin/auth': 'http://localhost:8001',
      '/admin/password': 'http://localhost:8001',
      '/admin/login': 'http://localhost:8001',
      '/admin/totp': 'http://localhost:8001',
      '/admin/sessions': 'http://localhost:8001',
    },
  },
});
