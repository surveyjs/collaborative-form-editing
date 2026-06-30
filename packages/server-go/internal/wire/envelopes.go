// Package wire defines the exact JSON envelopes exchanged with the client.
//
// Byte-compatibility is the whole point of this package: the relay must not
// reinterpret payloads. The opaque `message` and the seed `schema` are kept as
// json.RawMessage so they are forwarded byte-for-byte. Unmarshalling them into
// map[string]any / float64 and re-marshalling would reformat numbers (e.g.
// reorder object keys, drop precision) and corrupt transaction ids and values,
// which would silently break undo/redo merging on the clients.
package wire

import "encoding/json"

// Envelope type discriminators (the wire `type` field).
const (
	TypeSync = "sync"
	TypeInit = "init"
)

// FromHistory is the literal `from` value used when replaying the session log
// to a late joiner. The client only suppresses syncs whose `from` equals its
// own clientId; the history tag never matches a UUID, so replayed messages are
// always applied.
const FromHistory = "history"

// Stack mirrors ISyncStackSnapshot on the client. The relay never computes a
// real stack — every joiner gets an empty one and reconstructs an equivalent
// stack locally by applying the replayed log in order. See EmptyStack.
type Stack struct {
	Kind    string            `json:"kind"`
	Cursor  int               `json:"cursor"`
	Entries []json.RawMessage `json:"entries"`
}

// EmptyStack returns {"kind":"stack","cursor":0,"entries":[]}.
//
// Entries is a non-nil empty slice on purpose: a nil slice would marshal to
// `null`, but the client (and the Node reference server) expect `[]`.
func EmptyStack() Stack {
	return Stack{Kind: "stack", Cursor: 0, Entries: []json.RawMessage{}}
}

// ClientToServer is the only inbound envelope: { "type":"sync", "message":… }.
// Message stays raw so it can be appended to the log and rebroadcast verbatim.
type ClientToServer struct {
	Type    string          `json:"type"`
	Message json.RawMessage `json:"message"`
}

// InitEnvelope is the first frame a client receives:
// { "type":"init", "clientId":…, "schema":<seed>, "stack":{empty} }.
type InitEnvelope struct {
	Type     string          `json:"type"`
	ClientID string          `json:"clientId"`
	Schema   json.RawMessage `json:"schema"`
	Stack    Stack           `json:"stack"`
}

// SyncEnvelope is a relayed message:
// { "type":"sync", "from":<clientId|"history">, "message":<opaque> }.
type SyncEnvelope struct {
	Type    string          `json:"type"`
	From    string          `json:"from"`
	Message json.RawMessage `json:"message"`
}

// SnapshotResponse is the body of GET /api/sessions/{id}.
// schema is the seed; stack is always empty (the relay holds no model).
type SnapshotResponse struct {
	SessionID string          `json:"sessionId"`
	Schema    json.RawMessage `json:"schema"`
	Stack     Stack           `json:"stack"`
}

// CreateResponse is the body of POST /api/sessions.
type CreateResponse struct {
	SessionID string `json:"sessionId"`
}

// CreateRequest is the (optional) body of POST /api/sessions.
type CreateRequest struct {
	Schema json.RawMessage `json:"schema"`
}
