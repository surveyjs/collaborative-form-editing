package session

import (
	"encoding/json"
	"sync"
	"time"
)

// Hub owns the sessionId -> *Session map. This is the one place a sync.Mutex is
// used: the map is touched by many connection goroutines (get-or-create on
// connect) and by actors (delete on GC), so it needs locking. Per-session state
// is NOT under this lock — each session is single-threaded via its own actor.
type Hub struct {
	mu        sync.Mutex
	sessions  map[string]*Session
	ttl       time.Duration
	readLimit int64
}

// NewHub creates an empty hub. ttl is the empty-session GC delay and readLimit
// the per-connection inbound frame cap; both are passed to every session the
// hub creates.
func NewHub(ttl time.Duration, readLimit int64) *Hub {
	return &Hub{
		sessions:  make(map[string]*Session),
		ttl:       ttl,
		readLimit: readLimit,
	}
}

// GetOrCreate returns the existing session for id, or creates an empty one
// (seed "{}") if none exists. Used by GET /api/sessions/{id} and WS connect so
// any freshly-typed session URL just works.
func (h *Hub) GetOrCreate(id string) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.sessions[id]; ok {
		return s
	}
	s := newSession(id, h, nil, h.ttl, h.readLimit) // nil seed -> normalized to "{}"
	h.sessions[id] = s
	return s
}

// Create makes a brand-new session with an explicit (possibly nil) seed schema,
// used by POST /api/sessions. The id is caller-supplied (a fresh UUID).
func (h *Hub) Create(id string, seed json.RawMessage) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := newSession(id, h, seed, h.ttl, h.readLimit)
	h.sessions[id] = s
	return s
}

// removeIfEmpty deletes the session for id only if the map still holds *this*
// exact instance. The identity check defends against a rare interleaving where
// the session was GC'd and a new one with the same id was created before the
// stale GC handler ran; we must not delete the replacement. Returns true if the
// instance was removed.
func (h *Hub) removeIfEmpty(id string, s *Session) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur, ok := h.sessions[id]; ok && cur == s {
		delete(h.sessions, id)
		return true
	}
	return false
}

// CloseAll breaks every connection across every session, used during graceful
// shutdown. http.Server.Shutdown does not close hijacked WebSocket connections,
// so we must close them ourselves to unblock the read pumps and let goroutines
// exit. It routes through each session's actor so it doesn't race the actor's
// own access to its clients map.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	snapshot := make([]*Session, 0, len(h.sessions))
	for _, s := range h.sessions {
		snapshot = append(snapshot, s)
	}
	h.mu.Unlock()

	for _, s := range snapshot {
		s.shutdown()
	}
}
