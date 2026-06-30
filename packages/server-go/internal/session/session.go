package session

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/wire"
)

// Session is a single collaboration room. Its state — the seed schema, the
// append-only message log, the set of connected clients, and the GC timer — is
// owned exclusively by one actor goroutine (run). Nothing else touches these
// fields, so there is no per-session mutex: all mutations are serialized through
// the inbox channel, which also makes the atomic join trivially race-free.
type Session struct {
	id   string
	hub  *Hub
	seed json.RawMessage // raw seed schema; normalized to "{}" if nil/null

	// inbox carries every event the actor processes, in arrival order. This
	// single queue is what serializes the session.
	inbox chan event

	// --- fields below are touched ONLY by the actor goroutine ---

	// log is the ordered, append-only history of every received sync message.
	// A late joiner gets the prefix that existed at its join instant replayed.
	log []json.RawMessage

	// clients is the set of currently connected clients, keyed by clientId.
	clients map[string]*Client

	// gcTimer, when non-nil, is counting down to delete this empty session.
	// Armed when the last client leaves, cancelled when someone rejoins.
	gcTimer *time.Timer

	ttl       time.Duration
	readLimit int64 // per-connection inbound frame cap, applied at Join
}

// event is the actor inbox message. Exactly one of the fields is meaningful per
// event, selected by kind. Keeping it a single struct (not an interface) avoids
// per-event allocation noise on the hot sync path.
type event struct {
	kind    eventKind
	join    *joinRequest    // join
	client  *Client         // leave
	from    string          // message: originating clientId
	message json.RawMessage // message: the opaque sync payload
}

// joinRequest carries everything the actor needs to admit a new connection and
// hand the constructed *Client back to the upgrade goroutine (via ready), which
// then starts the read/write pumps. Building the Client on the actor lets us
// size its outbound FIFO to the EXACT history length captured at join, so the
// init + replay burst can never trip the non-blocking-enqueue drop path.
type joinRequest struct {
	id    string
	conn  wsConn
	ready chan *Client
}

type eventKind int

const (
	evJoin     eventKind = iota // a new client finished its handshake; register + bootstrap
	evMessage                   // an inbound {type:"sync"} from `from`
	evLeave                     // a client's read pump exited; deregister
	evGC                        // the GC timer fired; delete if still empty
	evShutdown                  // graceful shutdown: close every client socket
)

const inboxBuffer = 256 // generous; the actor drains it fast and serially.

func newSession(id string, hub *Hub, seed json.RawMessage, ttl time.Duration, readLimit int64) *Session {
	s := &Session{
		id:        id,
		hub:       hub,
		seed:      normalizeSchema(seed),
		inbox:     make(chan event, inboxBuffer),
		clients:   make(map[string]*Client),
		ttl:       ttl,
		readLimit: readLimit,
	}
	go s.run()
	return s
}

// ID returns the session id.
func (s *Session) ID() string { return s.id }

// Seed returns the immutable seed schema (raw JSON). It is set once at creation
// and never mutated, so reading it off the actor goroutine is safe — this lets
// GET /api/sessions/{id} answer without round-tripping through the inbox.
func (s *Session) Seed() json.RawMessage { return s.seed }

// normalizeSchema turns a nil or JSON-null schema into the object literal "{}",
// matching the Node server's `schema ?? {}` and the empty-body POST behavior.
func normalizeSchema(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage("{}")
	}
	return raw
}

// run is the actor loop. It is the only goroutine that reads or writes the
// session's log/clients/gcTimer, so every handler below runs single-threaded.
func (s *Session) run() {
	for ev := range s.inbox {
		switch ev.kind {
		case evJoin:
			s.handleJoin(ev.join)
		case evMessage:
			s.handleMessage(ev.from, ev.message)
		case evLeave:
			s.handleLeave(ev.client)
		case evGC:
			s.handleGC()
		case evShutdown:
			s.handleShutdown()
		}
	}
}

// handleJoin performs the atomic join. Because the actor is single-threaded,
// snapshotting the log length, sizing the client's FIFO to it, and registering
// the client all happen with no other event interleaving. The joiner is then
// bootstrapped through its own FIFO (init first, then exactly the history that
// existed at this instant); any sync that arrives afterward is a separate
// evMessage appended after this snapshot and delivered to the joiner exactly
// once. The constructed *Client is handed back via req.ready so the upgrade
// goroutine can start the pumps.
func (s *Session) handleJoin(req *joinRequest) {
	// A rejoin cancels a pending GC of this (still-alive) session.
	s.cancelGC()

	n := len(s.log) // history length captured atomically with register below

	// Size the outbound FIFO so the synchronous init + N replay frames never
	// overflow it (which would otherwise look like a "slow client" and drop the
	// joiner). max(64, N+8) leaves headroom for live broadcasts too.
	outBuf := n + 8
	if outBuf < 64 {
		outBuf = 64
	}
	c := newClient(req.id, req.conn, outBuf)
	s.clients[c.id] = c // register (single-threaded => race-free)

	// 1) init: seed schema + an empty stack. The client rebuilds its real stack
	//    by applying the replayed log in order.
	init := wire.InitEnvelope{
		Type:     wire.TypeInit,
		ClientID: c.id,
		Schema:   s.seed,
		Stack:    wire.EmptyStack(),
	}
	if frame, err := json.Marshal(init); err == nil {
		// outBuf >= n+8, so these synchronous enqueues cannot overflow; a false
		// return here would indicate a sizing bug.
		c.enqueue(frame)
	}

	// 2) replay log[0..n) as {type:"sync", from:"history", message}.
	for i := 0; i < n; i++ {
		env := wire.SyncEnvelope{Type: wire.TypeSync, From: wire.FromHistory, Message: s.log[i]}
		if frame, err := json.Marshal(env); err == nil {
			c.enqueue(frame)
		}
	}

	log.Printf("[session %s] + client %s (now %d)", s.id, c.id, len(s.clients))

	// Hand the registered client back so the upgrade goroutine starts the pumps.
	// The init + history are already queued, so the write pump flushes them in
	// order before any live broadcast (live syncs are queued after this).
	req.ready <- c
}

// handleMessage appends the opaque payload to the log, then broadcasts it to
// every client except the sender. The broadcast frame is marshalled ONCE and
// the same []byte is handed to every recipient (frames are immutable once
// queued), which keeps a large fan-out cheap and guarantees byte-identity.
func (s *Session) handleMessage(from string, message json.RawMessage) {
	s.log = append(s.log, message)

	env := wire.SyncEnvelope{Type: wire.TypeSync, From: from, Message: message}
	frame, err := json.Marshal(env)
	if err != nil {
		return
	}
	for id, c := range s.clients {
		if id == from {
			continue // never echo a sync back to its originator
		}
		if !c.enqueue(frame) {
			// Slow/stuck client: dropping it here keeps the actor moving. Its
			// read pump will then unwind and post an evLeave to deregister it.
			c.close()
		}
	}
}

// handleLeave deregisters a client. When the room empties, it arms the GC timer
// instead of deleting immediately so a quick reconnect (very common on reload)
// keeps the session and its history alive.
func (s *Session) handleLeave(c *Client) {
	if cur, ok := s.clients[c.id]; !ok || cur != c {
		return // already gone, or replaced by a reconnect with a new *Client
	}
	delete(s.clients, c.id)
	log.Printf("[session %s] - client %s (now %d)", s.id, c.id, len(s.clients))

	if len(s.clients) == 0 {
		s.armGC()
	}
}

// handleGC deletes the session iff it is still empty. The timer only POSTS an
// evGC into the inbox; this re-check runs on the actor, so a rejoin that landed
// between the timer firing and this handler running (and which cancelled the
// timer / refilled clients) is honored — no client is ever orphaned.
func (s *Session) handleGC() {
	s.gcTimer = nil
	if len(s.clients) != 0 {
		return
	}
	if s.hub.removeIfEmpty(s.id, s) {
		log.Printf("[session %s] garbage-collected after %s idle", s.id, s.ttl)
		// Stop accepting events; run() exits when the inbox is closed.
		close(s.inbox)
	}
}

// armGC schedules a GC re-check after ttl. The timer callback merely enqueues
// evGC (a select with default so a full inbox or a shutting-down actor can't
// block the timer goroutine); the actor makes the real decision.
func (s *Session) armGC() {
	s.cancelGC()
	s.gcTimer = time.AfterFunc(s.ttl, func() {
		select {
		case s.inbox <- event{kind: evGC}:
		default:
		}
	})
}

func (s *Session) cancelGC() {
	if s.gcTimer != nil {
		s.gcTimer.Stop()
		s.gcTimer = nil
	}
}

// --- methods below are called from connection goroutines, NOT the actor ---
// They only ever send on the inbox channel (safe for concurrent senders).

// Join admits a freshly-accepted WebSocket connection: it raises the read limit
// (survey payloads dwarf the 32 KiB library default), asks the actor to register
// the client and queue its init+history atomically, then starts the read and
// write pumps and blocks until both exit (the caller runs Join in the
// connection's own goroutine, so blocking here keeps that goroutine alive for
// the lifetime of the connection). A fresh clientId (UUID v4) is assigned here.
func (s *Session) Join(ctx context.Context, conn wsConn) {
	conn.SetReadLimit(s.readLimit)

	req := &joinRequest{id: uuid.NewString(), conn: conn, ready: make(chan *Client, 1)}
	if !s.postJoin(req) {
		// Extremely narrow race: this session instance was GC'd (its inbox closed)
		// between the hub handing it to us and now. Close the socket; the client's
		// reconnect will GetOrCreate a fresh session instance.
		_ = conn.Close(websocket.StatusInternalError, "session closing")
		return
	}
	c := <-req.ready // the actor has registered the client and queued init+history

	// The write pump must run concurrently with the read pump: the read pump
	// blocks on Read for the connection's lifetime while the write pump flushes
	// the queued init+history and then live broadcasts.
	go c.writePump(ctx)
	c.readPump(ctx, s) // returns on disconnect; its defer posts the leave
}

// postJoin sends the join event to the actor, returning false if the actor's
// inbox is already closed (session GC'd mid-flight). The recover converts the
// closed-channel send panic into that false return.
func (s *Session) postJoin(req *joinRequest) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	s.inbox <- event{kind: evJoin, join: req}
	return true
}

// postMessage forwards an inbound sync to the actor.
func (s *Session) postMessage(from string, message json.RawMessage) {
	// Guard against a closed inbox (session GC'd mid-flight): a closed-channel
	// send panics, so recover and treat it as "session gone, drop the message".
	defer func() { _ = recover() }()
	s.inbox <- event{kind: evMessage, from: from, message: message}
}

// postLeave deregisters a client when its read pump exits.
func (s *Session) postLeave(c *Client) {
	defer func() { _ = recover() }()
	s.inbox <- event{kind: evLeave, client: c}
}

// shutdown asks the actor to close every client socket (graceful shutdown).
// Routing through the inbox keeps the clients-map access on the actor goroutine
// (no race with concurrent joins/leaves). Best-effort: if the inbox is already
// closed (session GC'd), the recover swallows the send panic.
func (s *Session) shutdown() {
	defer func() { _ = recover() }()
	s.inbox <- event{kind: evShutdown}
}

// handleShutdown breaks every client connection so the read pumps unblock and
// their goroutines exit. Each client's close() is idempotent. We do not delete
// the session here; the process is exiting anyway.
func (s *Session) handleShutdown() {
	for _, c := range s.clients {
		c.close()
	}
}
