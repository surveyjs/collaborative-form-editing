import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// In dev, this config is loaded by the Node server which embeds Vite as
// middleware on the same HTTP port. In prod it is used by `vite build`.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@collab/shared": fileURLToPath(new URL("../../protocol/index.d.ts", import.meta.url))
        }
    }
});
