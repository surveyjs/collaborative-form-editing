import { defineConfig } from "vitest/config";

// We consume the BUILT survey-core / survey-creator-core bundles (symlinked
// into node_modules and already asset-processed), so the upstream css/svg stub
// plugin and source aliases are not needed here: plain node_modules resolution
// gives both the test and creator-core's internals a single shared survey-core
// instance.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Creator components schedule debounced/adorner setTimeout callbacks that
    // can fire after a test has torn down its DOM; treat those benign timer
    // leaks as non-fatal (matches the upstream survey-creator-core config).
    dangerouslyIgnoreUnhandledErrors: true,
    include: ["test/**/*.{test,tests,spec}.{ts,tsx}"],
    setupFiles: ["./test/vitest.setup.ts"]
  }
});
