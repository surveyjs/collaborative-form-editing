import { defineConfig, devices } from "@playwright/test";

/**
 * Browser e2e tests for the collaborative Survey Creator (v2, journal-based).
 *
 * The server serves the lobby plus the four PRE-BUILT client bundles, so run
 * `npm run build:clients` (or `npm start`, which builds and serves) before the
 * first test run. The webServer below only starts the relay server; with
 * `reuseExistingServer` a dev can keep `npm start`/`npm run server` running
 * between runs.
 */
export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? "html" : "list",
    timeout: 120_000,
    expect: { timeout: 15_000 },
    use: {
        baseURL: "http://localhost:8080",
        trace: "on-first-retry",
        actionTimeout: 15_000,
        navigationTimeout: 30_000
    },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } }
    ],
    webServer: {
        command: "npm run server",
        url: "http://localhost:8080/health",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000
    }
});
