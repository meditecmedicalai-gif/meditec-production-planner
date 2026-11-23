import { defineConfig } from 'vite';

// Relative base so the built site works under any GitHub Pages path
// (e.g. https://<user>.github.io/meditec-production-planner/).
// Routing uses the URL hash (#/planner), so no server rewrites are needed.
export default defineConfig({
  base: './',
});
