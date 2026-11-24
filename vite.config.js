import { defineConfig } from 'vite';

// Relative base so the built site works under any GitHub Pages path
// (e.g. https://<user>.github.io/meditec-production-planner/).
// Routing uses the URL hash (#/today), so no server rewrites are needed.
export default defineConfig({
  base: './',
  build: {
    // The Excel library (~950 kB) is only downloaded when someone clicks "Export to Excel".
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // Separate, long-cacheable files for the two big libraries.
        manualChunks: { charts: ['chart.js'], supabase: ['@supabase/supabase-js'] },
      },
    },
  },
});
