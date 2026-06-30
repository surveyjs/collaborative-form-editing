// Package ws bridges an incoming HTTP upgrade request to a session. It validates
// the session id BEFORE accepting (so a bad id is a plain HTTP 400, never a
// half-open WebSocket), accepts the socket, and hands it to the session actor.
package ws

import (
	"net/http"

	"github.com/coder/websocket"

	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/httpapi"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/session"
)

// Handler upgrades GET /ws/sessions/{id} to a WebSocket and joins the session.
type Handler struct {
	Hub *session.Hub
	// AllowAnyOrigin skips the library's same-origin Origin check. The client is
	// same-origin in production and the HTTP API already returns ACAO:*, so by
	// default we don't let an Origin header mismatch reject the connection.
	AllowAnyOrigin bool
}

// NewHandler wires the WS handler to a session hub.
func NewHandler(hub *session.Hub, allowAnyOrigin bool) *Handler {
	return &Handler{Hub: hub, AllowAnyOrigin: allowAnyOrigin}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Validate BEFORE Accept: an invalid id must surface as HTTP 400, not as an
	// accepted-then-closed socket (the Node server writes 400 and destroys the
	// raw socket here too).
	if !httpapi.SessionIDRe.MatchString(id) {
		httpapi.SendJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session id"})
		return
	}

	// Auto-create on first connect so a freshly-typed URL just works.
	s := h.Hub.GetOrCreate(id)

	opts := &websocket.AcceptOptions{
		// InsecureSkipVerify defers origin enforcement to AllowAnyOrigin. With it
		// true (the default), any Origin is accepted — appropriate for a relay
		// that already advertises ACAO:* and is fronted same-origin by the SPA.
		InsecureSkipVerify: h.AllowAnyOrigin,
	}
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		// Accept already wrote an error response on failure; nothing more to do.
		return
	}

	// Join blocks for the connection's lifetime (it runs the read pump inline),
	// so this handler goroutine stays alive until the peer disconnects. Use the
	// request context so a server shutdown / client cancellation unwinds cleanly.
	s.Join(r.Context(), conn)
}
