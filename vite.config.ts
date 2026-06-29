import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, this config is loaded by the Node server which embeds Vite as
// middleware on the same HTTP port. In prod it is used by `vite build`.
//
// The undo/redo sync plugin used to be consumed as raw TypeScript source via an
// alias to avoid esbuild inlining a second, private `survey-core` instance. It
// now ships inside `survey-creator-core` itself, so it shares that package's
// single shared instance automatically and no alias / source hack is needed.
export default defineConfig({
    plugins: [react()],
    build: {
        // Keep the client bundle in its own subtree so it does not collide with
        // the server's `tsc` output (dist/server).
        outDir: "dist/client",
        emptyOutDir: true
    },
    resolve: {
        // Collapse the symlinked-from-sibling-repo survey packages (and React) to
        // a single instance across the whole graph, in both dev (esbuild) and
        // prod (Rollup).
        dedupe: ["survey-core", "survey-creator-core", "survey-creator-react", "react", "react-dom"]
    },
    optimizeDeps: {
        // Pre-bundle the survey packages into one shared optimized chunk each so
        // every importer references the same module.
        include: ["survey-core", "survey-creator-core", "survey-creator-react"]
    }
});
