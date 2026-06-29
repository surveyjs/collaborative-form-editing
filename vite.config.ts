import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// The sync plugin's TypeScript source and the monorepo root (the plugin lives
// outside the client package).
const pluginSrc = path.resolve(dirname, "../creator-undo-redo-sync/src/index.ts");
const workspaceRoot = path.resolve(dirname, "../..");

// In dev, this config is loaded by the Node server which embeds Vite as
// middleware on the same HTTP port. In prod it is used by `vite build`.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            // Consume the sync plugin as TypeScript SOURCE rather than its built
            // CommonJS dist. The dist statically `require`s survey-core /
            // survey-creator-core, and Vite's dep optimizer then inlines a
            // PRIVATE copy of each into the plugin's optimized chunk (esbuild
            // does not externalize the deps of a CJS entry). That second
            // survey-core instance has its own class identities and its own
            // global `Base.UniqueId` counter, so questions the plugin
            // deserializes on a synced add fail the Creator's
            // `element instanceof Question` check (which uses the *other*
            // instance) and render without design adorners (no
            // `svc-question__adorner`). Compiling the plugin as part of the app
            // graph makes its `survey-core` imports resolve to the same shared
            // instance as survey-creator-react/-core. (The server keeps using
            // the CJS dist — on Node there is only ever one survey-core.)
            "@collab/creator-undo-redo-sync": pluginSrc
        },
        // Collapse the symlinked-from-sibling-repo survey packages (and React) to
        // a single instance across the whole graph, in both dev (esbuild) and
        // prod (Rollup).
        dedupe: ["survey-core", "survey-creator-core", "survey-creator-react", "react", "react-dom"]
    },
    optimizeDeps: {
        // Pre-bundle the survey packages into one shared optimized chunk each so
        // every importer (the plugin source included) references the same module.
        include: ["survey-core", "survey-creator-core", "survey-creator-react"]
    },
    server: {
        fs: {
            // Allow Vite to serve the plugin source, which sits outside the
            // client package root.
            allow: [workspaceRoot]
        }
    }
});
