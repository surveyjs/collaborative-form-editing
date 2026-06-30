// Package httpapi implements the REST surface of the relay (session create/get,
// health) plus the shared CORS + JSON helpers. It mirrors the Node server's
// behavior byte-for-byte where it matters: schema is passed through as raw JSON,
// and GET/auto-create both emit the empty stack.
package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/session"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/wire"
	"github.com/google/uuid"
)

// SessionIDRe matches user-chosen session ids: URL-safe, 1..128 chars. Same
// pattern as the Node server, used by both the REST and WS paths.
var SessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// API holds the dependencies for the REST handlers.
type API struct {
	Hub *session.Hub
}

// NewAPI wires the handlers to a session hub.
func NewAPI(hub *session.Hub) *API { return &API{Hub: hub} }

// CreateSession handles POST /api/sessions.
//
// Body is { schema? }. seedSchema = schema ?? {}. An empty or blank body is
// allowed and yields {}. Only malformed (non-empty, non-JSON) bodies are 400.
func (a *API) CreateSession(w http.ResponseWriter, r *http.Request) {
	body, err := readJSONBody(r)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var req wire.CreateRequest
	// body is "{}" for an empty/blank request (see readJSONBody), which unmarshals
	// to a nil Schema and is normalized to "{}" by the session. A non-empty body
	// that isn't valid JSON is a client error.
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	id := uuid.NewString()
	a.Hub.Create(id, req.Schema)
	sendJSON(w, http.StatusCreated, wire.CreateResponse{SessionID: id})
}

// GetSession handles GET /api/sessions/{id}.
//
// Returns the seed schema and an empty stack. Auto-creates the session if it
// does not exist so any user-chosen URL is a valid, joinable link. An id that
// fails SessionIDRe is a 400.
func (a *API) GetSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !SessionIDRe.MatchString(id) {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session id"})
		return
	}
	s := a.Hub.GetOrCreate(id)
	sendJSON(w, http.StatusOK, wire.SnapshotResponse{
		SessionID: id,
		Schema:    s.Seed(),
		Stack:     wire.EmptyStack(),
	})
}

// Health handles GET /health.
func (a *API) Health(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// readJSONBody reads the request body, mirroring the Node server's readJsonBody:
// an empty or whitespace-only body becomes the literal "{}" (a valid empty
// request), so the caller never has to special-case "no body". A non-empty body
// is returned verbatim for the caller to unmarshal/validate.
func readJSONBody(r *http.Request) (json.RawMessage, error) {
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r.Body); err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(buf.Bytes())
	if len(trimmed) == 0 {
		return json.RawMessage("{}"), nil
	}
	return json.RawMessage(trimmed), nil
}

// sendJSON writes a JSON response with the CORS allow-origin header that every
// JSON response in this server carries (matching the Node server). Marshalling
// failures are swallowed: the body is trusted server-controlled data.
func sendJSON(w http.ResponseWriter, status int, body any) {
	payload, err := json.Marshal(body)
	if err != nil {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// SendJSON is the exported JSON writer for use by the router's 404 catch-all so
// every error response (including static-miss 404s) is shaped identically.
func SendJSON(w http.ResponseWriter, status int, body any) { sendJSON(w, status, body) }
