import { defineConfig } from "vite";

export default defineConfig({
    base: "/js/",
    // Expose SURVEYJS_* env vars (e.g. SURVEYJS_LICENSE_KEY from docker compose)
    // to the bundle via import.meta.env at BUILD time.
    envPrefix: ["VITE_", "SURVEYJS_"],
    // Single shared .env at the repo root serves all clients.
    envDir: "../..",
    resolve: {
        // file:-installed survey packages arrive via junctions; keep a single
        // survey-core instance or its Serializer singleton breaks.
        dedupe: ["survey-core", "survey-creator-core"]
    },
    server: {
        port: 5173,
        // Allow importing ../../shared/*.ts sources in dev mode.
        fs: { allow: ["../.."] },
        proxy: {
            "/api": "http://localhost:8080",
            "/ws": { target: "ws://localhost:8080", ws: true }
        }
    }
});
