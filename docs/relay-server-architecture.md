# Relay server: language-independent architecture

This document describes how to implement the collaboration backend on **any stack** (Go, .NET,
Node, anything), keeping **minimal logic on the server — just WebSocket message relaying** while
**fully preserving the current functionality**, including late-join (a newly connected participant
receives the current schema and the shared undo/redo stack).

## Why this is needed

Today the server is **not a relay**. It holds an in-memory headless `SurveyModel` +
`UndoRedoManager` and applies every message through `UndoRedoSyncPlugin.applySerialized()`
([server-nodejs/session-store.ts](../packages/server-nodejs/session-store.ts)). It does this
**only** to hand a late joiner the `schema` + `stack` in the `init` envelope. That logic depends on
the survey-core runtime (`Serializer`, `LocalizableString`, `element.delete()`, property setters)
and is therefore not portable to another language without reimplementing part of SurveyJS itself.

**Key insight:** the server-side model is not required. Any connected client is locally
authoritative and builds its own stack by applying the message stream in order. So a late joiner
only needs the **session's seed schema + a replay of the full ordered message log** — the client
reconstructs an identical state and an equivalent stack on its own.

The sync protocol is **not Yjs/CRDT and not OT** — it is a plain JSON stream of
`{kind:"transaction"|"undo"|"redo", id, ...}` messages
([packages/protocol/index.d.ts](../packages/protocol/index.d.ts),
[undo-redo-serializer.ts](../../survey-creator/packages/survey-creator-core/src/collaboration/undo-redo-serializer.ts)). Ordering
is defined by the server's receive order. Forwarding JSON in order is trivial in any language.

## Architecture: pure relay + replay log

Per session the server stores exactly:

- `seedSchema` — the initial schema (from `POST /api/sessions`, otherwise `{}`);
- `log` — an ordered, append-only array of every received `ISyncMessage`;
- the set of connected clients (`clientId -> connection`);
- a GC timer for an empty session.

**No SurveyJS, no model, no inverse computation.** The server only: receives a message → appends it
to the log → broadcasts it to the others; on a new connection → replays the log.

### Why functionality is preserved

- **Live sync** is identical to today — the server broadcasts `sync` to the others in receive order.
- **Late-join:** the joiner receives `init` with `seedSchema` and an empty stack, then the replayed
  `log` as ordinary `sync` messages. The client's `onInit` sets `creator.JSON = seedSchema` and
  `importStack(empty)`, then `onRemoteSync` applies each message via `applySerialized`
  ([CollaborativeCreator.tsx](../packages/frontend/CollaborativeCreator.tsx)). The result is the
  same state and an equivalent stack as the existing clients have.
- **Undo/redo across the late-join boundary** is reproduced exactly: replaying `undo`/`redo`
  messages moves the cursor the same way it does for live clients. Replay is even more faithful than
  the current `exportStack`, which dropped the redo tail — here it is preserved.

### What does NOT change

- **The protocol** ([packages/protocol/index.d.ts](../packages/protocol/index.d.ts)) is unchanged.
  `init` and `sync` already exist; we merely put the seed schema + an empty stack into `init` and
  then stream the history as `sync`.
- **The client** is unchanged. It already handles `init` followed by the `sync` stream. Historized
  messages are tagged `from:"history"`; the client only suppresses `from === ownClientId`, which
  never matches the history tag.

## Server contract

### State

A thread-safe map `sessionId -> { seedSchema, log[], clients{}, gcTimer }`.
Id validation: `^[A-Za-z0-9_-]{1,128}$`.

### HTTP

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/api/sessions` | body `{ schema? }` → `201 { sessionId }`. Create a session with `seedSchema = schema ?? {}`, generate a uuid. |
| GET | `/api/sessions/:id` | `200 { sessionId, schema: seedSchema, stack: {kind:"stack",cursor:0,entries:[]} }`. Create an empty session if missing. Invalid id → `400`. |
| GET | `/health` | `200 { ok: true }`. |

CORS: allow the client origin if the client is hosted separately (see below).

### WebSocket `/ws/sessions/:id`

On connect:

1. Validate the id; get-or-create the session; generate a `clientId` (uuid).
2. Send `init`: `{ type:"init", clientId, schema: seedSchema, stack: {kind:"stack",cursor:0,entries:[]} }`.
3. Replay the history: for each `m` in `log`, send `{ type:"sync", from:"history", message: m }`.
4. Register the client in `clients`.

On incoming `{ type:"sync", message }`: append `message` to `log`; broadcast to everyone **except
the sender** as `{ type:"sync", from: clientId, message }`.

On disconnect: remove from `clients`; if empty, start the GC timer (`EMPTY_SESSION_TTL_MS`, default
30 min) that deletes the session if nobody rejoined.

### Ordering and exactly-once correctness

Process a single session's events **serially** (actor / per-session mutex). Register the client and
snapshot the log length **atomically under one lock** together with `sync` handling:

- under the lock, capture `N = len(log)` and register the client;
- replay `log[0..N)` to the joiner;
- any `sync` arriving after registration is appended to the log (index ≥ N) and broadcast to the
  joiner exactly once — it is not part of the snapshot.

Send outbound messages to a single client through a FIFO queue so the replay does not interleave
with live messages. This guarantees exactly-once delivery and correct order (a duplicate
`transaction` with the same `id` would merge into the current transaction and corrupt state — hence
exactly-once is mandatory).

### Serving the client

A language-independent server does not host Vite. The client is built/served separately. Since
`buildWsUrl` derives from `window.location.host`, when the client and server live on different
origins you must either proxy `/ws` and `/api` to the server, or make the WS/API base URL
configurable on the client and enable CORS on the server.

## Repository changes

- The **new server** (any stack) implements the contract above — it replaces
  [server-nodejs](../packages/server-nodejs) or lives alongside it.
- The server drops the `survey-core` and `survey-creator-core` (which now bundles the undo/redo
  sync plugin) dependencies and the `slk(...)` license call.
- [packages/protocol](../packages/protocol) and the client package are **unchanged**.

## Trade-off and optional optimization

The `log` grows with the number of edits (per-session memory is unbounded; sessions are ephemeral
and GC'd by TTL — as today, everything is lost on restart). If a memory bound or faster late-join is
needed, add **compaction via a client-pushed snapshot**: a new `{ type:"snapshot", schema, stack,
uptoSeq }` envelope (client→server); the client debounces and sends `creator.JSON` +
`plugin.exportStack()`; the server keeps the latest snapshot and trims the log prefix. The server
**still stays SurveyJS-free** — the snapshot is an opaque blob to it. This is the only change that
requires extending the protocol and a little client logic; it is not part of the baseline.

## Verification

1. Run the new server + the current client (proxying `/ws` and `/api`). Open a session in two tabs —
   edits in one appear in the other.
2. Late-join: make a series of edits, open a third tab — current schema **and** working undo/redo
   (undo reverts a peer's edit, redo restores it; the redo tail is available).
3. Undo/redo from any tab is reflected in all.
4. Localizable fields (title/description per locale), arrays (add/delete elements), paneldynamic
   templates, and the Logic and Translation tabs — correctness after late-join.
5. Run the protocol integration tests
   ([undo-redo-sync.test.ts](../../survey-creator/packages/survey-creator-core/tests/collaboration/undo-redo-sync.test.ts)) — the
   message format is unchanged.
6. Ordering stress test: fast typing (merge transactions) from two tabs + a simultaneous late-join —
   no duplicates, state converges.
