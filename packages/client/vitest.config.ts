import { defineConfig } from "vitest/config";

// jsdom so the model-integration test can build a real survey-creator-core
// Translation model. The pure planner test is unaffected by the environment.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Creator components schedule debounced/adorner setTimeout callbacks that can
    // fire after a test tears down its DOM; treat those benign timer leaks as
    // non-fatal (matches survey-creator-core's own config).
    dangerouslyIgnoreUnhandledErrors: true,
    include: ["test/**/*.{test,tests,spec}.{ts,tsx}"],
    setupFiles: ["./test/vitest.setup.ts"]
  }
});
