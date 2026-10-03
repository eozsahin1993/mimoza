import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    rollupOptions: {
      // Separate pages rather than client-side routes: the stores fetch
      // /privacy and /support as plain documents, and a static host serves
      // them without an SPA fallback.
      input: {
        main: "index.html",
        privacy: "privacy/index.html",
        support: "support/index.html",
      },
    },
  },
});
