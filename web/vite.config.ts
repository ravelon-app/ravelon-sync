import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The interface is served by the sync server itself, from the same origin, so
 * there is no API URL to bake in at build time and no CORS to configure. In
 * development Vite proxies the API to a local server instead.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The server serves this directly; nothing else consumes it.
    outDir: "../server/public",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    proxy: {
      "/v1": {
        target: process.env.VITE_DEV_API ?? "http://127.0.0.1:4100",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
