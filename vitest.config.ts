import { defineConfig } from "vitest/config";

// Pure-function suites only (scoring, week math, formatting). Anything that
// needs the Workers runtime is exercised through `wrangler dev` + curl instead,
// which keeps @cloudflare/vitest-pool-workers out of the dependency tree.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
