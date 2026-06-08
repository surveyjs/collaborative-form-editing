// Wire-protocol envelope types shared by client and server.
//
// The payload itself (`ISyncMessage`) is the format produced by the
// `UndoRedoSyncPlugin`'s `onSerializedChanges` and consumed by its
// `applySerialized()`. We re-export it from the plugin package so the wire
// format always tracks the canonical definition.

export type { ISyncMessage, ISyncAction } from "@collab/creator-undo-redo-sync";
import type { ISyncMessage } from "@collab/creator-undo-redo-sync";

// ---------------------------------------------------------------------------
// WebSocket envelopes

/** client -> server: a local transaction to broadcast. */
export interface ISyncEnvelope {
    type: "sync";
    message: ISyncMessage;
}

/** server -> client: initial state for a freshly joined client. */
export interface IInitEnvelope {
    type: "init";
    clientId: string;
    schema: any;
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
