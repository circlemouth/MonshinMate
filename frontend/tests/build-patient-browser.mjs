// Run only in a source-only isolated frontend copy. Never serves or contacts a backend.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'patient-browser-dist');
await build({
  configFile: false,
  root,
  plugins: [react()],
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: { input: path.join(root, 'tests/patient-completion.html') },
  },
});
await fs.copyFile(path.join(outDir, 'tests/patient-completion.html'), path.join(outDir, 'index.html'));
console.log('Serve patient-browser-dist on loopback; use the official connected browser to run the tests.');
