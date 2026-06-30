# Collaborative Form Editing by SurveyJS

A real-time collaborative survey editing system built with [Survey Creator by SurveyJS](https://surveyjs.io/survey-creator/documentation/overview). Multiple users can edit the same survey or form simultaneously, similar to Google Docs for document editing.

- **Frontend** &ndash; React + SurveyJS Creator (`survey-core`, `survey-creator-core`, `survey-creator-react`)
- **Backend** &ndash; three interchangeable WebSocket servers behind one shared frontend &mdash; Node.js (`packages/server-nodejs/`), Go (`packages/server-go/`), .NET (`packages/server-net/`)
- **Storage** &ndash; In-memory sessions (MVP, no persistence or auth)

## How It Works

- Users join or create a session via a session ID.
- Each session stores a Survey Creator model on the server in memory.
- Every edit in the creator is captured as a serialized change message.
- Changes are sent to the server over WebSocket and broadcast to other clients.
- Receiving clients apply updates to their local Survey Creator instance.
- Temporary suppression of local change listeners prevents update loops.
- Ordering is server-driven (last-write-wins at message level).

## Server Variants

The repo ships **three interchangeable servers** that speak the **same wire protocol**, so the single `packages/frontend/` client works against any of them (it derives the WebSocket URL from the page origin):

- **`packages/server-nodejs/`** &mdash; the reference server. Holds a headless SurveyJS model per session and feeds late joiners a computed schema + undo/redo stack.
- **`packages/server-go/`** (Go) and **`packages/server-net/`** (.NET) &mdash; thin **relays** with no SurveyJS dependency. They store the session's seed schema and an ordered log of messages; a late joiner receives the seed plus a replay of the log and reconstructs an equivalent state and undo/redo stack locally. See [docs/relay-server-architecture.md](docs/relay-server-architecture.md).

Build the client once (`npm run build:client`), then launch any server on [`http://localhost:8080`](http://localhost:8080):

| Command | Server |
| --- | --- |
| `npm run dev` | Node.js (live Vite HMR, no prebuild needed) |
| `npm run go` | Go relay (serves the built `dist/client`) |
| `npm run net` | .NET relay (requires the .NET 8 SDK; serves the built `dist/client`) |

Each serves the same client + `/api` + `/ws` on one port. Per-server details are in each folder's `README.md`.

## Server Setup

- The Node server serves the API and WebSocket endpoint (raw `http` + `ws`, no framework).
- In development, the client is served via Vite middleware on the same port.
- In production, static assets are served from the built client bundle.

## How Sync Works

- The client listens to `creator.undoRedoController.undoRedoManager.onSerializedChanges`.
- Each change (property update, array mutation, undo, redo) is serialized into an `ISyncMessage` and sent to the server.
- The server applies the message to the session's in-memory `SurveyModel`, ensuring new clients receive the latest state.
- The server then broadcasts the message to all other clients in the same session.
- Each client applies incoming messages via `manager.applySerialized(message)`.
- During application, local change listeners are temporarily disabled to prevent echoing remote updates back to the server.

## Running

```bash
npm install
npm run dev
```

The application is available at [`http://localhost:8080`](http://localhost:8080). The server hosts the React client through embedded Vite middleware on the same port.

Open the app to create a session, then copy the invite link to collaborate in another tab.

A session ID can also be supplied directly in the URL path (`/<sessionId>`)&mdash;the client will join that session instead of creating a new one.

## Environment Variables

| Variable | Default | Description  |
| ---- | ---- | --- |
| `PORT` | `8080` | HTTP + WebSocket port |
| `NODE_ENV` | `development` | Enables production mode when set to `production` (disables Vite middleware) |
| `CLIENT_DIST` | `dist/client` | Directory containing the production client build |
| `EMPTY_SESSION_TTL_MS` | `1800000` (30 min) | Time before an empty session is garbage-collected |

## Production

```bash
npm run build
npm start
```

`npm run build` compiles the server and builds the client application. `npm start` serves the production build on [`http://localhost:8080`](http://localhost:8080).

In production mode the server serves the static client bundle from `dist/client` (override with `CLIENT_DIST`) and does not load Vite.

## API

| Method | Path | Description           |
| ------ | - | --- |
| POST   | `/api/sessions`     | Create a session      |
| GET    | `/api/sessions/:id` | Fetch session state   |
| GET    | `/health`           | Health check          |
| WS     | `/ws/sessions/:id`  | Collaboration channel |

## Project Structure

One shared frontend, three interchangeable servers:

```
packages/
  frontend/      Shared React + SurveyJS Creator client (works with any server)
  server-nodejs/ Node.js reference server (runs SurveyJS server-side)
  server-go/     Go relay server (no SurveyJS)
  server-net/    .NET relay server (no SurveyJS)
docs/            Architecture notes
e2e/             Playwright tests
```

- [`packages/frontend/CollaborativeCreator.tsx`](packages/frontend/CollaborativeCreator.tsx) &mdash; Survey Creator embedding and session handling
- [`packages/frontend/collab-client.ts`](packages/frontend/collab-client.ts) &mdash; Client-side sync logic
- [`packages/server-nodejs/index.ts`](packages/server-nodejs/index.ts) &mdash; HTTP + WebSocket server
- [`packages/server-nodejs/session-store.ts`](packages/server-nodejs/session-store.ts) &mdash; In-memory session state and sync application
- [`packages/server-go/`](packages/server-go/) and [`packages/server-net/`](packages/server-net/) &mdash; relay servers (see each folder's `README.md`)

The shared wire-protocol types (`ISyncMessage`, `IClientToServer`, `IServerToClient`, …) are imported from `survey-creator-core`.

## Limitations

- In-memory sessions only
- No authentication
- No persistence
- No presence or cursor tracking

<!-- ## License -->

## Related Resources

- [Collaborative Form Filling by SurveyJS](https://github.com/surveyjs/collaborative-form-filling)
- [SurveyJS Website](https://surveyjs.io/)
- [SurveyJS Documentation](https://surveyjs.io/documentation)
- [SurveyJS Creator Demos](https://surveyjs.io/survey-creator/examples/overview)
- [What's New in SurveyJS](https://surveyjs.io/WhatsNew)
