# Collaborative Form Editing by SurveyJS

A real-time collaborative survey editing system built with [Survey Creator by SurveyJS](https://surveyjs.io/survey-creator/documentation/overview). Multiple users can edit the same survey or form simultaneously, similar to Google Docs for document editing.

- **Frontend** &ndash; React + SurveyJS Creator (`survey-core`, `survey-creator-core`, `survey-creator-react`)
- **Backend** &ndash; Node.js + Express + WebSocket
- **Storage** &ndash; In-memory sessions (MVP, no persistence or auth)

## How It Works

- Users join or create a session via a session ID.
- Each session stores a Survey Creator model on the server in memory.
- Every edit in the creator is captured as a serialized change message.
- Changes are sent to the server over WebSocket and broadcast to other clients.
- Receiving clients apply updates to their local Survey Creator instance.
- Temporary suppression of local change listeners prevents update loops.
- Ordering is server-driven (last-write-wins at message level).

## Server Setup

- Express serves the API and WebSocket endpoint.
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

- [`src/server/index.ts`](src/server/index.ts) &mdash; HTTP + WebSocket server
- [`src/server/session-store.ts`](src/server/session-store.ts) &mdash; In-memory session state and sync application
- [`src/client/CollaborativeCreator.tsx`](src/client/CollaborativeCreator.tsx) &mdash; Survey Creator embedding and session handling
- [`src/client/collab-client.ts`](src/client/collab-client.ts) &mdash; Client-side sync logic

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
