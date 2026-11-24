import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests run in plain Node,
// without starting the Cloudflare Workers runtime.
export default defineConfig({
  test: {
    include: ["worker/**/*.test.ts", "evals/**/*.test.ts"],
  },
});
