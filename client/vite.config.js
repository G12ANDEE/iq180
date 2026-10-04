import { defineConfig } from 'vite';

export default defineConfig({
  server: { fs: { allow: ['..'] } },
  preview: { port: 4173 },
});
