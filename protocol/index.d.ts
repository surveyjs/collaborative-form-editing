// Wire-protocol envelope types shared by client and server.
//
// The payload itself (`ISyncMessage`) is the format produced by
// survey-creator-core's `UndoRedoManager.onSerializedChanges` and consumed
// by `applySerialized()`. We re-export it from survey-creator-core so the
// wire format always tracks the canonical definition.

export type { ISyncMessage, ISyncAction } from "survey-creator-core";
import type { ISyncMessage } from "survey-creator-core";

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
