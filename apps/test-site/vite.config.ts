import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 4174, strictPort: true },
  build: { rollupOptions: { input: {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    ruleDefects: fileURLToPath(new URL('./rule-defects.html', import.meta.url)),
  } } },
});
