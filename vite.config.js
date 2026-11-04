import { defineConfig } from 'vite';

// Relative base: funktioniert auf GitHub Pages unabhängig vom Repo-Namen.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
});
