// Package static serves the built SPA (repo-root dist/client) with a
// path-traversal guard and a single-page-app fallback to index.html. It mirrors
// the Node server's serveStatic: real files are served as-is, extensionless GETs
// that miss fall back to index.html, and anything else is a JSON 404.
package static

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Handler builds an http.Handler that serves files from dist.
//
// If dist/index.html does not exist, the SPA cannot be served, so Handler
// returns (notFound, false) and the caller wires the API/WS-only routes with a
// JSON 404 catch-all instead. notFound is the JSON 404 handler to use in both
// the missing-asset case and the API-only case, so 404s look identical.
func Handler(dist string, notFound http.HandlerFunc) (http.Handler, bool) {
	indexPath := filepath.Join(dist, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		return http.HandlerFunc(notFound), false
	}

	h := &spaHandler{dist: dist, index: indexPath, notFound: notFound}
	return h, true
}

type spaHandler struct {
	dist     string
	index    string
	notFound http.HandlerFunc
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only GET serves assets; other methods on unknown paths are 404 (the API
	// routes are matched earlier by the mux and never reach here).
	if r.Method != http.MethodGet {
		h.notFound(w, r)
		return
	}

	// Resolve the request path against dist and refuse anything that escapes it.
	// filepath.Join(...) cleans "..", and the prefix check is the backstop
	// against traversal via encoded or absolute-looking paths.
	rel := strings.TrimLeft(r.URL.Path, "/")
	if rel == "" {
		rel = "index.html"
	}
	candidate := filepath.Join(h.dist, filepath.FromSlash(rel))
	if !within(h.dist, candidate) {
		h.notFound(w, r)
		return
	}

	info, err := os.Stat(candidate)
	if err == nil && info.IsDir() {
		candidate = filepath.Join(candidate, "index.html")
		info, err = os.Stat(candidate)
	}

	if err != nil {
		// SPA fallback: an extensionless GET (a client-side route like
		// /my-survey) gets index.html so the SPA boots and routes internally.
		// Requests for missing assets (with an extension) are a real 404.
		if filepath.Ext(rel) == "" {
			http.ServeFile(w, r, h.index)
			return
		}
		h.notFound(w, r)
		return
	}

	// http.ServeFile sets Content-Type from the file extension, handles range
	// requests and caching headers — no explicit MIME map needed.
	http.ServeFile(w, r, candidate)
}

// within reports whether child resolves inside parent (path-traversal guard).
func within(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
