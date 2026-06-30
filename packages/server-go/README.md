# server-go — Go relay for SurveyJS collaboration

A thin, **byte-compatible** WebSocket relay for the collaboration client. It is a
drop-in alternative to the Node reference server (`server-nodejs/`) and holds **no
SurveyJS** model. Per session it keeps only:

- `seedSchema` — raw JSON from `POST /api/sessions` (or `{}`);
- `log` — an append-only list of every received sync message (opaque blobs);
- the connected clients;
- a GC timer for empty sessions.

A late joiner gets `init` (seed schema + an **empty** stack) followed by a replay
of the log as ordinary `sync` messages, and reconstructs an equivalent state and
undo/redo stack locally. The relay never parses or rewrites the sync payload —
it is forwarded byte-for-byte (`json.RawMessage`), which is essential: reformatting
numbers or reordering keys would corrupt transaction ids/values and break undo/redo.

See [`../../docs/relay-server-architecture.md`](../../docs/relay-server-architecture.md)
for the authoritative protocol description.

## Build & run

Requires Go 1.22+ (developed/tested on 1.24).

```sh
cd packages/server-go
go mod tidy
go build ./...
go vet ./...

# run (defaults: HOST=localhost PORT=8080)
go run ./cmd/relay
# or build a binary
go build -o relay ./cmd/relay && ./relay
```

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `HOST` | `localhost` | Bind host. |
| `PORT` | `8080` | Bind port. |
| `EMPTY_SESSION_TTL_MS` | `1800000` (30 min) | How long an empty session lingers before GC. |
| `CLIENT_DIST` | `../../dist/client` | Path to the built SPA (resolved to absolute). If `<CLIENT_DIST>/index.html` is missing, the server runs API/WS-only. |
| `READ_LIMIT_BYTES` | `8388608` (8 MiB) | Per-connection inbound frame cap (the WS library default of 32 KiB is far too small for survey payloads). |
| `ALLOW_ANY_ORIGIN` | `true` | Skip the WebSocket same-origin check on Accept. The SPA is same-origin and the API returns `Access-Control-Allow-Origin: *`; set `false` to enforce same-origin. |

## HTTP / WS surface

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/sessions` | Body `{schema?}` → `201 {"sessionId":"<uuid>"}`. Empty/blank body ⇒ seed `{}`; only malformed JSON ⇒ `400 {"error":…}`. |
| `GET` | `/api/sessions/{id}` | `200 {"sessionId","schema":<seed>,"stack":{"kind":"stack","cursor":0,"entries":[]}}`. Auto-creates if missing; invalid id ⇒ `400 {"error":"invalid session id"}`. |
| `GET` | `/health` | `200 {"ok":true}`. |
| `OPTIONS` | `*` | `204` with CORS headers (`Access-Control-Allow-Origin: *`, methods `GET, POST, OPTIONS`, headers `Content-Type`). |
| `GET` | `/ws/sessions/{id}` | WebSocket upgrade. Invalid id ⇒ `400` **before** the upgrade. |
| `GET` | `/*` | Serves the SPA (with path-traversal guard + SPA fallback) or `404 {"error":"not found"}`. |

Session id must match `^[A-Za-z0-9_-]{1,128}$`. `clientId` is a UUID v4.

### Wire envelopes (case-sensitive)

```jsonc
// client -> server
{ "type":"sync", "message": <opaque> }

// server -> client (first frame)
{ "type":"init", "clientId":"<uuid>", "schema": <seed>,
  "stack": {"kind":"stack","cursor":0,"entries":[]} }

// server -> client (relayed; from is a clientId, or "history" during replay)
{ "type":"sync", "from":"<clientId|history>", "message": <opaque> }
```

A `sync` is never echoed back to its sender.

## Pointing the existing client / Playwright e2e at it

The client derives its WS/API base from `window.location.host`, so the simplest
setup is to serve the built client from this server (same origin):

```sh
# from the repo root, build the SPA
npm run build:client            # produces dist/client

# run the Go relay; it auto-serves ../../dist/client
cd packages/server-go && go run ./cmd/relay
# open http://localhost:8080
```

If you host the client elsewhere (e.g. Vite dev server on another port), either
proxy `/ws` and `/api` to this server, or point the client's WS/API base at it
(CORS is already `*`). For the Playwright e2e suite, set the base URL to this
server's `http://localhost:<PORT>` (or run it behind the same proxy the Node
server used) — the wire protocol is identical, so no test changes are needed.

## Architecture (concurrency)

- **Hub** — a `sync.Mutex`-guarded `sessionId → *Session` map (get-or-create / GC).
- **Session actor** — one goroutine per session owns `log`/`clients`/`gcTimer`
  (no per-session mutex). All mutations flow through a single inbox channel, so
  the join is atomic: it captures `N = len(log)` and registers the client in one
  serial step. The GC timer only *posts* an event; the actor re-checks
  `len(clients)==0` before deleting (race-free), and a rejoin cancels the timer.
- **Connection** — one read pump + one write pump per socket. The write pump is
  the **only** writer; it drains a buffered per-client FIFO (sized `max(64, N+8)`
  at join so init+replay never overflows). Backpressure is non-blocking: a full
  queue ⇒ the slow client is closed rather than stalling the actor.
- **Shutdown** — on SIGINT/SIGTERM the root request context is cancelled and
  every WS socket is closed explicitly (since `http.Server.Shutdown` leaves
  hijacked connections open), then in-flight HTTP requests are drained.
