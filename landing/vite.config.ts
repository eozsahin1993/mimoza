import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    rollupOptions: {
      // A second page rather than a client-side route: the stores fetch
      // /privacy as a plain document, and a static host serves it without
      // an SPA fallback.
      input: {
        main: "index.html",
        privacy: "privacy/index.html",
      },
    },
  },
});
