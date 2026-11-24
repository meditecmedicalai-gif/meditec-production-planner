import { defineConfig } from 'vite';

// Relative base so the built site works under any GitHub Pages path
// (e.g. https://<user>.github.io/meditec-production-planner/).
// Routing uses the URL hash (#/today), so no server rewrites are needed.
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        // Separate, long-cacheable files for the two big libraries.
        manualChunks: { charts: ['chart.js'], supabase: ['@supabase/supabase-js'] },
      },
    },
  },
});
