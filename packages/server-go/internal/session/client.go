package session

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/coder/websocket"

	"github.com/devsoftbaltic/survey-creator-collaboration/packages/server-go/internal/wire"
)

// wsConn is the slice of *websocket.Conn the session layer depends on. Keeping
// it an interface decouples the actor from the concrete library type and lets
// tests drive the pumps with a fake connection.
type wsConn interface {
	Write(ctx context.Context, typ websocket.MessageType, p []byte) error
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Close(code websocket.StatusCode, reason string) error
	SetReadLimit(n int64)
}

// Client is one WebSocket connection participating in a session.
//
// Concurrency model: exactly one goroutine ever writes to the socket — the
// write pump, which drains `out`. `out` is the per-client FIFO queue, so a
// late joiner's init + history replay can never interleave with live syncs
// destined for the same client, and ordering is preserved end to end.
type Client struct {
	id   string
	conn wsConn

	// out is the buffered outbound frame queue. Each element is an already
	// JSON-marshalled frame (marshalled once and shared across recipients for
	// live broadcasts). The write pump is its only consumer.
	out chan []byte

	// closeOnce guards both closing `out` and closing the socket so the read
	// pump, the write pump, and the actor can all request a close without
	// double-closing a channel or racing on the connection.
	closeOnce sync.Once
}

// newClient creates a client with an outbound queue sized for its workload.
//
// outBuf must be >= the number of frames the actor enqueues synchronously at
// join time (1 init + N history). The hub sizes it max(64, N+8) so a legitimate
// replay never trips the non-blocking enqueue's drop path; 64 is comfortable
// headroom for live broadcasts on a slow-but-not-dead client.
func newClient(id string, conn wsConn, outBuf int) *Client {
	return &Client{
		id:   id,
		conn: conn,
		out:  make(chan []byte, outBuf),
	}
}

// enqueue offers a pre-marshalled frame to the client without blocking.
//
// Returns false if the queue is full, which means the client cannot keep up.
// The caller (the actor) treats a false return as "drop this slow client":
// blocking here would stall the single-threaded actor and freeze the whole
// session, so backpressure is resolved by disconnecting the laggard instead.
func (c *Client) enqueue(frame []byte) bool {
	select {
	case c.out <- frame:
		return true
	default:
		return false
	}
}

// close shuts the client down exactly once: it closes the outbound queue (so
// the write pump's range loop ends) and closes the socket (so the read pump's
// blocking Read returns and that goroutine exits). Safe to call from any
// goroutine and any number of times.
func (c *Client) close() {
	c.closeOnce.Do(func() {
		close(c.out)
		// 1000 = normal closure. Ignore the error: the peer may already be gone.
		_ = c.conn.Close(websocket.StatusNormalClosure, "")
	})
}

// writePump is the sole writer to the socket. It drains `out` in FIFO order
// until the channel is closed (by close()), then returns. Any write error
// tears the client down so the read pump also unwinds and the actor is told to
// drop it via the read pump's deferred leave.
func (c *Client) writePump(ctx context.Context) {
	for frame := range c.out {
		if err := c.conn.Write(ctx, websocket.MessageText, frame); err != nil {
			// The socket is broken. Close everything; the read pump's deferred
			// leave will inform the actor. Drain remaining queued frames so the
			// range loop can finish promptly.
			c.close()
			for range c.out {
			}
			return
		}
	}
}

// readPump is the sole reader of the socket. It decodes each inbound frame as a
// client->server envelope and forwards valid syncs to the session actor. It
// runs until the peer disconnects or any error occurs, then closes the client
// and reports the leave to the actor so the client is deregistered exactly once.
//
// Malformed frames and non-sync / empty-message envelopes are ignored (not
// fatal), mirroring the Node server which simply drops anything it can't parse.
func (c *Client) readPump(ctx context.Context, s *Session) {
	defer func() {
		c.close()
		s.postLeave(c)
	}()

	for {
		typ, data, err := c.conn.Read(ctx)
		if err != nil {
			return // peer gone or read error -> unwind
		}
		if typ != websocket.MessageText {
			continue // protocol is UTF-8 text JSON; ignore binary frames
		}

		var env wire.ClientToServer
		if err := json.Unmarshal(data, &env); err != nil {
			continue // malformed JSON -> drop, keep the connection alive
		}
		if env.Type != wire.TypeSync || len(env.Message) == 0 {
			continue // only {type:"sync", message:…} is actionable
		}
		s.postMessage(c.id, env.Message)
	}
}
