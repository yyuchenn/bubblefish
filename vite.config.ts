import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [svelte(), tailwindcss()],
  // The archived app and generated plugin HTML belong to separate builds.
  optimizeDeps: { entries: ['index.html', 'tests/fixtures/header/index.html'] },
  define: { __DESKTOP__: JSON.stringify(mode === 'desktop') },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    watch: { ignored: ['**/legacy/**', '**/target/**', '**/.cache/**', '**/src-tauri/gen/**'] },
  },
  build: { target: 'es2022', outDir: mode === 'desktop' ? 'dist/desktop' : 'dist/web' },
  clearScreen: false,
}));
