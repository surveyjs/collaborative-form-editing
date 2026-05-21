# survey-creator-collaboration

Collaborative editing service for SurveyJS Creator.

A small WebSocket service plus a React-based client that embeds
[SurveyJS Creator](../survey-creator) and synchronises every edit between
all connected clients by relaying the JSON sync messages produced by the
creator's `UndoRedoManager` (`onSerializedChanges` / `applySerialized`).

## Layout

```
packages/
  shared/   protocol envelope types shared by client & server
  server/   Node.js HTTP + WebSocket server (owns one SurveyModel per session)
  client/   React app embedding survey-creator-react
```

## Quick start

```bash
npm install
npm run dev
```

This starts the server on `http://localhost:8080` and the client on
`http://localhost:5173`. Open the client URL in two browser tabs:

1. In the first tab click **Create new session** — copy the `?session=...` URL.
2. Open it in the second tab (or share with someone). Edits in either tab
   appear live in the other.

## How sync works

* The client subscribes to `creator.undoRedoController.undoRedoManager.onSerializedChanges`.
  Every transaction (each property change, array splice, undo, redo) becomes
  one JSON `ISyncMessage` that is sent to the server.
* The server applies the message to its in-memory `SurveyModel` for the
  session (so late joiners get the up-to-date schema) and relays it to all
  other clients in the session.
* Each receiving client passes the message into `manager.applySerialized(message)`,
  which mutates the creator's `SurveyModel` while temporarily detaching the
  local change observer — so remote ops do not echo back.

## Notes

* `packages/server/src/undo-redo-serializer.ts` is a copy of
  [`survey-creator-core`'s serializer](../survey-creator/packages/survey-creator-core/src/plugins/undo-redo/undo-redo-serializer.ts).
  Keep it in sync if the upstream protocol evolves.
* The `survey-core` and `survey-creator-core` packages are consumed via
  local `file:` references pointing at the sibling `survey-library` and
  `survey-creator` checkouts — those need to be built first
  (`npm run build` in each).
* MVP only: in-memory sessions, no auth, no persistence, no presence.
