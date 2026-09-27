import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests live in test/, mirroring src/; runtime code in src/ has none.
  test: { include: ["test/**/*.test.ts"] },
});
