import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({ root: import.meta.dirname, base: './', plugins: [react()], server: { fs: { allow: [path.resolve(import.meta.dirname, '../../..')] }, host: '127.0.0.1', strictPort: true, port: 5173, watch: { ignored: ['**/release/**'] } } });
