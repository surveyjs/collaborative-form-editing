import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    base: "/",
    plugins: [react()],
    resolve: {
        // file:-installed survey packages arrive via junctions; keep a single
        // survey-core instance or its Serializer singleton breaks.
        dedupe: ["survey-core", "react", "react-dom"]
    },
    server: {
        port: 5177,
        proxy: {
            "/api": "http://localhost:8080",
            "/ws": { target: "ws://localhost:8080", ws: true }
        }
    }
});
