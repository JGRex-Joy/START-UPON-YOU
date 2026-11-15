import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { PROXIED_HOSTS } from './src/config/hosts';

const proxy = Object.fromEntries(
  PROXIED_HOSTS.map((h) => [
    h.prefix,
    {
      target: h.origin,
      changeOrigin: true,
      secure: true,
      rewrite: (path: string) => path.slice(h.prefix.length),
    },
  ]),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { proxy },
  worker: { format: 'es' },
});
