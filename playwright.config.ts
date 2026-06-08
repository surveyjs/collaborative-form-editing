import { defineConfig, devices } from "@playwright/test";

/**
 * Browser e2e tests for the collaborative Survey Creator.
 *
 * The dev server (`npm run dev`) serves both the client UI (via Vite
 * middleware) and the collaboration WebSocket on http://localhost:8080, so a
 * single origin backs the whole app. Playwright boots it and waits for `/`.
 *
 * The first request compiles the (large) Creator bundle through Vite, so the
 * server boot and per-test timeouts are generous.
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
        command: "npm run dev",
        url: "http://localhost:8080",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000
    }
});
