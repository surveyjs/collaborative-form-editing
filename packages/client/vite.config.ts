import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, this config is loaded by the Node server which embeds Vite as
// middleware on the same HTTP port. In prod it is used by `vite build`.
export default defineConfig({
    plugins: [react()],
    // The sync plugin is a CommonJS workspace package. Its symlinked path is
    // outside node_modules, so by default neither esbuild (dev) nor Rollup's
    // commonjs transform (build) processes it — and Rollup then fails to see
    // its named exports. Force both to handle it explicitly.
    optimizeDeps: {
        include: ["@collab/creator-undo-redo-sync"]
    },
    build: {
        commonjsOptions: {
            include: [/creator-undo-redo-sync/, /node_modules/]
        }
    }
});
