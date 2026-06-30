// Package relaytest holds an end-to-end relay test. It lives in its own package
// (not in session/) so it can wire the full HTTP+WS stack exactly as main does
// and talk to it over a real loopback socket, exercising byte-for-byte
// passthrough through the actual coder/websocket transport.
package relaytest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/httpapi"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/session"
	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/ws"
)

// newServer builds the same handler tree main.go builds and serves it on a
// loopback httptest server. Returns the server and its ws:// base URL.
func newServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	hub := session.NewHub(30*time.Minute, 8<<20)
	api := httpapi.NewAPI(hub)
	wsHandler := ws.NewHandler(hub, true)
	staticHandler, _ := newNotFoundStatic()
	router := &httpapi.Router{WS: wsHandler, Static: staticHandler, API: api}
	srv := httptest.NewServer(router.Build())
	t.Cleanup(srv.Close)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	return srv, wsURL
}

// newNotFoundStatic returns the JSON-404 catch-all (no SPA bundle in tests).
func newNotFoundStatic() (http.Handler, bool) {
	return http.HandlerFunc(httpapi.NotFoundJSON), false
}

// dial opens a WS client to /ws/sessions/{id}.
func dial(t *testing.T, ctx context.Context, base, id string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(ctx, base+"/ws/sessions/"+id, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", id, err)
	}
	t.Cleanup(func() { _ = c.Close(websocket.StatusNormalClosure, "") })
	return c
}

// readEnvelope reads one text frame and decodes its type + raw fields. Message
// is returned as raw bytes so the test can assert byte-identity.
func readEnvelope(t *testing.T, ctx context.Context, c *websocket.Conn) (typ, from string, schema, message json.RawMessage) {
	t.Helper()
	mt, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.MessageText {
		t.Fatalf("expected text frame, got %v", mt)
	}
	var env struct {
		Type    string          `json:"type"`
		From    string          `json:"from"`
		Schema  json.RawMessage `json:"schema"`
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("unmarshal envelope %q: %v", string(data), err)
	}
	return env.Type, env.From, env.Schema, env.Message
}

// readInit reads the init frame and returns the assigned clientId.
func readInit(t *testing.T, ctx context.Context, c *websocket.Conn) string {
	t.Helper()
	mt, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read init: %v", err)
	}
	if mt != websocket.MessageText {
		t.Fatalf("init: expected text frame")
	}
	var env struct {
		Type     string          `json:"type"`
		ClientID string          `json:"clientId"`
		Schema   json.RawMessage `json:"schema"`
		Stack    json.RawMessage `json:"stack"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("unmarshal init %q: %v", string(data), err)
	}
	if env.Type != "init" {
		t.Fatalf("expected type=init, got %q (frame %q)", env.Type, string(data))
	}
	// Stack must be the exact empty-stack literal (entries:[] not null).
	if got := string(env.Stack); got != `{"kind":"stack","cursor":0,"entries":[]}` {
		t.Errorf("init stack = %s; want empty-stack literal", got)
	}
	if env.ClientID == "" {
		t.Fatalf("init missing clientId")
	}
	return env.ClientID
}

// TestRelayEndToEnd covers the full contract: two clients receive init; a sync
// from A reaches B (tagged from=A's clientId) and is NOT echoed to A; the
// payload bytes survive verbatim; a late joiner C gets init then exactly one
// history-tagged replay with identical bytes.
func TestRelayEndToEnd(t *testing.T) {
	_, base := newServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Two clients A and B join the same session.
	a := dial(t, ctx, base, "test")
	b := dial(t, ctx, base, "test")

	idA := readInit(t, ctx, a)
	idB := readInit(t, ctx, b)
	if idA == "" || idB == "" || idA == idB {
		t.Fatalf("clientIds must be present and distinct: A=%q B=%q", idA, idB)
	}
	t.Logf("PASS: both A and B received init (A=%s B=%s)", idA, idB)

	// A sends a sync. Note the number 123 and the string id: if the relay ever
	// round-tripped this through a generic decode it would reformat the number,
	// so byte-identity below also guards the no-reformat invariant.
	payload := json.RawMessage(`{"kind":"transaction","id":"x","seq":123,"actions":[]}`)
	sendSync(t, ctx, a, payload)

	// B must receive it, tagged from A, bytes identical.
	typ, from, _, msg := readEnvelope(t, ctx, b)
	if typ != "sync" {
		t.Fatalf("B: expected sync, got %q", typ)
	}
	if from != idA {
		t.Errorf("B: from=%q; want A's clientId %q", from, idA)
	} else {
		t.Logf("PASS: B received sync tagged from=A (%s)", idA)
	}
	if string(msg) != string(payload) {
		t.Errorf("B: message bytes = %s; want %s (byte-identity broken)", msg, payload)
	} else {
		t.Logf("PASS: relayed message bytes byte-identical to A's payload")
	}

	// A must NOT receive its own sync back. Give the relay a moment, then assert
	// nothing arrives within a short deadline.
	if got := readWithin(a, 400*time.Millisecond); got != nil {
		t.Errorf("A: unexpectedly received a frame back: %s", got)
	} else {
		t.Logf("PASS: A did not receive its own sync echoed back")
	}

	// Late joiner C: must get init THEN exactly one history-tagged replay with
	// the identical bytes, and nothing more.
	c := dial(t, ctx, base, "test")
	idC := readInit(t, ctx, c)
	if idC == "" {
		t.Fatalf("C: missing init clientId")
	}
	t.Logf("PASS: late joiner C received init (C=%s)", idC)

	typ, from, _, msg = readEnvelope(t, ctx, c)
	if typ != "sync" {
		t.Fatalf("C: expected sync replay, got %q", typ)
	}
	if from != "history" {
		t.Errorf("C: replay from=%q; want \"history\"", from)
	} else {
		t.Logf("PASS: C's replay tagged from=history")
	}
	if string(msg) != string(payload) {
		t.Errorf("C: replay bytes = %s; want %s", msg, payload)
	} else {
		t.Logf("PASS: C's replayed bytes byte-identical to A's original payload")
	}
	if got := readWithin(c, 400*time.Millisecond); got != nil {
		t.Errorf("C: unexpected extra frame after the single replay: %s", got)
	} else {
		t.Logf("PASS: C received exactly one replay frame (no duplicates)")
	}
}

// sendSync writes {type:"sync", message:<payload>} to the connection.
func sendSync(t *testing.T, ctx context.Context, c *websocket.Conn, payload json.RawMessage) {
	t.Helper()
	frame, err := json.Marshal(struct {
		Type    string          `json:"type"`
		Message json.RawMessage `json:"message"`
	}{Type: "sync", Message: payload})
	if err != nil {
		t.Fatalf("marshal sync: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatalf("write sync: %v", err)
	}
}

// readWithin returns the next frame if one arrives within d, else nil. Used to
// assert the *absence* of a frame (e.g. no echo to the sender).
func readWithin(c *websocket.Conn, d time.Duration) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		return nil // timeout (or close) => no frame, which is what we want
	}
	return data
}
