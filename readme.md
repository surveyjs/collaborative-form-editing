# survey-creator-collaboration

Collaborative editing service for [SurveyJS Creator](../survey-creator).

A small Node.js HTTP + WebSocket server and a React client that embeds
SurveyJS Creator and synchronises every edit between all connected clients
by relaying the JSON sync messages produced by the creator's
`UndoRedoManager` (`onSerializedChanges` / `applySerialized`).

## Layout

```
protocol/
  index.d.ts        wire-protocol envelope types shared by client & server
                    (imported as the `@collab/shared` alias)
packages/
  server/           Node.js HTTP + WebSocket server
                    (owns one SurveyModel per session; in dev also hosts
                    the client via Vite middleware on the same port)
  client/           React app embedding survey-creator-react
```

There is no separate `shared` package — the protocol types live in
`protocol/index.d.ts` and are wired in via path aliases (Vite alias in the
client, TS path mapping in the server's `tsconfig.json`).

## Prerequisites

The workspace consumes `survey-core` and `survey-creator-core` /
`survey-creator-react` via local `file:` references in the root
`package.json`, pointing at sibling checkouts:

```
../survey-library/packages/survey-core/build
../survey-creator/packages/survey-creator-core/build
../survey-creator/packages/survey-creator-react/build
```

Those packages must be built first (`npm run build` in each repo) before
`npm install` here will succeed.

## Quick start

```bash
npm install
npm run dev
```

The server listens on `http://localhost:8080` and, in dev mode, hosts the
React client through embedded Vite middleware on the same port. Open
`http://localhost:8080/` in your browser:

1. The first tab auto-creates a new session and is redirected to
   `http://localhost:8080/<sessionId>`.
2. Click **Copy invite link** in the top bar and open it in another tab
   (or share it). Both clients now edit the same survey live.

A session id can also be supplied directly in the URL path
(`/<sessionId>`) — the client will join that session instead of creating
a new one.

## Production build

```bash
npm run build    # builds the server (tsc) and the client (vite build)
npm run start    # builds, then runs the compiled server on $PORT (8080)
```

In production mode the server serves the static client bundle from
`packages/client/dist` (override with `CLIENT_DIST`) and does not load
Vite.

## Environment variables

| Variable                | Default                | Description                                            |
| ----------------------- | ---------------------- | ------------------------------------------------------ |
| `PORT`                  | `8080`                 | HTTP + WebSocket port.                                 |
| `NODE_ENV`              | `development`          | `production` disables the Vite dev middleware.         |
| `CLIENT_DIST`           | `packages/client/dist` | Static assets directory served in production.          |
| `EMPTY_SESSION_TTL_MS`  | `1800000` (30 min)     | How long an empty session lingers before GC.           |

## HTTP / WebSocket API

| Method | Path                       | Description                                                       |
| ------ | -------------------------- | ----------------------------------------------------------------- |
| POST   | `/api/sessions`            | Create a session. Body: `{ schema?: any }` → `{ sessionId }`.     |
| GET    | `/api/sessions/:id`        | Returns `{ sessionId, schema }` for an existing session.          |
| GET    | `/health`                  | Liveness check: `{ ok: true }`.                                   |
| WS     | `/ws/sessions/:id`         | Join a session. Frames are JSON envelopes (see `protocol/`).      |

## How sync works

* The client subscribes to
  `creator.undoRedoController.undoRedoManager.onSerializedChanges`.
  Every transaction (each property change, array splice, undo, redo)
  becomes one JSON `ISyncMessage` that is sent to the server.
* The server applies the message to its in-memory `SurveyModel` for the
  session (so late joiners get the up-to-date schema) and relays it to
  all other clients in the session.
* Each receiving client passes the message into
  `manager.applySerialized(message)`, which mutates the creator's
  `SurveyModel` while temporarily detaching the local change observer —
  so remote ops do not echo back.

## Limitations

MVP only: in-memory sessions, no authentication, no persistence, no
presence/cursors, no conflict resolution beyond last-write-wins ordering
imposed by the server's relay.
