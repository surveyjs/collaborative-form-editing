import { defineConfig } from "vitest/config";

// `messageNeedsTranslationRebuild` is pure and has no survey-core / DOM
// dependency, so a plain node environment is enough. Other client modules
// (the React component) are not exercised here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.{test,tests,spec}.{ts,tsx}"]
  }
});
