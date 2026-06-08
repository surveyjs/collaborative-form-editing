// Wire-protocol envelope types shared by client and server.
//
// The payload itself (`ISyncMessage`) is the format produced by the
// `UndoRedoSyncPlugin`'s `onSerializedChanges` and consumed by its
// `applySerialized()`. We re-export it from the plugin package so the wire
// format always tracks the canonical definition.

export type { ISyncMessage, ISyncAction, ISyncStackSnapshot } from "@collab/creator-undo-redo-sync";
import type { ISyncMessage, ISyncStackSnapshot } from "@collab/creator-undo-redo-sync";

// ---------------------------------------------------------------------------
// WebSocket envelopes

/** client -> server: a local transaction to broadcast. */
export interface ISyncEnvelope {
    type: "sync";
    message: ISyncMessage;
}

/**
 * Full session state used to bootstrap a freshly joined client: the current
 * survey schema plus the shared undo/redo stack. `stack` is always present —
 * for a session with no history `exportStack()` still yields an empty
 * snapshot (`{ kind: "stack", cursor: 0, entries: [] }`), never null.
 */
export interface ISessionSnapshot {
    schema: any;
    stack: ISyncStackSnapshot;
}

/** server -> client: initial state for a freshly joined client. */
export interface IInitEnvelope extends ISessionSnapshot {
    type: "init";
    clientId: string;
}

/** server -> client: a sync from another peer (server tags it with `from`). */
export interface IRelayEnvelope {
    type: "sync";
    from: string;
    message: ISyncMessage;
}

export type IClientToServer = ISyncEnvelope;
export type IServerToClient = IInitEnvelope | IRelayEnvelope;

// ---------------------------------------------------------------------------
// HTTP

export interface ICreateSessionRequest {
    schema?: any;
}
export interface ICreateSessionResponse {
    sessionId: string;
}
