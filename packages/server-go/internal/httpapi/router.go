package httpapi

import (
	"net/http"
)

// Router assembles the full request mux: the REST API, the WS upgrade endpoint,
// CORS preflight, and the static SPA (or a JSON 404 catch-all when the SPA is
// not present). The Go 1.22 ServeMux method+path patterns give us precise
// routing without a third-party router.
type Router struct {
	// WS handles GET /ws/sessions/{id} (wired in main to avoid an import cycle
	// between httpapi and ws).
	WS http.Handler
	// Static serves the SPA / acts as the GET catch-all. Always non-nil; when
	// the bundle is absent it is the JSON 404 handler.
	Static http.Handler
	API    *API
}

// Build returns the root http.Handler with CORS applied to every response.
func (rt *Router) Build() http.Handler {
	mux := http.NewServeMux()

	// REST API.
	mux.HandleFunc("POST /api/sessions", rt.API.CreateSession)
	mux.HandleFunc("GET /api/sessions/{id}", rt.API.GetSession)
	mux.HandleFunc("GET /health", rt.API.Health)

	// WebSocket upgrade.
	mux.Handle("GET /ws/sessions/{id}", rt.WS)

	// Everything else: the SPA file server (which 404s as JSON on a miss) or the
	// JSON 404 catch-all when no bundle is present. "/" matches all unclaimed
	// paths in a Go 1.22 mux.
	mux.Handle("/", rt.Static)

	return withCORS(mux)
}

// withCORS handles OPTIONS preflight (204 + CORS headers) and otherwise passes
// through. Per-response Access-Control-Allow-Origin is set by sendJSON / the
// static server; this wrapper only needs to short-circuit preflight, matching
// the Node server's OPTIONS branch.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", "*")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// NotFoundJSON is the shared JSON 404 handler ({"error":"not found"}), used both
// as the static-miss response and as the API-only catch-all.
func NotFoundJSON(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}
