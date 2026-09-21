import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    // `fat-horses serve --port 8080` provides the API during development.
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
  build: {
    // MapLibre alone is ~800 kB; one bundle is fine for a single-user app.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: "jsdom",
  },
});
