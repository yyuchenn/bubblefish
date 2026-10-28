import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [svelte(), tailwindcss()],
  define: { __DESKTOP__: JSON.stringify(mode === 'desktop') },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    watch: { ignored: ['**/target/**', '**/.cache/**', '**/src-tauri/gen/**'] },
  },
  build: { target: 'es2022', outDir: mode === 'desktop' ? 'dist/desktop' : 'dist/web' },
  clearScreen: false,
}));
