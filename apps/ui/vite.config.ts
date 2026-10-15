import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/plugins': 'http://127.0.0.1:4173', '/v1': 'http://127.0.0.1:4173' } } });
