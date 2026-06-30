# CollabRelay — .NET 8 WebSocket relay for SurveyJS collaboration

A thin, **byte-compatible** WebSocket relay that mirrors the Node reference
server (`../server-nodejs/index.ts`) on the wire. It is a pure message relay: it
holds **no SurveyJS model**, applies no transactions, and computes no undo/redo
stack. Per session it keeps only a seed schema, an append-only log of every
received `sync` message, the connected clients, and a GC timer. A late joiner
gets the seed schema + an empty stack, then a verbatim replay of the log; the
client reconstructs an equivalent state and stack locally.

It uses **raw `System.Net.WebSockets`** via ASP.NET Core
(`HttpContext.WebSockets.AcceptWebSocketAsync`). It deliberately does **not** use
SignalR — SignalR's framing/handshake is incompatible with the browser's raw
`new WebSocket(...)` client this relay must serve.

---

## ⚠️ Requires the .NET 8 SDK — and it was NOT built here

This project **requires the .NET 8 SDK** (`dotnet` CLI, SDK 8.0.x) to build and
run. **The machine these sources were authored on does not have the .NET SDK
installed**, so the code has **not been compiled or executed**. It was written
to be complete and correct by inspection against the relay contract and the Node
reference server, but you must build and smoke-test it yourself before relying on
it.

Install the SDK from <https://dotnet.microsoft.com/download/dotnet/8.0>, then:

```bash
dotnet --version    # expect 8.0.x
```

---

## Build & run

From this `server-net/` directory:

```bash
# Restore + build (no external NuGet packages; uses only the shared framework)
dotnet build

# Run (defaults: http://localhost:8080)
dotnet run

# Run a Release build
dotnet run -c Release
```

Self-contained / framework-dependent publish:

```bash
# Framework-dependent (smallest; needs the .NET 8 runtime on the host)
dotnet publish -c Release -o ./publish
./publish/CollabRelay            # or: dotnet ./publish/CollabRelay.dll

# Self-contained single file for Windows x64 (no runtime needed on the host)
dotnet publish -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -o ./publish-win
# Linux: -r linux-x64 ; macOS arm64: -r osx-arm64
```

---

## Configuration (environment variables)

All knobs mirror the Node server, plus a `SERVE_CLIENT` switch. Bad numeric /
boolean values fall back to the default (the server always starts).

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `localhost` | Bind host. |
| `PORT` | `8080` | Bind port. |
| `EMPTY_SESSION_TTL_MS` | `1800000` (30 min) | How long an empty session lingers before GC. |
| `SERVE_CLIENT` | `false` | When `true`, serve the built SPA from `CLIENT_DIST`. Off = pure API/WS relay. |
| `CLIENT_DIST` | `../../dist/client` | Path to the built client (`npm run build:client` from the repo root). Resolved to an absolute path. Only used when `SERVE_CLIENT=true`. |

`SERVE_CLIENT` accepts `true/false`, `1/0`, `yes/no`, `on/off`.

Examples:

```bash
# Pure API/WS relay on all interfaces, port 9000, 5-minute empty-session TTL
HOST=0.0.0.0 PORT=9000 EMPTY_SESSION_TTL_MS=300000 dotnet run

# Also serve the prebuilt SPA (single-origin, like `npm run start`)
# First build the client at the repo root: npm run build:client
SERVE_CLIENT=true CLIENT_DIST=../../dist/client PORT=8080 dotnet run
```

PowerShell (Windows) equivalent of setting env vars inline:

```powershell
$env:SERVE_CLIENT="true"; $env:PORT="8080"; dotnet run
```

---

## Wire contract (what this relay guarantees)

### HTTP

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/sessions` | Body `{ schema? }` → `201 { "sessionId": "<uuid>" }`. Seed = `schema ?? {}`. Empty/blank body → `{}`. Malformed JSON → `400 { "error": ... }`. |
| `GET` | `/api/sessions/{id}` | `200 { "sessionId", "schema": <seed>, "stack": {"kind":"stack","cursor":0,"entries":[]} }`. Auto-creates if missing. Invalid id → `400 { "error":"invalid session id" }`. |
| `GET` | `/health` | `200 { "ok": true }`. |
| `OPTIONS` | any | CORS preflight (handled by the CORS middleware). |

CORS: `Access-Control-Allow-Origin: *` (any origin/method/header).

Session id must match `^[A-Za-z0-9_-]{1,128}$`.

### WebSocket `/ws/sessions/{id}`

- Not a WebSocket upgrade **or** invalid id → `400` set **before** accepting the
  socket (no handshake happens).
- Otherwise: auto-create the session, generate a `clientId` (UUID), accept, then
  **atomically** (inside the per-session actor) snapshot the log length and
  register the client → send `init` → replay each logged message as
  `{"type":"sync","from":"history","message":<verbatim>}`.
- Inbound `{"type":"sync","message":<opaque>}` → append the message to the log →
  broadcast `{"type":"sync","from":"<clientId>","message":<verbatim>}` to every
  client **except the sender**.
- On disconnect/error → remove the client; if the session is now empty, arm the
  GC timer (`EMPTY_SESSION_TTL_MS`) that deletes it only if still empty when it
  fires.

Envelopes (exact, case-sensitive field names):

```jsonc
// client -> server
{ "type": "sync", "message": <opaque> }

// server -> client (first frame)
{ "type": "init", "clientId": "<uuid>", "schema": <seed>,
  "stack": { "kind": "stack", "cursor": 0, "entries": [] } }

// server -> client (relayed sync; from is a clientId, or "history" on replay)
{ "type": "sync", "from": "<clientId|history>", "message": <opaque> }
```

The `message` and the seed `schema` are relayed **verbatim** (never round-tripped
through a typed model), so transaction ids/values are preserved byte-for-byte.

---

## curl smoke tests

With the server running on `http://localhost:8080`:

```bash
# Health
curl -i http://localhost:8080/health
# -> 200  {"ok":true}

# Create a session with a seed schema (note the verbatim schema round-trips)
curl -i -X POST http://localhost:8080/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"schema":{"title":"Hi","pages":[]}}'
# -> 201  {"sessionId":"<uuid>"}

# Create with empty body -> seed {}
curl -i -X POST http://localhost:8080/api/sessions
# -> 201  {"sessionId":"<uuid>"}

# Malformed JSON -> 400
curl -i -X POST http://localhost:8080/api/sessions \
  -H 'Content-Type: application/json' -d '{ not json'
# -> 400  {"error":"..."}

# Get / auto-create a custom session id
curl -i http://localhost:8080/api/sessions/my-survey
# -> 200  {"sessionId":"my-survey","schema":{},"stack":{"kind":"stack","cursor":0,"entries":[]}}

# Invalid id -> 400 (before any session is created)
curl -i 'http://localhost:8080/api/sessions/has%20space'
# -> 400  {"error":"invalid session id"}

# CORS preflight
curl -i -X OPTIONS http://localhost:8080/api/sessions \
  -H 'Origin: http://example.com' \
  -H 'Access-Control-Request-Method: POST'
# -> 204 with Access-Control-Allow-Origin: *
```

WebSocket smoke test (needs a WS client; `websocat` shown):

```bash
# Connect two clients to the same session in two terminals and type a JSON
# sync frame in one — it should appear in the other (but not echo to the sender).
websocat ws://localhost:8080/ws/sessions/my-survey
# On connect you receive: {"type":"init","clientId":"...","schema":{},"stack":{...}}
# Then paste:            {"type":"sync","message":{"kind":"transaction","id":"t1"}}
# The OTHER client receives: {"type":"sync","from":"<clientId>","message":{"kind":"transaction","id":"t1"}}
```

---

## Pointing the existing client / Playwright e2e at this relay

The browser client derives its WS/API base from `window.location.host`
(`buildWsUrl` in `../frontend/CollaborativeCreator.tsx`), so the simplest setup
is **single-origin**: serve the built client from this relay.

1. Build the client at the repo root:

   ```bash
   cd ../..              # repo root: survey-creator-collaboration
   npm install
   npm run build:client     # outputs dist/client (the CLIENT_DIST default)
   ```

2. Run the relay with the client on `:8080`:

   ```bash
   cd packages/server-net
   SERVE_CLIENT=true PORT=8080 dotnet run
   ```

3. Open `http://localhost:8080/<sessionId>` in two tabs — edits in one appear in
   the other; open a third tab for a late-join check (current schema + working
   undo/redo, including the redo tail).

### Playwright e2e

The existing Playwright config (`../../playwright.config.ts`) expects the app on
`http://localhost:8080` and boots it via `npm run dev` (the Node server). To run
the **same** e2e suite against this .NET relay instead:

- Start this relay with the built client on `:8080`:
  `SERVE_CLIENT=true PORT=8080 dotnet run` (run `npm run build:client` first).
- Run the tests pointed at the already-running server. Either temporarily set the
  Playwright `webServer.reuseExistingServer` to `true` (it already is when `CI` is
  unset) and ensure the relay is up before launching, or remove/override the
  `webServer` block so Playwright does not try to start `npm run dev`:

  ```bash
  cd ../..
  npx playwright test           # reuses the server already listening on :8080
  ```

  The e2e helpers detect readiness at the protocol level (the `init` WS frame, see
  `../../e2e/utils.ts`), which this relay sends immediately on connect — so the
  suite works unchanged as long as `:8080` is this relay serving the client.

> Note: if the client and relay are on **different** origins, you must either
> proxy `/ws` and `/api` to the relay, or make the client's WS/API base URL
> configurable. CORS is already enabled here (`*`), which covers the HTTP API;
> the WS path has no Origin restriction.

---

## Source layout

```
server-net/
  CollabRelay.csproj          net8.0, Microsoft.NET.Sdk.Web, no external NuGet
  Program.cs                  host wiring: UseUrls, CORS, WebSockets, endpoints,
                              /ws branch (400-before-accept), optional static, RunAsync
  Config/ServerOptions.cs     env loading (PORT/HOST/EMPTY_SESSION_TTL_MS/SERVE_CLIENT/CLIENT_DIST)
  Relay/JsonOptions.cs        shared JsonSerializerOptions (no camelCase, relaxed escaping)
  Relay/SessionId.cs          source-generated [GeneratedRegex] id validation
  Relay/WireEnvelopes.cs      DTOs ([JsonPropertyName]), StackDto.Empty, frame builders
                              (Utf8JsonWriter verbatim passthrough), InboundFrame.TryParseSync
  Relay/SessionEvent.cs       Join / Sync / Leave / GcFire actor events
  Relay/Session.cs            the per-session ACTOR: single drain loop, log, clients, GC
  Relay/SessionManager.cs     ConcurrentDictionary; Create / GetOrCreate / remove-if-still-this
  Relay/ClientConnection.cs   bounded outbound Channel + single FIFO writer task,
                              multi-frame receive loop, close handshake
  Http/SessionEndpoints.cs    POST/GET/health handlers
```

## Concurrency model (why it's correct)

- **Per session = one actor.** An unbounded `Channel<SessionEvent>` drained by a
  single long-running task. All mutation of `log`/`clients` happens there, serially.
  "Snapshot the log length **and** register the client" is therefore atomic — it
  is one `Join` event handled in one uninterrupted step, so no `Sync` can slip
  between the snapshot and the registration. A `Sync` arriving after a join is
  appended (index ≥ N) and delivered live exactly once.
- **Per connection = one FIFO writer.** A bounded `Channel<ReadOnlyMemory<byte>>`
  (capacity 1024) drained by a single writer task — the only code that writes the
  socket. Replay never interleaves with live syncs. The actor only `TryWrite`s
  and never awaits a socket. If a slow client fills its queue, the actor completes
  that channel with an exception (drops the client) instead of blocking.
- **Multi-frame receive.** The receive loop accumulates partial frames until
  `EndOfMessage` before parsing, so large schemas/messages that span frames are
  reassembled.
- **GC via the actor.** `Task.Delay(ttl)` (cancellable) posts a `GcFire` event; the
  handler deletes the session only if it is still empty (with a generation guard so
  a stale timer from a previous empty period cannot delete a rejoined session).
- **Graceful shutdown.** Each connection's token is linked to
  `ApplicationStopping`, so shutdown cancels every receive/send loop;
  `await app.RunAsync()` plus the host's shutdown timeout drains in-flight work.
```
