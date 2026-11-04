import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Relative base: funktioniert auf GitHub Pages unabhängig vom Repo-Namen.
export default defineConfig({
  base: './',
  // Versionsnummer aus package.json, wird am Seitenrand angezeigt
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { chunkSizeWarningLimit: 1200 },
});
