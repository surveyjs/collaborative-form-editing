import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
    base: "/vue/",
    plugins: [vue()],
    // Expose SURVEYJS_* env vars (e.g. SURVEYJS_LICENSE_KEY from docker compose)
    // to the bundle via import.meta.env at BUILD time.
    envPrefix: ["VITE_", "SURVEYJS_"],
    resolve: {
        // file:-installed survey packages arrive via junctions; keep a single
        // survey-core instance or its Serializer singleton breaks.
        dedupe: ["survey-core", "survey-creator-core", "vue"]
    },
    server: {
        port: 5175,
        // Allow importing ../../shared/*.ts sources in dev mode.
        fs: { allow: ["../.."] },
        proxy: {
            "/api": "http://localhost:8080",
            "/ws": { target: "ws://localhost:8080", ws: true }
        }
    }
});
