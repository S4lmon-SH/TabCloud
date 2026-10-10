import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const serverPort = process.env.PORT || environment.PORT || '3001';
  return {
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
      '/healthz': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true, changeOrigin: false },
    },
  },
  };
});
